# n8n — workflows versionados

Metade do sistema vive no n8n: o workflow principal do agente e um sub-workflow por
tool. Até 2026-08 nada disso estava em git — o que deixou passar um `$('Webhook1')`
órfão e um `queryReplacement` quebrado rodando meses em produção sem ninguém ver.

Esta pasta é a fonte da verdade **versionada**. A instância do n8n é o ambiente de
execução, não o repositório.

## Estrutura

```
n8n/
├── README.md                    ← este arquivo
└── workflows/
    ├── agente-principal.json    ← workflow principal (webhook Chatwoot → AI Agent)
    ├── tool-busca-kb.json       ← oAScbGA9K7jMZIP0
    ├── tool-transferir-humano.json  ← N902wAbxRd8wHFUv
    └── tool-resolver-conversa.json  ← lT5oxXJKulPdlPPR
```

O nome do arquivo é estável; o ID do n8n vai no cabeçalho da tabela abaixo porque
ele **muda** quando você reimporta (import cria workflow novo).

| Arquivo | Nome no n8n | ID atual |
|---|---|---|
| `agente-principal.json` | Agente Multi-Tenant (Supabase) | `1fqJokfU8M2pXhzo` |
| `tool-busca-kb.json` | Tool - Busca KB Multi-Tenant | `oAScbGA9K7jMZIP0` |
| `tool-transferir-humano.json` | Tool - Transferir para Humano (Multi-Tenant) | `N902wAbxRd8wHFUv` |
| `tool-resolver-conversa.json` | Tool - Resolver Conversa (Multi-Tenant) | `lT5oxXJKulPdlPPR` |
| `tool-consultar-catalogo.json` | Tool - Consultar Catalogo (Multi-Tenant) | `H8jRRLmwBzxshp9w` |
| `tool-gerenciar-pedido.json` | Tool - Gerenciar Pedido (Multi-Tenant) | `5rMg40Lagy3OaIo7` |
| `tool-fechar-pedido.json` | Tool - Fechar Pedido (Multi-Tenant) | `bJlew3rtuV4gRgzv` |
| `tool-cancelar-pedido.json` | Tool - Cancelar Pedido (Multi-Tenant) | `rXF7LJmqNBZDUg4b` |
| **(nao versionado)** | Limpar Memoria (Webhook do Painel) | `Dvzv1sjECm2q2aPC` |

> Ao reimportar um sub-workflow, o ID muda e **o nó `toolWorkflow` do principal
> aponta pro ID velho**. Atualize a referência no principal e a tabela acima.

## Ciclo de trabalho

**Sempre que mexer num workflow:**

1. Editar na UI do n8n (mudança estrutural não sobrevive a automação — ver nota abaixo)
2. `...` → Download
3. Substituir o arquivo correspondente aqui
4. Rodar `node scripts/n8n-limpar-export.mjs n8n/workflows/*.json`
5. Commit com mensagem descrevendo o que mudou no fluxo, não "update workflow"

**Antes de commitar, o script remove:**
- `pinData` — contém payload real de webhook, com telefone e nome de contato
- `meta.instanceId` — identifica a instância
- `staticData`, `versionId`, `triggerCount` — ruído que polui diff

Ele **não** remove `credentials`, porque ali só ficam id e nome — nunca segredo.
Mesmo assim confira antes de subir.

## Regras que valem para todo workflow

Estas repetem `CLAUDE.md` e `docs/ADICIONAR-TOOL.md` porque são as que quebram calado:

- **`tenant_id` sempre do fluxo, nunca do `$fromAI`.** Resolvido de
  `chatwoot_account_id` via `api_n8n_tenant_por_chatwoot`. Idem `conversation_id`
  e `account_id`, que vêm do `Extrair e Filtrar`.
- **`queryReplacement` do nó Postgres sempre em array:** `={{ [ a, b ] }}`.
  String com vírgula é dividida em parâmetros e a query quebra em silêncio.
- **Query com parâmetro = statement único.** Extended query protocol recusa
  múltiplos comandos separados por `;`. Encadeie com CTE.
- **Sub-workflow de tool começa checando `tool_ativa`** via
  `api_n8n_config_tool(tenant_id, '<tool_nome>')`. O workflow principal é
  compartilhado por todos os clientes: sem essa trava, plugar uma tool nova a
  habilita para quem não contratou — inclusive a Acqua, em produção.
- **Nada de `onError: continueRegularOutput` em nó de log ou billing.** Foi o que
  escondeu o bug do `Registra Mensagem`.

## Ctrl+S NÃO salva. Só o botão Save.

Custou duas rodadas para descobrir em 11/08/2026: mutação aplicada, `Ctrl+S`,
tela mostrando "Saved" — e ao recarregar, **o estado tinha voltado inteiro**.

O atalho não dispara o save nesta instância. O que funciona é clicar no botão
**Save** no topo direito.

E daí a regra que vale sempre: **confira recarregando a página**, não pelo
"Saved" da tela. O indicador mente nesse caso, e uma mudança que não pegou é
indistinguível de uma que pegou até alguém reabrir o workflow — ou até o agente
se comportar diferente do esperado em produção sem motivo aparente.

Verificação boa, pela store da própria página:

```js
// depois de recarregar
const s = document.querySelector('#app').__vue_app__
  .config.globalProperties.$pinia._s.get('workflows');
s.allNodes.find(n => n.name === '<nó>').parameters
```

## A corrida do debounce (execução 3951004)

O acúmulo de mensagens usa uma chave por conversa no Redis:

```
Acumula Mensagem (RPUSH)  ->  Lista Antes (GET)  ->  Wait Debounce
  ->  Lista Depois (GET)  ->  Ultima Mensagem? (IF)  ->  Limpa Acumulo (DEL)  ->  agent
```

A ideia do `Ultima Mensagem?` é: se a lista não cresceu durante a espera, eu sou
a última mensagem e respondo por todas. Se cresceu, outra execução responde e eu
paro.

**O furo:** a condição era só `antes == depois`. Duas execuções concorrentes na
mesma conversa produzem `0 == 0`, que aprova.

```
t=0.00   A: RPUSH        lista = [A]
t=0.01   A: Lista Antes  antes_A = [A]          A espera 8s
t=8.00   A: Lista Depois depois_A = [A]         1 == 1  -> aprova
t=8.00   B: RPUSH        lista = [A, B]
t=8.01   A: Limpa Acumulo (DEL)                 lista = <apagada>
t=8.02   B: Lista Antes  antes_B = []           <- leu depois do DEL
t=16.0   B: Lista Depois depois_B = []
         B: Ultima Mensagem?  0 == 0  -> APROVA
         B: agent com prompt vazio -> "No prompt specified"
```

Dois estragos, não um:

1. o agent é chamado sem prompt e a execução morre;
2. **o `Limpa Acumulo` roda nesse caminho** e apaga a chave — levando junto
   qualquer mensagem que tenha chegado no meio.

**A correção** é a condição `d2` no `Ultima Mensagem?`: `lista_depois.length > 0`.
Fica **antes** do `Limpa Acumulo` de propósito — uma guarda depois do delete
evitaria só o estrago 1. `npm run n8n:sincronia` falha se a `d2` sumir.

### O que a guarda NÃO resolve

A mensagem `B` do exemplo continua sem resposta: ela foi apagada pelo `DEL` da
execução `A`, e agora a execução `B` para em silêncio em vez de estourar.

A causa é o `Limpa Acumulo` apagar a chave inteira em vez de remover só os itens
que foram lidos. O certo seria `LTRIM key N -1`, que preserva o que chegou
depois — **o node Redis do n8n não expõe `LTRIM`** (só `get`, `set`, `delete`,
`incr`, `keys`, `publish`, `push`, `pop`), então não dá para fazer sem sair do
node.

**Por que não usar o fallback para a mensagem do `Extrair e Filtrar`:** ele
resolveria a perda, mas cria resposta duplicada no caso simétrico — se a
execução `A` tiver lido `B` antes de limpar, `B` já foi respondida, e responder
de novo faz o agente reprocessar um pedido. Num agente que cria pedido, duplicar
é pior que perder. Trocar uma falha silenciosa por outra visível só compensa se
a visível for a menos danosa, e aqui não é.

A janela é de milissegundos (entre o `Lista Depois` e o `Limpa Acumulo` de outra
execução) e exige duas mensagens quase simultâneas na mesma conversa. Fica
registrado; se aparecer em produção, o caminho é trocar o `DEL` por remoção
parcial, o que exige um Code node com cliente Redis próprio.

---

## Nota de manutenção — editar por automação

Mutação de **parâmetro** no store Pinia + Save persiste. Mutação **estrutural**
(renomear nó, criar/apagar conexão) **não sobrevive** ao Save: o n8n reconstrói as
conexões a partir do canvas. Mudança estrutural é pela UI ou por Import de JSON.

Por isso a entrega de qualquer alteração estrutural é **um JSON pronto para importar**,
nunca uma lista de cliques.

## Verificação rápida de um export

Antes de importar um JSON que veio de fora, vale rodar:

```bash
node scripts/n8n-validar.mjs n8n/workflows/agente-principal.json
```

Checa referências `$('Nó')` órfãs, conexões apontando para nó inexistente,
`queryReplacement` em formato string e `onError` engolindo erro.
