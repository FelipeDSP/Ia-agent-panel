# Adendo à Especificação — Estado Real do Banco

> Este documento **substitui** as seções §5.2 e §5.4 da `ESPECIFICACAO.md`, que
> descrevem decisões já tomadas de forma diferente do que acabou sendo implementado.
> Onde houver conflito, este adendo prevalece.

Data: 24/07/2026

---

## 1. O que mudou em relação à especificação original

### §5.2 — não houve migração in-place

A especificação descrevia 6 passos para converter `tenants.id` de BIGINT para UUID
numa tabela viva. **Isso não foi necessário.** A produção estava em outro Postgres
(Coolify), então o que houve foi uma carga única para um schema novo onde o UUID
já nasceu pronto.

Consequência: o banco de produção antigo nunca foi alterado. Continua íntegro como
rollback.

### §5.4 — decidido pela Opção C

A especificação deixava em aberto como o n8n acessaria o banco, com duas opções
(`service_role` ou `SET app.tenant_id`). **Ambas foram descartadas** e implementada
uma terceira:

- Role dedicado `n8n_agent`: LOGIN, NOBYPASSRLS, **sem privilégio direto em
  nenhuma tabela**
- Acesso exclusivamente por funções `api_n8n_*`, todas `SECURITY DEFINER` com
  `p_tenant_id` obrigatório na assinatura
- O filtro de tenant não pode ser esquecido porque é parâmetro da função

O fallback `app.tenant_id` que existia em `auth_tenant_id()` foi **removido** na
migração 10. Hoje só o JWT autoriza no painel.

---

## 2. Estado do banco

Projeto Supabase: `SEU_PROJETO` (região `sa-east-1`)
Postgres 17.6, pgvector 0.8.2 (schema `extensions`)

### Tabelas (12 migrações aplicadas, todas com RLS ativo)

| Tabela | Colunas | Conteúdo atual |
|---|---|---|
| `tenants` | 17 | 4 registros |
| `usuarios_painel` | 8 | 1 super admin (criado na Fase 2) |
| `kb_documentos` | 9 | 18 chunks (12 reais + 6 de seed) |
| `jobs_ingestao` | 12 | 0 |
| `conversas` | 9 | 67 |
| `tenant_tools` | 8 | 5 |
| `prompt_versoes` | 5 | 0 |
| `mensagens_log` | 9 | 1 |

### Tenants cadastrados

| slug | chatwoot_account_id | Observação |
|---|---|---|
| `acqua-lavanderia` | 56 | **Cliente real em produção.** 12 documentos, 66 conversas |
| `sandbox` | 1 | Ambiente de testes. **0 documentos**, 1 conversa |
| `clinica-teste` | NULL | Seed de isolamento. 3 documentos com vetores sintéticos |
| `restaurante-teste` | NULL | Idem |

> Corrigido em 24/07/2026: este documento afirmava que o `sandbox` tinha 12
> documentos com `origem = 'copia_teste'`. Ele tem zero, e essa origem não
> existe em nenhuma linha do banco. Conferido contra o painel e contra
> `kb_documentos`.

**Limpeza pendente:** os documentos com `origem = 'seed'` são lixo de teste.
Apagar quando o painel estiver funcional — mas note que isso deixa
`clinica-teste` e `restaurante-teste` sem documento nenhum, e o teste de
isolamento perde os pares que hoje têm dado dos dois lados:
```sql
DELETE FROM kb_documentos WHERE origem = 'seed';
```

---

## 3. Funções de autorização

```sql
jwt_claims()          -- claims do JWT como jsonb, nunca lança erro de parse
auth_tenant_id()      -- UUID do tenant, extraído de app_metadata.tenant_id
auth_is_super_admin() -- TRUE quando app_metadata.papel = 'super_admin'
```

O `tenant_id` e o `papel` precisam estar em **`app_metadata`** do JWT, não em
`user_metadata`. O segundo é editável pelo próprio usuário e não serve para
autorização.

### Padrão de policy usado em todas as tabelas

```sql
CREATE POLICY p_x ON tabela
  FOR ALL
  USING (auth_is_super_admin() OR tenant_id = auth_tenant_id())
  WITH CHECK (auth_is_super_admin() OR tenant_id = auth_tenant_id());
```

### Trigger de sincronização

`auth.users` → `usuarios_painel` via `handle_novo_usuario()`. Lê `papel` e
`tenant_id` do `raw_app_meta_data`.

Desde a **migração 12** roda em dois momentos:

| Gatilho | Comportamento |
|---|---|
| `AFTER INSERT` | sem `papel`, não faz nada — é o `INSERT` do GoTrue, que ainda vai gravar o metadata |
| `AFTER UPDATE OF raw_app_meta_data` | com `papel`, cria ou atualiza o vínculo (upsert) |

**Levanta exceção** se `papel = 'tenant_admin'` sem `tenant_id`, agora no momento em
que o metadata chega. Falha visível continua sendo melhor que usuário órfão, e como o
`UPDATE` do GoTrue está na mesma transação do `INSERT`, não há janela intermediária.

Efeito colateral desejado: mudança de papel ou de tenant passa a sincronizar sozinha.
Antes o `UPDATE` não era espelhado e a tabela divergia do JWT.

**`app_metadata` é a fonte da verdade; `usuarios_painel` é projeção.** As policies
leem o JWT, não a tabela. Toda escrita de papel ou tenant passa pela Admin API
primeiro. Alterar a tabela direto não muda autorização nenhuma.

---

## 4. API do n8n (não mexer sem cuidado)

Sete funções consumidas pelo n8n em produção. Alterar assinatura quebra o agente
da lavanderia.

```
api_n8n_tenant_por_chatwoot(p_account_id bigint)
  -> tenant_id, slug, nome, agente_ativo, system_prompt, modelo,
     temperatura, debounce_segundos, msg_midia_nao_suportada,
     msg_fora_escopo, chatwoot_url

api_n8n_credencial_chatwoot(p_tenant_id uuid)
  -> chatwoot_url, chatwoot_token, chatwoot_account_id

api_n8n_config_tool(p_tenant_id uuid, p_tool_nome text)
  -> chatwoot_url, chatwoot_token, tool_ativa, config

api_n8n_buscar_kb(p_tenant_id uuid, p_embedding vector(1536),
                  p_limite int = 5, p_filtro jsonb = '{}')
  -> id, text, metadata, similarity

api_n8n_conversa_sync(p_tenant_id uuid, p_conversation_id bigint,
                      p_contact_name text, p_phone text)
  -> status, pausado_em

api_n8n_definir_status_conversa(p_tenant_id uuid, p_conversation_id bigint,
                                p_status text) -> text

api_n8n_registrar_mensagem(p_tenant_id uuid, p_conversation_id bigint,
                           p_direcao text, ...) -> uuid

api_n8n_tools_ativas(p_tenant_id uuid)
  -> tool_nome, workflow_id, descricao, config
```

Todas chamam `n8n_assert_tenant(p_tenant_id)` no corpo, que valida se o tenant
existe, está ativo e não foi deletado.

---

## 5. Armadilhas conhecidas

Descobertas durante a implementação. Cada uma custou tempo.

**`request.jwt.claims` vazio.** `current_setting('request.jwt.claims', true)`
retorna string vazia, não NULL, quando não há JWT. O cast direto para `jsonb`
lança "invalid input syntax for type json". Por isso existe `jwt_claims()` com
`NULLIF` antes do cast. Qualquer função nova que leia claims deve usar esse helper.

**`NUMERIC` chega como string no n8n.** `tenants.temperatura` é `NUMERIC(3,2)` e o
driver Postgres entrega `"0.30"`. A OpenAI rejeita. Precisa de `Number()` no n8n.
O mesmo vale para qualquer `NUMERIC` que o painel envie a uma API externa.

**`metadata->>'tenant_id'` precisa acompanhar a coluna.** O node PGVector do n8n
filtrava por metadata, não por coluna. Se o metadata dessincronizar do `tenant_id`,
a busca retorna zero linhas **sem erro** — o agente responde sem base de conhecimento
e ninguém percebe. Qualquer inserção em `kb_documentos` deve gravar `tenant_id` nos
dois lugares.

**Superusuário ignora RLS.** Testes de isolamento rodados como `postgres` passam
enganosamente. Precisam rodar como `authenticated` (com JWT simulado) ou `n8n_agent`.

**`SET ROLE` não funciona dentro de `SECURITY DEFINER`.** Testes que usam `SET LOCAL
ROLE` precisam estar em função `SECURITY INVOKER` ou em bloco anônimo.

**`api_n8n_buscar_kb` não filtra por similaridade mínima.** Sempre devolve os N mais
próximos, mesmo irrelevantes. Um vetor aleatório retorna 5 documentos com similaridade
negativa. Se o painel expuser busca ao usuário, considerar um corte — mas calibrar o
limiar com perguntas reais antes de fixar número.

**O GoTrue grava o `app_metadata` DEPOIS de inserir o usuário.** `admin.createUser`
não põe o `app_metadata` no `INSERT`: ele insere com
`{"provider":"email","providers":["email"]}` e roda um `UPDATE` em seguida, na mesma
transação. Um trigger `AFTER INSERT` que exija `papel` dispara no meio desse par e
derruba a criação inteira com `500: Database error creating new user`.

Foi o que aconteceu na Fase 2: nenhum usuário podia ser criado por nenhum caminho —
nem `createUser`, nem `inviteUserByEmail`, nem o "Add user" do painel do Supabase.
Corrigido na **migração 12**, que faz o trigger rodar também em
`UPDATE OF raw_app_meta_data`.

Cuidado ao testar isto: `INSERT` direto em `auth.users` via SQL **não reproduz** o
problema, porque o SQL manual grava o metadata junto — exatamente o que o GoTrue não
faz. Só a chamada HTTP real da Admin API exercita o caminho verdadeiro.

**`inviteUserByEmail` não aceita `app_metadata`.** A assinatura é
`(email, { data, redirectTo })`, e `data` alimenta `user_metadata` — que é editável
pelo próprio usuário e não serve para autorização. O mesmo vale para
`generateLink({type:'invite'})`. Para gravar papel e tenant use `createUser` com
`app_metadata`, e depois `generateLink({type:'recovery'})` para o usuário definir a
senha.

**`listUsers` é eventualmente consistente.** Usuário recém-criado não aparece na
listagem por alguns segundos — há um *index worker* alimentando a busca. Observado:
`createUser` devolveu sucesso, `SELECT` em `auth.users` mostrou a linha, e `listUsers`
no instante seguinte devolveu zero, sem erro. Consequência: script que cria e depois
procura pelo email não encontra, e limpeza baseada em listagem não remove nada e não
avisa. Guarde o `id` devolvido por `createUser` e remova por `id`; para saber se um
email já existe, tente criar e trate o conflito.

**A Admin API falha ~5% das chamadas com a chave `sb_secret_`.** Medido: 20 chamadas
idênticas de `listUsers` → 19 ok, 1 erro:

```
invalid JWT: unable to parse or verify signature, token is unverifiable:
error while executing keyfunc: unrecognized JWT kid <nil> for algorithm ES256
```

A mesma chave que acabou de criar um usuário falha ao removê-lo e volta a funcionar em
seguida. É intermitência do lado do Supabase na verificação da chave nos endpoints de
auth — não há nada a corrigir na credencial, e a mensagem engana porque parece
credencial errada. `scripts/lib/usuarios.mjs` repete a chamada nesse erro específico.

**Branching exige plano Pro.** `create_branch` responde `PaymentRequiredException` no
Free. Alternativa sem custo para ensaiar migração: `BEGIN`, aplicar a migração,
exercitar, e `RAISE EXCEPTION` no fim para abortar — DDL no Postgres é transacional,
então função e trigger voltam ao estado anterior. Não cobre o que acontece fora da
transação (chamada HTTP ao GoTrue, por exemplo).

**`devIndicators` no `next.config.ts` quebra o `next start`.** No Next 15.5.21,
declarar `devIndicators: { position: '...' }` faz o servidor de produção lançar
`TypeError: a[d] is not a function` no webpack-runtime em TODA rota — o build passa,
mas `next start` 500a globalmente. Some em dev. Descoberto na Fase 3; a config foi
removida. O indicador de dev só aparece em `next dev` mesmo, então não vale o risco.

**`<Link><Button>` quebra a hidratação em produção.** Um `<button>` dentro de `<a>`
é aninhamento inválido; o React 19 lança exceção de client na hidratação de produção
(em dev só avisa) — a página inteira vira "Application error: a client-side exception".
Para um link com cara de botão, aplique `buttonVariants()` como `className` no próprio
`<Link>`, sem aninhar.

**O guard de coluna (trigger 13) bloqueia o service_role.** `tenants_guard_colunas`
lê `auth_is_super_admin()`, que vem do JWT. O admin client (service_role) e o
`postgres` não têm claim `papel`, então a função retorna false e o guard barra
qualquer UPDATE de coluna protegida por esses caminhos — inclusive `deletado_em`
(soft-delete), que não está na whitelist. No app não é problema: edições de
super_admin passam pelo server client com o JWT dele. Mas script ou manutenção via
service_role precisa setar o claim antes:
```sql
select set_config('request.jwt.claims',
  '{"app_metadata":{"papel":"super_admin"}}', true);
```

---

## 6. Conexão

**Painel (Next.js):** cliente Supabase normal, `@supabase/ssr`.

**n8n:** node Postgres apontando para o pooler.

```
Host:     aws-0-sa-east-1.pooler.supabase.com
Port:     6543  (transaction mode)
Database: postgres
User:     n8n_agent.SEU_PROJETO
SSL:      require
```

Dois detalhes que causam erro sem mensagem clara:

- `db.<ref>.supabase.co` é **IPv6-only**. Cliente IPv4 dá timeout genérico.
  Sempre usar o pooler.
- No pooler o usuário é `<role>.<project_ref>`. Só `n8n_agent` falha na
  autenticação.
