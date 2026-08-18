# Tokens reais para cobrar o cliente — os três caminhos, com o que foi medido

> **A pergunta.** Hoje o rateio sai de uma ESTIMATIVA calibrada contra quatro
> execuções de UM tenant (`n8n/estima-tokens.js`). Isso não sustenta uma conta
> que alguém vai contestar. Onde está o número que a OpenAI cobra?

> **Estado em 18/08/2026 — decidido.** Nenhum dos três caminhos entrega medição
> exata: o 3 entregaria e está bloqueado pela credencial fixa do nó; o 1 e o 2
> entregam o que o n8n mede, e o que o n8n mede é **estimativa dele** (ver
> "RESOLVIDO" abaixo). O desenho final é **fatura da OpenAI como âncora, n8n só
> para a proporção**. Caminho 1 segue instrumentado porque a decisão passou a ser
> entre estimativas, e a pergunta virou qual delas erra menos.

## O desenho, decidido em 18/08/2026

Quatro afirmações. As três primeiras estão medidas neste documento; a quarta é a
consequência delas na conversa com o cliente.

1. **A fatura da OpenAI é a âncora.** O total cobrado dos clientes num mês nunca
   excede o que foi pago à OpenAI naquele mês. Isso não é meta de precisão — é
   propriedade aritmética do rateio, e vale mesmo com a medida por turno errada.
2. **O rateio sai da proporção que já temos.** É para isso que a estimativa
   serve, e é o que ela faz bem: ordenar e proporcionar clientes entre si.
3. **Nenhum dos três caminhos entrega medição exata por tenant, e isso está
   decidido por MEDIÇÃO, não por falta de tentativa.** Caminho 3 entregaria e
   está bloqueado pela credencial fixa do nó; caminhos 1 e 2 entregam o que o
   n8n mede, e o que o n8n mede é estimativa dele (seção "RESOLVIDO" abaixo).
   A diferença entre uma escolha e uma desistência é exatamente esta seção.
4. **O que sustenta a conversa com quem contesta é "você foi X% do consumo do
   mês"** — não o valor absoluto por turno. A proporção é defensável: sai de
   dados de execução, o total confere com a fatura, e a soma das contas fecha.
   "Caracteres sobre 3,112" nunca seria defensável, e é o que se cobra hoje.

**O que falta é a parte não-técnica:** como a fatura entra no sistema todo mês.
Registrado em [`PENDENCIA-FATURA-OPENAI.md`](PENDENCIA-FATURA-OPENAI.md) — não
construído.

## O que já foi descartado, e não vale retestar

A sonda A (`_sonda`, no nó `Estima Tokens`) tentou alcançar o sub-nó
`OpenAI Chat Model` a partir de um nó Code do fluxo principal, em duas formas.
Veredicto na execução 3949227: **não dá** — o nó é encontrado e não tem saída
`main` ("No data found from `main` input"). A sonda ficou no código porque custa
zero e uma versão futura do n8n pode mudar isso.

## Caminho 1 — o que chega em `$input` com `returnIntermediateSteps`

**Confirmado no workflow versionado:** `returnIntermediateSteps: true` está
ligado nos DOIS agents (`AI Agent Basico` e `AI Agent Vendas`). A pergunta é
legítima, e a resposta ainda não existe: `estima-tokens.js` lê `output` e
`intermediateSteps.length`, e **nada mais**. Ninguém inspecionou o objeto.

O que se espera encontrar: cada passo traz `action.messageLog[]` com as
`AIMessage` do round-trip, e uma `AIMessage` serializada costuma carregar
`response_metadata.tokenUsage` e/ou `usage_metadata` — que são o campo `usage`
da resposta da API, não estimativa.

**Mas o achado do `tokenUsageEstimate` (abaixo) prevê o contrário, e a previsão
vale escrita antes do teste.** Se a chamada não devolve `usage` — que é o que a
chave de fallback indica —, a `AIMessage` também não carrega `usage_metadata`, e
a sonda B deve achar **zero**. Isso não torna a execução inútil: `usos > 0`
refuta a explicação inteira e reabre o caminho 1 como o melhor de todos, e
`usos == 0` fecha a pergunta que estava aberta desde 11/08 sem custar nada além
de uma mensagem que ia acontecer de qualquer jeito.

**Instrumentado em 18/08 (sonda B).** Em vez de procurar o caminho que eu suponho
existir, ela **varre o objeto inteiro** atrás de qualquer par
`promptTokens|input_tokens` × `completionTokens|output_tokens` e reporta os
caminhos achados. Assim o veredicto não depende de eu ter acertado o formato de
serialização desta versão do n8n. Tem teto de nós visitados e proteção contra
ciclo — um nó Code que estoura memória derruba a mensagem do cliente, e
diagnóstico não vale isso. A varredura tem prova offline em
`tests/sonda-tokens.mjs` (7 asserções, sabotagem inclusa), porque sonda que
varre errado devolve "não dá" — que foi exatamente a conclusão que segurou este
assunto por meses.

**Como ler o veredicto**, na primeira execução real, no campo `_sonda_b`:

| `usos` vs `chamadas_estimadas` | Significa | O que fazer |
|---|---|---|
| `usos == chamadas` | o exato cobre tudo | trocar a estimativa inteira |
| `usos == chamadas - 1` | **o esperado** | somar o real dos passos e estimar SÓ a chamada final |
| `usos == 0` | `messageLog` não é serializado na saída do nó | caminho morto; vai para o 2 |

**O limite é estrutural, e por isso a sonda B NÃO entra no total sozinha:**
`intermediateSteps` cobre os passos que chamaram ferramenta, e a chamada FINAL —
a que produziu `output` — não vira passo. Somar só o que ela achar **subcobra,
calado**, que é a falha que aquele arquivo existe para impedir.

## Caminho 2 — API de execuções, job diário (RECOMENDADO)

Billing não precisa ser em tempo real, e este é o caminho cujas peças já estão
todas no lugar.

**A chave de junção existe.** A migração 37 pôs `execucao_id` em `mensagens_log`
— `$execution.id`, identificador do próprio n8n, confirmado resolvendo em
execução real. É exatamente o que liga "execução 3966582" às duas linhas daquele
turno, com o `tenant_id` já preenchido.

**Medido em produção em 18/08:**

- `execucao_id` populado desde 14/08 (data da migração 37): 44 de 114 linhas nos
  últimos 30 dias. O que veio antes **não é reconciliável** — não tem a chave;
- volume de 17/08: **42 linhas / 21 execuções**, exatamente o par por turno que a
  37 descreve. Vinte e uma chamadas de API por dia dispensa qualquer otimização e
  permite buscar execução por execução.

**Desenho:**

1. `GET /api/v1/executions?workflowId=<principal>&limit=250` para os ids do dia;
2. por id, `GET /api/v1/executions/{id}?includeData=true` e, de
   `data.resultData.runData['OpenAI Chat Model']`, somar o uso de cada entrada —
   é o mesmo dado que a UI mostra, uma entrada por chamada ao modelo;
3. `update mensagens_log set tokens_entrada/tokens_saida where execucao_id = $1`
   **e `tenant_id = $2`** — filtro de tenant explícito vale aqui como em qualquer
   query crua, mesmo com a chave sendo única;
4. uma coluna `fonte_tokens` (`estimativa` | `api`) para a fatura poder dizer de
   onde veio cada linha. Sem ela, reconciliado e estimado ficam
   indistinguíveis — e é a primeira pergunta de quem contesta.

### RESOLVIDO em 18/08: é `tokenUsageEstimate`, e não há botão para mudar

Conferido no JSON versionado, sem esperar execução:

- **nenhuma chave com `stream` nos 56 nós** — nada de streaming configurado;
- o gatilho é `n8n-nodes-base.webhook` (POST), **não** um Chat Trigger. Não há
  consumidor de resposta em streaming;
- o nó `OpenAI Chat Model` (v1.3) define **só** `model` e `temperature`.

E, apesar disso, o campo que aparece em execução real é `tokenUsageEstimate`.
Isso não é suposição: o `RUNBOOK-VENDAS-N8N.md` manda abrir o sub-nó e anotar
`tokenUsageEstimate.promptTokens`, e é **dessa leitura** que saíram os números
1554 / 2016 / 3828 / 10481 que o `estima-tokens.js` chama de "real".

No tracing de LLM do n8n essa chave é o CAMINHO DE FALLBACK: ela aparece quando
a resposta do modelo **não** traz `usage`, e aí o n8n estima a partir do texto.
Se `usage` viesse, a chave seria `tokenUsage`. Como o workflow não liga
streaming em lugar nenhum, a causa é interna ao agent (o AgentExecutor do
LangChain roda o modelo em streaming por padrão, e chamada em streaming não
devolve `usage` a menos que se peça `stream_options.include_usage`). **Não é
configuração deste workflow — não existe o botão.**

**A consequência é maior que o caminho 2.** A coluna "real" da calibração de
11/08 **também era estimativa** — do n8n, não da OpenAI. Ou seja: nada em toda
a cadeia jamais tocou um número que a OpenAI cobra; a heurística de hoje
(caracteres ÷ 3,112) foi calibrada contra outra estimativa. Isso não invalida a
calibração para o que ela serve — ordenar clientes entre si —, mas encerra a
ideia de que existe medição exata escondida em algum lugar do n8n.

**Duas coisas ainda a conferir antes de construir:**

- **Chave de API do n8n.** Não existe no `.env.local` hoje (só Supabase e
  Chatwoot). Precisa ser criada e guardada como as outras.
- **Poda de execuções.** O n8n apaga execução antiga por idade
  (`EXECUTIONS_DATA_MAX_AGE`, 336 h no padrão self-hosted) e só guarda dado de
  execução se o workflow estiver salvando sucesso. Rodando diário sobra folga;
  backfill além da janela **não existe**.

## Caminho 3 — chave (ou projeto) da OpenAI por tenant

É o único que devolve o número que a OpenAI **cobra**, e não uma medida do que
passou pelo fluxo. Se a conta for contestada em valor que justifique, é para cá
que se vai.

**Prefira PROJETO por tenant, não só chave:** a Usage/Costs API da OpenAI agrupa
por projeto, o que dá custo em dólar por tenant direto da fonte, sem multiplicar
token por tabela de preço nenhuma.

**O bloqueio não é o painel — é o n8n.** O padrão de credencial por tenant já
existe em `tenant_credenciais`, e o modelo já é dinâmico por tenant no fluxo:
`OpenAI Chat Model` resolve `model` por expressão a partir do `Resolve Tenant`.
**Credencial não aceita expressão.** O nó carrega uma credencial `openAiApi`
fixa, escolhida em tempo de edição. Então chave por tenant implica uma destas:

- **um workflow por tenant** — N workflows a manter em sincronia, e todo conserto
  vira N consertos;
- **trocar o nó Agent por HTTP Request cru**, injetando a chave do banco — perde
  o Agent, as tools declarativas e a memória Redis integrada;
- **sub-workflow por tenant só para o modelo** — menos ruim, ainda N.

Nenhuma é barata. É trabalho de arquitetura, não de painel.

## Recomendação

**Ancore a fatura no total da OpenAI e use o n8n só para o RATEIO.** O custo
mensal da organização é indiscutível: sai da fatura. O que o caminho 2 entrega é
a proporção entre clientes, com fidelidade muito maior que a estimativa de hoje.
Cobrando `total_da_fatura × proporção_do_tenant`, a soma das contas **fecha com o
que foi efetivamente pago**, sempre — e é isso que sustenta a conversa com quem
contesta, mesmo que a medida por turno tenha erro.

**E, decidido em 18/08: nenhum dos três caminhos é medição exata.** O caminho 3
seria, e está bloqueado pela credencial fixa do nó. Os caminhos 1 e 2 entregam o
que o n8n mede, e o que o n8n mede é estimativa dele. A decisão está tomada **por
medição, não por falta de tentativa** — que é a diferença entre uma escolha e uma
desistência.

Ordem prática:

1. ler `_sonda_b` na primeira execução real (custo zero, já está no ar). Mesmo
   sendo estimativa, uso por passo é melhor que caractere ÷ 3,112 — e a decisão
   é entre estimativas, então a pergunta vira "qual erra menos";
2. ~~conferir `tokenUsage` vs `tokenUsageEstimate`~~ — **feito, é estimate**;
3. construir o job diário do caminho 2, com `fonte_tokens` (aqui o valor passa a
   ser `n8n` e não `api`, para a fatura não prometer o que não tem);
4. caminho 3 só quando um cliente contestar em valor que pague a reescrita.

O que **não** dá é seguir chamando qualquer um desses números de medição. O único
número indiscutível é a fatura — por isso ela é a âncora, e o resto é proporção.
