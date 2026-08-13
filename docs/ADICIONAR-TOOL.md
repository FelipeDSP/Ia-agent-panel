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
     migração 21a — RLS não filtra coluna, e o token é credencial da agência);
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

7. **Declarar a superfície — OBRIGATÓRIO.** Sem este passo o item fica incompleto,
   e a tool vaza tela para quem não contratou.

   A propriedade: **toda superfície que a tool traz — item de menu, rota, seção de
   tela, indicador, Server Action — só existe para quem contratou a tool.**

   Superfície **não** é sinônimo de rota: `foto_produto` não tem nenhuma, é uma
   seção dentro do catálogo, e obedece à mesma regra.

   O que fazer, conforme o que a tool traz:

   | a tool traz | o que declarar |
   |---|---|
   | tela nova sob `/painel/` | `rotasPainel` no registry **e** um `layout.tsx` na pasta chamando `exigirToolDaRota` |
   | seção dentro de tela existente | a página resolve `temToolContratada` e passa por prop; o componente renderiza condicional |
   | Server Action que escreve | `temToolContratada` no início de **cada** action exportada, devolvendo `ERRO_NAO_CONTRATADA` |
   | tabela própria | acrescente em `SUPERFICIE_DE_DADO` (`tests/descontratar-preserva-dado.mjs`) |
   | ícone novo no menu | acrescente ao mapa `ICONES` em `src/components/sidebar.tsx` |
   | o cliente pode desligar, mas a tool não é vendida | `desligavel: true` no registry |

   Sobre a última linha: **"pode desligar" não sai de "é vendida".** São
   perguntas diferentes. `busca_conhecimento` não desliga por limitação técnica —
   agente sem base responde do nada. `transferir_humano` desliga por escolha de
   negócio — há cliente que não quer receber atendimento transferido em momento
   nenhum. Ao registrar uma tool, responda as duas separadamente, e lembre que
   **quem pode desligar tem de aparecer em algum lugar da tela**, senão é decisão
   sem onde ser tomada.

   Nada disso é convenção que dá para esquecer — três checagens reprovam:

   ```bash
   npm run teste:superficie     # rota sem dono, action sem guard, ícone ausente
   npm run teste:grupos         # grupo, exibição e capacidade
   npm run teste:descontratar   # descontratar não apaga dado
   ```

   E o menu é montado a partir do registry: **não declarar significa o item não
   aparecer para ninguém.** O esquecimento vira ausência, que alguém nota, em vez
   de vazamento silencioso, que ninguém nota.

   Duas coisas já decididas, para não redecidir a cada tool:

   - **Falha de resolução fecha.** Se a consulta de contratação errar, sobram só
     as rotas sempre-visíveis; as condicionais somem. Vale igual no menu e no
     guard de rota — divergir produziria menu que mostra o que a rota nega.
   - **Descontratar esconde, nunca apaga.** O dado fica e recontratar devolve
     tudo. Se a tool guardar dado do cliente, é trabalho de cadastro que ninguém
     consegue devolver depois.

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
- **Nó novo: algum parâmetro dele importa por SEGURANÇA ou por CUSTO?** Se sim,
  acrescente à lista `SEM_DEFAULT` do `scripts/n8n-validar.mjs`. O n8n **omite no
  export** todo parâmetro cujo valor bate com o default do node — então um limite,
  um teto ou uma escolha que hoje valem por default vão sumir do JSON no primeiro
  ciclo de import/export, e continuar funcionando até alguém mudar o default.
  Aconteceu com o `maxItems` do `Volta a Um Item`, que é o teto de **uma resposta
  por mensagem**. Ver `n8n/README.md`, seção "O export do n8n OMITE parâmetro em
  default". A lista só protege o que alguém lembrou de listar; este é o momento
  de lembrar.

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
