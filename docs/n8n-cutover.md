# Cutover do n8n — do Coolify para o Supabase

Como o workflow da Acqua Lavanderia passa a falar com o banco novo.

Decisão registrada: **Opção C da seção 5.4**. O n8n não acessa tabela nenhuma.
Acessa o role `n8n_agent`, que só tem `EXECUTE` nas funções `api_n8n_*`, e o
tenant é parâmetro obrigatório de cada assinatura.

---

## 1. Credencial

### Senha do role

A migração 09 cria `n8n_agent` sem senha, de propósito — senha em migração vai
para o git. Defina fora:

```sql
alter role n8n_agent password '<segredo>';
```

### Host

**Não use `db.SEU_PROJETO.supabase.co:5432` direto.** Em projetos novos
esse host é IPv6-only. O n8n roda no Coolify em `SEU_HOST_POSTGRES`, que é IPv4 — a
conexão simplesmente não estabelece, e o erro no n8n aparece como timeout
genérico, difícil de diagnosticar.

Use o **Supavisor** (pooler), que é IPv4. Pegue a string exata no painel do
Supabase em *Connect → Session pooler* e troque o usuário `postgres` por
`n8n_agent`. O formato do usuário no pooler é `<role>.<project_ref>`:

```
Host:     aws-0-sa-east-1.pooler.supabase.com
Porta:    5432        (session mode)  ou  6543 (transaction mode)
Usuário:  n8n_agent.SEU_PROJETO
Senha:    <segredo>
Banco:    postgres
SSL:      require
```

> Confirme host e porta no painel antes de salvar — o hostname do pooler varia
> por região e por geração do projeto. Só o usuário é que você monta na mão.

**A porta 6543 (transaction mode) serve.** Essa é uma vantagem concreta da
Opção C sobre a B: como não existe estado de sessão a preservar — o tenant vai
como argumento, não como `set_config` — o pooler pode reciclar a conexão entre
queries sem quebrar nada.

### Teste antes de mexer no workflow

Node Postgres avulso:

```sql
select * from api_n8n_tenant_por_chatwoot(56);
```

Deve voltar uma linha com o `tenant_id` da Acqua. Se voltar
`permission denied`, a senha ou o usuário estão errados. Se voltar vazio, o
tenant não tem `chatwoot_account_id = 56` ou está inativo.

---

## 2. Nó de entrada — resolver o tenant

O webhook do Chatwoot entrega `account_id`, não UUID. Antes o workflow usava
`56` cravado; agora resolve.

Primeiro node depois do webhook, **Postgres → Execute Query**:

```sql
select * from api_n8n_tenant_por_chatwoot($1);
```

Parâmetro: `{{ $json.body.account.id }}`

Saída: `tenant_id`, `system_prompt`, `modelo`, `temperatura`,
`debounce_segundos`, `agente_ativo`, as mensagens de sistema e `chatwoot_url`.

Se não vier linha, o tenant está suspenso ou não existe — encerre o fluxo sem
responder. Um `IF` logo depois checando `agente_ativo` cobre o botão de
liga/desliga do painel.

O `tenant_id` desse node passa a ser referenciado por todos os seguintes:
`{{ $('Resolver tenant').item.json.tenant_id }}`.

**O token do Chatwoot não vem aqui.** A config do agente é lida a cada
mensagem e o n8n loga a saída de cada node — o token ficaria no log de toda
execução. Busque-o só no node que responde ao Chatwoot:

```sql
select * from api_n8n_credencial_chatwoot($1);
```

---

## 3. Busca vetorial — substituir o node PGVector

Esta é a mudança que exige mais trabalho. O node PGVector do LangChain abre
conexão própria e monta o SQL por conta dele: não dá para escopá-lo por tenant
de fora, e é por isso que a Opção B (`set_config` num node anterior) não
funciona — o `SET` nunca alcança a conexão que faz a query.

O PGVector fazia duas coisas num node só: gerar o embedding da pergunta e
buscar. Agora são duas.

### 3.1 Gerar o embedding

**HTTP Request** para a OpenAI:

```
POST https://api.openai.com/v1/embeddings
Authorization: Bearer {{ $credentials.openAiApi.apiKey }}

{
  "model": "text-embedding-3-small",
  "input": "={{ $json.pergunta }}"
}
```

O modelo tem que ser `text-embedding-3-small`. Trocar o modelo muda o espaço
vetorial e a busca passa a devolver resultado ruim sem erro nenhum — os 1536
números continuam sendo 1536 números.

O vetor sai em `data[0].embedding` como array JSON.

### 3.2 Buscar

**Postgres → Execute Query**:

```sql
select id, text, metadata, similarity
from api_n8n_buscar_kb($1::uuid, $2::vector, $3::int);
```

Parâmetros, nesta ordem:

| # | Valor |
|---|-------|
| 1 | `{{ $('Resolver tenant').item.json.tenant_id }}` |
| 2 | `{{ JSON.stringify($('Embedding').item.json.data[0].embedding) }}` |
| 3 | `5` |

`JSON.stringify` de um array produz `[0.1,0.2,...]`, que é exatamente o literal
que o pgvector espera. Sem isso o Postgres recebe `{0.1,0.2,...}` (literal de
array) e devolve
`invalid input syntax for type vector: Vector contents must start with "["`.

O quarto parâmetro (`p_filtro jsonb`) existe para compatibilidade com o filtro
de metadata que o workflow já passava. Ele é **aditivo**: intersecta com o
filtro por coluna, nunca substitui. Passar o `tenant_id` de outro cliente ali
devolve vazio, não devolve os documentos dele. Na prática pode ser omitido.

### 3.3 Se a busca era um tool do AI Agent

Se o PGVector estava pendurado no AI Agent como *retriever*, o substituto é um
**Tool Workflow**: um sub-workflow que recebe a pergunta, faz 3.1 e 3.2 e
devolve os trechos concatenados. O `tenant_id` entra como parâmetro do
sub-workflow — não deixe o sub-workflow resolver o tenant por conta própria,
senão volta a existir um caminho onde ele pode errar.

---

## 4. Conversas

No início de cada mensagem, um node só registra a conversa e devolve o estado:

```sql
select * from api_n8n_conversa_sync($1::uuid, $2::bigint, $3, $4);
```

Parâmetros: `tenant_id`, `{{ $json.body.conversation.id }}`, nome do contato,
telefone.

Devolve `status` e `pausado_em`. Um `IF` com `status = 'pausado'` encerra o
fluxo sem responder — é o botão de pausa do painel funcionando.

Para pausar/retomar a partir do próprio agente:

```sql
select api_n8n_definir_status_conversa($1::uuid, $2::bigint, $3);
```

## 5. Log de mensagens

Depois de responder:

```sql
select api_n8n_registrar_mensagem($1::uuid, $2::bigint, $3, $4, $5, $6, $7);
```

`tenant_id`, `conversation_id`, `'entrada'` ou `'saida'`, conteúdo,
`tokens_entrada`, `tokens_saida`, modelo.

## 6. Tools habilitadas

```sql
select * from api_n8n_tools_ativas($1::uuid);
```

---

## 7. Ordem do cutover

1. Rodar `node scripts/import-producao.mjs --dry-run` e conferir a saída
2. Rodar sem `--dry-run`; as verificações precisam passar todas
3. **Desativar o workflow no n8n** — daqui em diante o banco antigo para de
   receber escrita
4. Rodar o import de novo para pegar o delta (é idempotente: mesmos UUID v5,
   faz UPDATE, não duplica)
5. Trocar a credencial Postgres do workflow e aplicar as mudanças de node
6. Reativar e mandar uma mensagem real de teste no WhatsApp da Acqua
7. Conferir: resposta chegou, usou a base de conhecimento, `mensagens_log`
   registrou as duas direções

**Rollback**: reapontar a credencial do n8n para o Coolify e reverter os nodes.
O banco antigo não foi tocado em momento nenhum — o script abre a conexão de
origem como `read only`. Mantenha o Coolify de pé por ~14 dias antes de
desligar.

---

## 8. O que vigiar na primeira semana

O modo de falha mais provável não dá erro. Se a busca vetorial parar de casar,
o agente continua respondendo — só que sem base de conhecimento, com a cara de
sempre. Ninguém abre chamado.

Consulta para rodar diariamente:

```sql
select date_trunc('day', criado_em) as dia,
       count(*) filter (where direcao = 'entrada') as recebidas,
       count(*) filter (where direcao = 'saida')   as enviadas
from mensagens_log
where tenant_id = (select id from tenants where chatwoot_account_id = 56)
  and criado_em > now() - interval '7 days'
group by 1 order by 1;
```

Queda em `enviadas` sem queda em `recebidas` é o agente falhando em silêncio.
