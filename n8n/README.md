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

### A guarda não devolve a mensagem — mas agora ela aparece

A mensagem `B` do exemplo continua sem resposta: foi apagada pelo `DEL` da
execução `A`. A guarda `d2` impede o estouro e impede o delete indevido, **mas
não recupera a mensagem**.

Trocar estouro por parada silenciosa seria piorar, do ponto de vista do cliente
final: ele simplesmente não é respondido e ninguém fica sabendo. Por isso o ramo
`false` do `Ultima Mensagem?` foi separado em dois:

```
Ultima Mensagem?  --false-->  Acumulo Sumiu?  --sim-->  Acumulo Sumiu (corrida)  [stopAndError]
                                              --nao-->  (nada: outra execucao responde)
```

`lista_depois.length == 0` separa os casos com precisão: quando outra execução
vai responder, a lista tem pelo menos um item; vazia só acontece se a chave foi
apagada. O caso normal — que roda o tempo todo — continua silencioso; a corrida
vira execução vermelha com a conversa e o tenant na mensagem.

### O conserto de raiz: LPOP no lugar do DELETE

Feito em 12/08/2026. O `Limpa Acumulo` (DEL na chave inteira) foi **removido** e
substituído por três nós:

```
Ultima Mensagem? --true--> Separa Lidos --> Remove Lidos do Acumulo --> Volta a Um Item --> Tools Ativas
                           (Split Out)      (Redis pop, tail=false)     (Limit 1)
```

O `Split Out` sobre `lista_depois` cria um item por mensagem lida. Como o n8n
executa um node **uma vez por item de entrada**, o node Redis seguinte roda
exatamente `N` vezes — removendo as `N` lidas, do começo. O que chegou durante o
debounce permanece na lista, e a próxima execução o processa.

Não é atômico, mas é correto para este uso: `push` só acrescenta no fim e `pop`
com `tail: false` só remove do começo (no fonte:
`client[tail ? 'rPop' : 'lPop']`), então os `N` removidos são exatamente os `N`
lidos.

**O `Volta a Um Item` não é enfeite.** O `Split Out` multiplicou os itens de
propósito; sem voltar a um, o `Tools Ativas`, o `Vende?` e o agent recebem `N`
itens, **o agent roda `N` vezes e o cliente recebe `N` respostas**. É a falha
mais visível que este fluxo consegue produzir. `npm run n8n:sincronia` falha se
o `Limit` sumir ou se `maxItems` deixar de ser 1.

`Limpa Redis Debounce` continua fazendo DEL na mesma chave, e está certo: ele
fica no ramo de pausa. Quando um humano assume a conversa, descartar o acúmulo é
o desejado — o agente não deve responder aquelas mensagens.

### Por que não um Code node com cliente Redis

Era o caminho óbvio para `LTRIM key N -1`, e não dá:

**O node Redis do n8n não tem LTRIM.** No fonte (`Redis.node.ts`) as operações
são `delete`, `get`, `incr`, `info`, `keys`, `llen`, `pop`, `publish`, `push`,
`set`.

**O Code node não acessa credencial, por design.** Não existe `$credentials`;
`$getCredentials()` e `this.getCredentials()` não existem no sandbox. A senha do
Redis teria de vir de `$env` — credencial duplicada no ambiente do container,
fora do cofre do n8n — mais `NODE_FUNCTION_ALLOW_EXTERNAL` para importar o
cliente. Tirar segredo do cofre para dentro do container é o oposto do que a
migração 21 fez com o token do Chatwoot, e por isso foi descartado.

## `.first()` e não `.item` — item linking quebrado (12/08/2026)

`$('No').item` resolve por **item linking**: o n8n rastreia a linhagem do item
corrente até o nó citado. A cadeia do LPOP (`Split Out → pop → Limit → Postgres`)
quebra essa linhagem, e a partir dali `.item` para de resolver.

Custou três execuções para aparecer inteiro, porque cada camada falhou de um
jeito diferente:

| execução | nó | sintoma |
|---|---|---|
| 3951563 | `AI Agent Vendas` | prompt vazio → "No prompt specified" |
| 3952035 | `Credencial (resposta)` | parâmetro `undefined` → "Query Parameters must be a string…" |
| — | `Estima Tokens` | `system_prompt` vazio e memória 0, **em silêncio** |

O terceiro é o pior e quase passou: o nó tinha `try/catch` com comentário vazio
em cada leitura, então seguia com os valores zerados e o rateio simplesmente
encolhia. Nenhum erro, nenhum log. Agora cada falha entra em `_faltou`, que sai
no output do nó — vazio é o esperado; com algo dentro, o rateio está
subestimando.

**A correção é uniforme:** todos os nós citados por expressão neste workflow
emitem **exatamente um item** por execução (um GET no Redis, uma linha do
Postgres, um item do Code, o webhook). Então `.first()` é equivalente ao `.item`
quando o linking funciona, e continua funcionando quando não. Foram 72
ocorrências.

`npm run n8n:sincronia` falha se qualquer `.item` voltar — inclusive vindo de um
export feito depois de editar pela UI.

**Por que só apareceu agora:** antes da fatia 3 o caminho era
`Limpa Acumulo → AI Agent`, um salto só, e o linking sobrevivia. A fatia 3
inseriu `Tools Ativas` (Postgres, que cria itens novos) e o conserto do debounce
inseriu `Split Out` e `Limit`. Cada um sozinho talvez passasse; juntos, não.

---

## O export do n8n OMITE parâmetro em default

Descoberto em 12/08/2026, ao aplicar um canvas exportado sobre o repo.

**Ao exportar, o n8n não escreve parâmetro cujo valor bate com o default do
node.** O JSON que volta é menor que o que entrou, e o que sumiu continua
funcionando — pelo default. Não é bug: é como ele serializa.

O efeito é uma erosão silenciosa a cada ciclo importar → editar na UI →
exportar → commitar. Três parâmetros sumiram de uma vez naquele export:

| nó | sumiu | o que ficou implícito |
|---|---|---|
| `Volta a Um Item` | `maxItems` (o `parameters` ficou `{}`) | o teto de **uma resposta por mensagem** |
| `Baixa Anexo` | `outputPropertyName` | o nome do binário que a transcrição consome |
| `Vende?` | os `outputKey` | os nomes das saídas do Switch na UI |

**Nenhum quebrava nada.** O primeiro é o que importa: o teto que impede o
`Split Out` de virar N mensagens no WhatsApp estava valendo por um default do
n8n, não por algo escrito no JSON. Se uma versão futura mudar esse default,
ninguém descobre por leitura do repo — descobre pelo cliente recebendo cinco
mensagens seguidas.

### O que fazer com isso

**Não confie em diff de export para saber o que mudou.** Parâmetro ausente e
parâmetro em default são indistinguíveis no arquivo, e o diff mostra remoção
onde não houve mudança de comportamento.

**Prefira regerar a colar o export.** `node scripts/gerar-principal.mjs` escreve
os parâmetros explicitamente e preserva posição e id do canvas — é assim que o
canvas organizado na UI e o código do repo convivem sem um apagar o outro.

**O `n8n-validar.mjs` tem uma lista** (`SEM_DEFAULT`) dos parâmetros que não
podem valer por default, com a razão de cada um. Ela cobre o que importa por
**segurança** ou por **custo**, e cresce quando algo novo entrar nessa
categoria. Hoje:

```
Volta a Um Item          maxItems               teto de uma resposta ao cliente
Remove Lidos do Acumulo  tail                   LPOP x RPOP
Baixa Anexo              outputPropertyName     binário que a transcrição consome
Redis Chat Memory        contextWindowLength    memória = custo por mensagem
Transcreve               bodyParameters         verbose_json traz a duração cobrada
```

Testado simulando o próprio export: apagar `maxItems` e `tail` reprova.

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
