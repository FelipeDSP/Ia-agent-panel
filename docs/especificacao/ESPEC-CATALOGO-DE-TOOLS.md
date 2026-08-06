# Especificação — Catálogo de Tools Multi-Tenant

> **Para o agente que for implementar:** este documento descreve uma mudança de
> arquitetura já decidida e parcialmente aplicada no n8n. Sua tarefa é (1) **validar**
> as premissas contra o banco real antes de escrever qualquer coisa, (2) fechar as
> lacunas de segurança listadas na §4, e (3) implementar o suporte no painel.
>
> Leia `ESPECIFICACAO.md`, `ADENDO_ESTADO_ATUAL.md` e `CLAUDE.md` antes. As regras de
> multi-tenancy do `CLAUDE.md` valem integralmente aqui — em especial a regra 1
> (`tenant_id` vem do JWT) e a regra 2 (RLS em toda tabela com tenant).
>
> **Existe cliente em produção** (Acqua Lavanderia, `chatwoot_account_id = 56`). Toda
> alteração precisa mantê-lo funcionando.

---

## 1. O problema que isto resolve

O workflow de atendimento no n8n tinha as ferramentas do agente como **nós fixos no
canvas**. Consequência: vender um módulo novo (agendamento, consulta a pedido, agente
comercial) para um cliente exigia editar o workflow que atende **todos** os clientes.
Não escala e é o caminho mais curto para um incidente em produção.

O banco já modelava a solução — `tenant_tools` e `api_n8n_tools_ativas` existem desde a
migração 09 — mas o runtime não consumia isso.

**Objetivo:** número de workflows no n8n = número de **tools**, nunca número de
**contas**. Adicionar uma capacidade nova deve ser: criar um sub-workflow + inserir uma
linha em `tenant_tools`. Zero edição no fluxo compartilhado.

---

## 2. O que já mudou no n8n (contexto, não precisa implementar)

Aplicado via patch no workflow de atendimento:

**Fluxo principal**, entre `Limpa Acumulo` e `AI Agent`, dois nós novos:

- **`Tools Ativas`** (Postgres) —
  `SELECT COALESCE(json_agg(t.*), '[]'::json) AS tools FROM public.api_n8n_tools_ativas($1::uuid) t;`
  O `json_agg` é obrigatório: sem ele o nó Postgres emite um item por linha e todo o
  fluxo abaixo rodaria N vezes.
- **`Monta System Prompt`** (Code) — monta o system message dinamicamente a partir das
  tools ativas e produz `system_message` + `descricao_despachante`.

**Nó de tool novo, `Executar Acao`** (`toolWorkflow`), com `description` vinda de
`descricao_despachante` e inputs `tenant_id`, `conversation_id`, `account_id` (do
fluxo) + `acao`, `argumentos` (do `$fromAI`).

**Sub-workflow novo, `Tool - Despachante de Acoes`** — recebe a chamada, relê
`api_n8n_tools_ativas(tenant_id)`, procura a `acao` na lista; se achar, chama o
`workflow_id` daquela linha passando o `config`; se não achar, devolve recusa.

**Duas tools continuam como nós dedicados:** `busca_conhecimento` e `transferir_humano`.
São carcaça (estão em todo plano) e a busca na KB é o caminho crítico — nós dedicados
preservam a precisão de tool-calling. O despachante cuida só do catálogo modular.

**O wrapper duplicado acabou.** O `system_message` passa a ser montado uma vez e lido
tanto pelo `AI Agent` quanto pelo `Estima Tokens`. O comentário
`>>> MANTENHA EM SINCRONIA` no código de estimativa deixou de existir.

### O modelo de autorização em duas camadas

| Camada | Onde | O que garante |
|---|---|---|
| **Visibilidade** | `Tools Ativas` no fluxo principal | O modelo nunca sabe que uma ação não contratada existe — não a promete ao cliente |
| **Execução** | Despachante, antes de rotear | Mesmo se o modelo inventar o nome, a ação não roda |

`api_n8n_tools_ativas` só devolve linhas ativas, então **autorização e roteamento saem
da mesma consulta**: não existe caminho em que o roteamento funcione sem a autorização
ter passado. Preserve essa propriedade em qualquer refatoração.

**Autorização nunca é decisão do modelo.** É estado no banco. `tenant_id` vem sempre do
fluxo, nunca do `$fromAI` — se viesse, o texto do cliente final poderia influenciar qual
conta é validada.

---

## 3. Validar primeiro (não assuma nada abaixo)

Antes de escrever migração, confirme contra o banco real e **relate as divergências**:

1. **Colunas reais de `tenant_tools`.** O adendo diz 8 colunas e 5 registros. Confirme
   nomes, tipos, defaults, constraints. Existe `UNIQUE (tenant_id, tool_nome)`?
2. **Policy RLS de `tenant_tools`.** Qual é exatamente? Se seguir o padrão
   `FOR ALL USING (auth_is_super_admin() OR tenant_id = auth_tenant_id())`, então
   **temos um problema sério — ver §4.1.**
3. **Corpo atual de `api_n8n_tools_ativas`.** Confirme a assinatura e o filtro.
4. **As 5 linhas existentes em `tenant_tools`.** Quais tenants, quais `tool_nome`,
   quais `workflow_id`, quais `config`. Se algum `workflow_id` estiver nulo ou apontando
   para workflow inexistente, o despachante ignora a tool em silêncio.
5. **Se existe trigger de guard em `tenant_tools`** análogo a `tenants_guard_colunas`
   (migração 13). Provavelmente não existe.
6. **Se a Acqua tem linha de `busca_conhecimento`** em `tenant_tools`. O fluxo hoje não
   depende disso (é nó dedicado), mas a resposta muda o que o painel deve exibir.

---

## 4. Lacunas a fechar no banco

### 4.1 O cliente pode se auto-conceder um módulo (crítico)

Se a policy de `tenant_tools` for `FOR ALL` com `tenant_id = auth_tenant_id()`, um
`tenant_admin` autenticado consegue, via PostgREST com o token dele:

- `UPDATE tenant_tools SET ativo = true` numa linha desativada;
- `INSERT` uma linha nova com qualquer `tool_nome` e `workflow_id`.

Ou seja: **a fronteira comercial do produto está editável pelo cliente.** Isso não é
hipotético — é o mesmo tipo de furo que a migração 13 fechou para `tenants`, e a mesma
lição: o painel não é a única porta, a API do PostgREST também é.

Corrija com a mesma técnica já usada no projeto:

- Policies separadas por comando: `tenant_admin` recebe `SELECT` e `UPDATE`, **nunca**
  `INSERT` nem `DELETE`. `super_admin` mantém `FOR ALL`.
- Trigger de guard espelhando `tenants_guard_colunas`: `tenant_admin` só altera colunas
  da whitelist (`ativo`, `config`); `tool_nome`, `workflow_id`, `descricao` e
  `contratado` são bloqueados.

**Atenção à armadilha já documentada no adendo §5:** `tenants_guard_colunas` lê
`auth_is_super_admin()`, que vem do JWT — e `service_role`/`postgres` não têm claim
`papel`, então o guard barra manutenção por esses caminhos. Replique o mesmo cuidado e
documente o `set_config('request.jwt.claims', ...)` necessário para scripts.

### 4.2 Separar "contratado" de "ligado"

Hoje `ativo` acumula dois significados. Separe:

- **`contratado`** — decisão comercial. Só `super_admin` altera. É o que a Ordem de
  Serviço do contrato reflete.
- **`ativo`** — decisão operacional. O cliente pode desligar temporariamente um módulo
  que contratou.

`api_n8n_tools_ativas` passa a filtrar `contratado AND ativo`. Cliente que desligou não
paga menos; cliente que não contratou não vê.

### 4.3 Catálogo global de tools

Hoje cada linha de `tenant_tools` repete `descricao` e `workflow_id` em texto livre.
Com 20 clientes isso diverge: mesma tool com descrições diferentes, e um `workflow_id`
digitado errado vira tool que o despachante ignora sem erro.

Crie uma tabela de catálogo (sem `tenant_id`, só `super_admin`) com: `tool_nome` (PK
lógica), `nome_exibicao`, `descricao_padrao`, `workflow_id_padrao`,
`schema_config` (jsonb descrevendo os campos que o cliente configura), `ativo`.

`tenant_tools` passa a referenciar o catálogo, com `descricao` e `workflow_id` como
**override opcional** (nulo = usa o padrão). Provisionar um módulo vira um checkbox, não
digitação.

`api_n8n_tools_ativas` faz o `COALESCE` do override com o padrão e continua devolvendo
as mesmas quatro colunas — **não mude a assinatura**, o n8n em produção depende dela.

### 4.4 Registrar recusas

O despachante já produz `_acao_tentada` e `_tenant_id` no ramo de recusa. Uma tabela
simples (`tenant_id`, `tool_nome`, `criado_em`) mais uma função
`api_n8n_registrar_tool_negada(p_tenant_id uuid, p_tool_nome text)` fecha o ciclo.

Valor real: "o cliente X tentou agendar 40 vezes este mês" é o sinal de upsell mais
qualificado que existe — o cliente final está pedindo o módulo em voz alta.

### 4.5 Convenções obrigatórias

- Migração com `_rollback.sql` correspondente (padrão do projeto).
- RLS ativo e policy na **mesma** migração que cria a tabela.
- `tenant_id` como primeira coluna de índice composto.
- Nomes de tabela e coluna em português; `TIMESTAMPTZ` sempre.
- Nada de alterar a assinatura das funções `api_n8n_*` — quebra o agente em produção.

---

## 5. O que construir no painel

### 5.1 Generalizar o padrão que já existe

`src/lib/tools/transferir-humano.ts` já resolve o problema para uma tool: tipos do
`config`, corte de responsabilidade entre agência e cliente, merge do jsonb preservando
os campos do outro lado. **Esse arquivo é o modelo.** Extraia dele um registry:

```
src/lib/tools/
├── tipos.ts        # ConfigTool, DefinicaoTool, corte agência/cliente
├── registro.ts     # mapa tool_nome -> definição + componente de formulário
├── transferir-humano.ts   # migrado para o novo formato
└── <nova-tool>.ts
```

O corte de responsabilidade de `transferir-humano.ts` deve virar regra geral: cada tool
declara quais chaves do `config` são do cliente e quais são da agência, e cada lado
preserva as do outro ao salvar.

### 5.2 Telas

**Super admin — catálogo global.** CRUD do catálogo: `tool_nome`, descrição padrão,
`workflow_id` padrão, schema de config.

**Super admin — módulos do tenant.** Na página do tenant, marcar `contratado` por tool,
com override opcional de `workflow_id` e `descricao`. É aqui que a Ordem de Serviço do
contrato vira estado do sistema.

**Cliente — meus módulos.** Lista dos módulos contratados, com toggle `ativo` e o
formulário de `config` de cada um, renderizado a partir do registry. Módulo não
contratado **não aparece** — nem cinza, nem com selo "faça upgrade". Se quiser vender
upgrade, é decisão de produto separada; o default é não expor a estrutura de planos.

### 5.3 Regras que valem para todas as telas

- `tenant_id` do JWT. Nunca do request. Nem em Server Action, nem em rota.
- `super_admin` verificado no servidor antes de qualquer escrita de `contratado`.
- Validação do `config` contra o `schema_config` **no servidor**, antes de gravar. O
  formulário é conveniência; o servidor é a garantia.
- Nunca exponha o custo em USD ao `tenant_admin` (regra já vigente em billing).

---

## 6. Ordem de execução sugerida

1. **Auditoria.** Rodar a §3 e relatar divergências. Não escrever código antes disso.
2. **Migração de segurança** (§4.1) — é a mais urgente; fecha um furo aberto hoje.
3. **Migração de catálogo** (§4.2, §4.3, §4.4), com rollback e seed das tools atuais.
4. **Registry no painel** (§5.1), migrando `transferir_humano` para ele sem mudar
   comportamento.
5. **Telas** (§5.2).
6. **Primeira tool nova de ponta a ponta** — é o teste real da arquitetura. Se exigir
   tocar no fluxo principal do n8n ou no registry, o desenho está errado.

---

## 7. Critérios de conclusão

- [ ] `tenant_admin` autenticado **não consegue**, por PostgREST direto, ligar módulo não
      contratado nem inserir linha em `tenant_tools`. Provado em teste, no estilo de
      `tests/restricao-coluna-fase3.mjs`.
- [ ] Teste de isolamento com os 3 tenants do seed passa para as tabelas novas.
- [ ] `api_n8n_tools_ativas` mantém assinatura e o agente da Acqua responde igual —
      teste de recall da KB continua passando.
- [ ] Tenant sem módulo modular: agente se comporta exatamente como antes do patch.
- [ ] Tenant com módulo: agente executa a ação; ação de outro tenant é recusada e o
      agente **não menciona** o recurso ao cliente final.
- [ ] Provisionar um módulo novo para um cliente não exige SQL manual nem edição do
      workflow principal.
- [ ] `npm run build` sem erro de tipo; migrações com rollback escrito.

---

## 8. Nota sobre o billing

O `Estima Tokens` passou a somar o custo do schema do despachante, que varia com o
número de módulos do tenant. Continua sendo **estimativa** — a memória do Redis e os
turnos de tool call seguem subcontados, e turnos com ferramenta são justamente os mais
caros.

Isso não bloqueia nada agora, mas registre: quanto mais módulos o catálogo tiver, maior
a divergência entre o estimado e o faturado pela OpenAI. Duas saídas quando incomodar —
reconciliar via API de execuções do n8n (o `tokenUsageEstimate` existe no output do
sub-nó do modelo), ou tirar o loop do agente do n8n. Não é decisão para agora.
