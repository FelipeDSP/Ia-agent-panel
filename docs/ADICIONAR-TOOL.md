# Como adicionar uma tool nova

Guia prático para provisionar uma capacidade nova do agente (ex.: `agendar_horario`,
`registrar_pedido`) sem quebrar o que já existe. Leia junto de
[`especificacao/ESPEC-CATALOGO-DE-TOOLS.md`](especificacao/ESPEC-CATALOGO-DE-TOOLS.md).

## Modelo mental: dois lados

| Lado | Onde | O que faz |
|------|------|-----------|
| **Execução** | n8n | O que a tool realmente FAZ quando o agente a chama. |
| **Provisionamento** | Painel + Postgres | Quem VENDE/contrata a tool e qual a config por cliente. |

> ⚠️ **Estado atual (2026-08):** o workflow principal do n8n é **hardcoded** — ele
> NÃO lê `api_n8n_tools_ativas`/`tenant_tools`. As tools são nós `toolWorkflow`
> estáticos ligados ao AI Agent, e o system prompt é texto fixo. Consequência:
> `contratado/ativo` no painel é organização comercial, **não corta o agente**.
> Adicionar uma tool no principal a habilita para **todos os clientes** (workflow
> compartilhado), a menos que você ponha uma trava por `tool_ativa` no sub-workflow.
> O "endgame" que torna o painel a fonte da verdade está na última seção.

---

## Passo a passo

### Lado n8n (obrigatório — sem isto a tool não existe de fato)

1. **Criar o sub-workflow** `Tool - <Nome> (Multi-Tenant)`. Atalho: duplique um
   sub-workflow existente e troque o miolo. Estrutura mínima:
   ```
   Execute Workflow Trigger  →  Busca Config  →  <lógica da tool>  →  Retorno Sucesso
   ```
   - **Trigger**: inputs que a tool recebe. Sempre inclua `tenant_id`; adicione
     `conversation_id`/`account_id` se for mexer no Chatwoot.
   - **Busca Config** (Postgres): resolve a credencial do cliente:
     ```sql
     SELECT chatwoot_url, chatwoot_token, tool_ativa, config
     FROM public.api_n8n_config_tool($1::uuid, '<tool_nome>');
     ```
     com `queryReplacement = {{ $json.tenant_id }}`. `chatwoot_url` vem de
     `tenants`; `chatwoot_token` vem de `tenant_credenciais` (segregado na
     migração 16 — RLS não filtra coluna, e o token é credencial da agência);
     `tool_ativa`/`config` vêm de `tenant_tools` para aquele `<tool_nome>`.
     A tool nunca lê o token direto de tabela — só por esta função, que é
     `SECURITY DEFINER` e é o que dá acesso a `tenant_credenciais`.
   - **Retorno Sucesso** (Set): a string que volta pro agente descrevendo o resultado.

2. **Ligar no workflow principal** (`Agente Multi-Tenant (Supabase)`): adicione um nó
   `@n8n/n8n-nodes-langchain.toolWorkflow` conectado ao **AI Agent** (conector *Tool*),
   apontando pro sub-workflow. Preencha:
   - **Description**: o texto que o MODELO lê pra decidir quando chamar. É o sinal
     mais importante — não deixe vazio.
   - **Inputs**: mapeados do FLUXO, nunca do `$fromAI`:
     - `tenant_id` → `={{ $('Resolve Tenant').item.json.tenant_id }}`
     - `conversation_id` → `={{ $('Extrair e Filtrar').item.json.conversation_id }}`
     - `account_id` → `={{ $('Extrair e Filtrar').item.json.chatwoot_account_id }}`

3. **Adicionar a seção no system prompt** do AI Agent, junto das outras:
   ```
   ## Ferramenta: <tool_nome>
   Use quando ... (quando chamar, quando NÃO chamar).
   ```

### Lado painel + banco (controle comercial)

4. **Catálogo** — Admin → Catálogo → *Nova tool*. O `tool_nome` tem que bater
   **exatamente** o string usado no n8n (passos 1–3). Esse é o elo entre os dois lados.

5. **Contratar por cliente** — Admin → cliente → *Módulos* → Contratar.

6. **Config editável pelo cliente** (opcional) — se a tool tiver campos que o cliente
   ajusta, cadastre em `src/lib/tools/registro.ts` (o registry é a fonte de UI; o
   cliente não lê o catálogo). Aí ela aparece em *Meus módulos*.

---

## Regras que não podem ser violadas

- **`tenant_id` sempre do fluxo/JWT, nunca do `$fromAI`/request.** IDs de conversa
  idem (do `Extrair e Filtrar`). Violar isso vaza dados entre clientes.
- **`tool_nome` idêntico** entre catálogo, `tenant_tools` e n8n.
- **Paridade com produção:** a Acqua roda no mesmo banco via n8n. Antes de mexer em
  `api_n8n_tools_ativas`/`api_n8n_config_tool`, garanta retorno idêntico ao anterior —
  o n8n consome por **nome de coluna**, então renomear campo de retorno quebra o
  sub-workflow sem erro no banco.
- **Dropar coluna não avisa quem depende dela.** Corpo de função plpgsql é texto
  opaco para o `pg_depend`: o `drop column` passa verde e a função só estoura na
  primeira chamada em runtime. Antes de remover coluna, varra as funções de
  verdade (`pg_get_functiondef` em todas, procurando o nome da coluna) — grep nos
  arquivos de migração não basta, porque nem toda função no banco está versionada.
- **Chatwoot:** finalizar = `POST .../conversations/{id}/toggle_status` com
  `{status:"resolved"}`. Mensagem *outgoing* não reabre conversa resolvida; só
  *incoming* do cliente reabre.

## Editar workflow do n8n por automação (nota de manutenção)

Mutação de **parâmetro** no store Pinia + Save **persiste**. Mutação **estrutural**
(renomear nó, criar/apagar conexão) **não sobrevive** ao Save — o n8n reconstrói as
conexões a partir do canvas. Faça mudanças estruturais pela UI ou por *Import*.

---

## Endgame: tornar o painel a fonte da verdade

Hoje os passos 2 e 3 são por-tool no workflow compartilhado. Para fazer valer o lema
"nº de workflows = nº de tools, nunca de contas", migre o AI Agent do principal para
**montar as tools e o system prompt lendo `api_n8n_tools_ativas`** (a visão da spec).
Depois disso, adicionar tool = **só catálogo + sub-workflow + contratar**, sem tocar no
principal, e `contratado/ativo` do painel passa a cortar o agente de verdade por
cliente. Vale fazer quando houver ~3–4 tools.
