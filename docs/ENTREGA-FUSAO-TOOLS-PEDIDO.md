# Fusão das ferramentas de pedido em uma — o experimento da sobrecarga

**Nada importado, nada aplicado.** Os dois JSONs estão prontos; a ordem de
import está na §7 e não é negociável.

> **Isto não é economia — é o experimento.** O `AI Agent Basico` tem 3
> ferramentas e zero fabricações; o de vendas tinha 8 e oito fabricações. Essa
> comparação nunca foi testada e não se sustenta sozinha (o básico não tem
> ferramenta de escrita — não *pode* fabricar venda). A fusão é a primeira
> variação limpa: mesmo agente, mesmo prompt, mesmo tenant, ferramentas a menos.
> Se a fabricação cair, sobrecarga se confirma. Se não cair, o portão vira a
> defesa definitiva. Nos dois casos a fusão fica.

---

## 1. Uma correção de contagem, antes de tudo

O enunciado diz *"cai de 8 para 5"*. **Cai de 8 para 6.** As oito eram:
busca_conhecimento, transferir_humano, resolver_conversa, consultar_catalogo,
gerenciar_pedido, fechar_pedido, cancelar_pedido, enviar_foto_produto. A fusão
junta **três** nós (gerenciar + fechar + cancelar) em um — saem dois. Sobram
seis, e `teste:tool-pedido-fundida` afirma **6** ligadas ao `AI Agent Vendas`,
*"não 5 nem 8"*, para o número não ser lido de memória.

Cinco é o número de **ações** da ferramenta fundida (`adicionar | remover | ver
| fechar | cancelar`), e provavelmente foi daí que veio o "5".

## 2. A fusão desfaz uma decisão escrita, e isso tem de estar dito

`scripts/gerar-workflows-vendas.mjs` (fatia 2, agosto) tinha esta nota ao
separar fechar e cancelar em ferramentas próprias:

> *"Acao irreversivel nao fica atras de $fromAI junto com acao reversivel: o
> agente chamar «fechar» quando o cliente perguntou «quanto ficou?» trava o
> pedido, e «cancelar» por engano apaga o carrinho."*

A fusão põe exatamente isso atrás de um `$fromAI('acao')`. Não é descuido: é a
variável do experimento. Mas o risco que aquela nota nomeou **continua sendo um
risco**, e passa a ser uma das coisas que o critério da §9 mede — uma conversa
em que `fechar` foi chamada sem o cliente ter confirmado **não é "limpa"**, mesmo
que o total bata.

O que mitiga, sem afrouxar nada: as travas do banco continuam (fechar duas vezes
não fecha nada, cancelar com venda fechada não toca nela — §6 prova as duas), e
o texto de cada ação carrega a condição de uso que a ferramenta separada tinha
(*"SÓ quando o cliente confirmar"*, *"pergunte antes, o carrinho não volta"*).

## 3. Custo de contratação: zero, conferido

`catalogo_tools` tem **uma** linha `vendas` (conferido no banco em 10/09: seis
linhas no catálogo, nenhuma por ferramenta de pedido). A fusão não mexe em
`tenant_tools`, não migra contratação, não muda tela. `Busca Config` continua
consultando `api_n8n_config_tool($1, 'vendas')` — e é a **primeira coisa** que
o sub-workflow faz, antes do switch (§6 afirma que nenhum nó de ação é
alcançável sem passar por `Vendas Ativa?`).

## 4. Uma fonte, quatro derivados — o caso 2 do enunciado

A ferramenta fundida tem a lista de ações em **três** lugares que o modelo e o
n8n leem, e a família fonte↔derivado mordeu quatro vezes esta semana. Então a
lista mora em **um** arquivo, `n8n/tool-pedido-acoes.mjs`, e os outros são
derivados dele:

| derivado | quem escreve | quem confere |
|---|---|---|
| o switch `Qual Acao?` (regras, fallback, nós Postgres, `queryReplacement`) | `scripts/gerar-tool-pedido.mjs` | `teste:tool-pedido-fundida` §1: saídas do switch **==** `NOMES_ACOES`, na ordem |
| a `description` do nó `Gerenciar Pedido` no principal | `scripts/gerar-principal.mjs` (novo bloco 4a) | §1: `description` **==** `descricaoFerramenta()` |
| a dica do `$fromAI('acao', …)` | idem | §1: contém `dicaFromAI()` |
| a seção `## Ferramenta: gerenciar_pedido` do system message | `gerar-principal.mjs` (novo bloco 2a, splice no `fixoAtual`) | §1: seção **==** `secaoPrompt()`; seções de fechar/cancelar **ausentes**; básico sem seção de venda |
| o texto de `Acao Invalida` | `gerar-tool-pedido.mjs` | §1: **==** `textoAcaoInvalida()` |

E o que o teste **executa** é o derivado, não a fonte: as queries de §6 vêm do
**JSON gerado**, e a ordem dos parâmetros vem do `queryReplacement` do JSON,
parseado. Testar `ACOES[i].query` diria que a fonte está certa; testar o JSON
diz que o que vai ao ar está certo.

**A `description` deixou de ser órfã — para esta ferramenta.**
`PENDENCIA-GERADOR-CAMPO-ORFAO.md` registra que o gerador não escrevia a
description de 7 das 8 ferramentas e nenhum validador a olhava. A partir de
agora `gerar-principal.mjs` escreve a do `Gerenciar Pedido` a partir da fonte,
e o teste reprova se alguém a editar pela UI (sabotagem S3). **As outras cinco
continuam órfãs; a pendência continua aberta para elas.**

## 5. O que mudou no `agente-principal.json`, exatamente

Tocado só pelo que a fusão exige, via `node scripts/gerar-principal.mjs`:

1. **saem** os nós `Fechar Pedido` e `Cancelar Pedido` e suas conexões `ai_tool`
   (bloco 4a do gerador, idempotente);
2. **`Gerenciar Pedido`** ganha `description`, `workflowInputs` (agora com
   `metadados`, para `fechar`) e a dica do `$fromAI('acao')` derivados da fonte.
   O `workflowId` continua `5rMg40Lagy3OaIo7` — ver §7 o porquê;
3. **system message do `AI Agent Vendas`**: as seções `## Ferramenta:
   fechar_pedido` e `## Ferramenta: cancelar_pedido` saem; a de
   `gerenciar_pedido` é substituída por `secaoPrompt()` (bloco 2a). A frase
   *"Repita ao cliente O RESUMO QUE ELA ACABOU DE DEVOLVER"* foi **mantida** de
   propósito: o experimento é "mesmo prompt", e essa frase é a que a
   `INVESTIGACAO-POR-QUE-FABRICA.md` aponta como causa — mudar as duas coisas ao
   mesmo tempo contaminaria a medição;
4. **`AI Agent Basico`**: derivado do de vendas como sempre, e continua sem
   seção de venda nenhuma (afirmado);
5. **`Estima Tokens`**: `__WRAPPERS__` regenerado (o de vendas mudou) e
   `__PERFIS_S__` com o `S` novo — §8;
6. **`Aplica Portao`**: **não** tocado. O gerador não o conhece e o injetor não
   foi rodado — os dois vermelhos da suíte continuam os mesmos e pelo mesmo
   motivo de antes (`ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md` §10).

**`RE_SECOES_VENDAS` sobreviveu.** O recorte é `## Ferramenta:
consultar_catalogo … (?=## Regras gerais)`; as duas âncoras ficaram no lugar e
o gerador — que **aborta** se o casamento falhar — rodou. O splice da fusão
acontece **antes** do recorte, sobre o mesmo `fixoAtual`, e tem as próprias
guardas: aborta se a seção de `gerenciar_pedido` não existir, se alguma seção
fundida sobreviver, ou se a seção nova não mencionar cada ação.

Um detalhe que mordeu na primeira execução e está registrado no código: a
regex do splice era construída num template literal, onde `\s` vira a letra
"s" — `[\s\S]` viraria `[sS]` e o gerador diria "seção não encontrada" para um
texto que estava lá. Duplamente escapado, com o motivo escrito ao lado.

## 6. As cinco ações, com o EFEITO no banco — o caso 1 do enunciado

`teste:tool-pedido-fundida` (66/66) executa a query de cada nó **do JSON**, em
transação abortada, com tenant efêmero, e afirma o **estado** de
`pedidos`/`pedido_itens` depois — não que a chamada respondeu:

| ação | o que se afirma no banco |
|---|---|
| `adicionar` | rascunho criado (0→1); item com quantidade 10 e observação; **preço 150 vindo do catálogo**, não de parâmetro; total 1500 calculado no banco |
| `adicionar` de novo | **define** a quantidade (10→4), como a 49 decidiu — não soma |
| `ver` | devolve os itens e o total, e o **retrato do banco é idêntico** antes e depois (md5) |
| `remover` | item some (2→1) e o total recalcula (600) |
| `fechar` | `status = aguardando_pagamento`, `numero` atribuído, metadados gravados |
| **TRAVA** fechar de novo | retrato idêntico, um pedido só, texto de recusa |
| **TRAVA** cancelar com venda fechada | a venda **continua** `aguardando_pagamento`; *"NADA FOI CANCELADO"* |
| adicionar depois de fechado | abre rascunho **novo**; a venda fica em 600/aguardando |
| `cancelar` | o carrinho vira `cancelado` e a venda fechada continua intacta |
| ação inválida | o Set `Acao Invalida` == `textoAcaoInvalida()` |
| isolamento | o tenant B, na **mesma** `conversation_id`, não vê nem remove nada do A |

**Sabotagem S1 é o caso do enunciado, literal:** o nó `Fecha Pedido` recebe os
parâmetros do `Ve Pedido` — a chamada responde, o texto parece um pedido, e o
status **fica** `rascunho`. Só a asserção de efeito pega, e ela pega. Cada
sabotagem imprime md5 antes e depois.

Três coisas que a fusão **não** mudou e o teste afirma: o ramo `fechar` continua
passando pela notificação ao dono (`Reivindica Notificacao → Tem Notificacao? →
Notifica Venda WAHA → Confirma Notificacao`) com `alwaysOutputData` e
`onError=continueRegularOutput` preservados — sem eles, WAHA fora do ar
derrubaria um fechamento já feito; toda ação termina em `Retorno`; e o `Retorno`
do `fechar` recebe o resultado do **fechamento**, não o da notificação (é para
isso que existe o nó `Resultado do Fechamento`, novo).

`cancelar` **não** ganhou o parâmetro `alvo` que a migração 55 criou na função.
A ferramenta separada não o passava; fundir não é o momento de estender.

## 7. Import: a ordem, e os três sub-workflows antigos

**O `workflowId` do `Gerenciar Pedido` não muda.** A fusão é importada **por
cima** do sub-workflow que já existe na instância (`5rMg40Lagy3OaIo7`): abra
*Tool - Gerenciar Pedido (Multi-Tenant)* no n8n e use *Import from File* **dentro
dele** — o n8n substitui o canvas e mantém o id. Assim não há janela em que o
principal aponte para workflow inexistente, nem placeholder para preencher.

Ordem:

1. **importar `n8n/workflows/tool-gerenciar-pedido.json` por cima do
   `5rMg40Lagy3OaIo7`** (não como workflow novo). Conferir recarregando que o
   `Qual Acao?` tem seis saídas;
2. **importar `n8n/workflows/agente-principal.json`** (o principal). A partir
   daqui `Fechar Pedido` e `Cancelar Pedido` não são mais chamados por ninguém;
3. **só então desativar** *Tool - Fechar Pedido* (`bJlew3rtuV4gRgzv`) e *Tool -
   Cancelar Pedido* (`rXF7LJmqNBZDUg4b`). Desativar antes do passo 2 deixaria o
   principal velho apontando para workflow desativado — o modelo chamaria e a
   execução morreria. Não apagar: ficam como histórico e como rollback rápido;
4. `npm run n8n:diff` contra um export novo, para confirmar que a instância e o
   repo batem.

Se preferir importar a ferramenta como workflow **novo**: o id muda, e aí é
preciso editar o `ID_WORKFLOW` em `n8n/tool-pedido-acoes.mjs` e regenerar o
principal antes de importá-lo. O caminho por cima evita isso.

**Os dois arquivos saíram do repo** (`tool-fechar-pedido.json`,
`tool-cancelar-pedido.json`; o git os guarda). E
`scripts/gerar-workflows-vendas.mjs`, o gerador da fatia 2, **foi desarmado**:
rodado hoje, ele sobrescreveria a ferramenta fundida com a versão de três ações
e recriaria os dois arquivos — desfazendo a fusão em silêncio. Ele já citava um
`gerar-principal-vendas.mjs` que não existe; estava morto antes. Agora aborta
com a mensagem certa e aponta para os geradores atuais.

## 8. `S` do perfil de vendas: 778, e como cheguei — não é regra de três

`S = 622` foi **medido** em 11/08 pelo método das duas equações, com **sete**
ferramentas e as descrições **antigas**. Desde então: entrou a foto (8), as
descrições foram reescritas em 09/09 (bem mais longas), e a fusão levou a 6.
Nenhuma dessas três coisas foi medida. Medir exige uma execução real do perfil
com o conjunto novo, e ela ainda não existe.

O que dá para fazer sem execução é **calibrar o tamanho contra a única medição
que há** (`scripts/estimar-s.mjs`):

| passo | valor |
|---|---:|
| chars dos schemas das 7 ferramentas de 11/08 (commit `188159b`, reconstruído do git) | **3 124** |
| `r_schema = 3124 / 622` — chars de *schema* por token, calibrado | **5,023** |
| chars dos schemas das 6 ferramentas de hoje | **3 907** |
| **`S` estimado = 3907 / 5,023** | **778** |

Isso **não** é regra de três por contagem (`622 ÷ 7 × 6 = 533`). A regra de três
ignora que as descrições cresceram — daria 533 e estaria errada para baixo. A
calibração acompanha o texto real: o `Gerenciar Pedido` fundido tem 1 797 chars
de schema contra 723 do original.

**Continua sendo estimativa.** A forma como o n8n serializa o schema e como o
tokenizador o parte não é reproduzida, só aproximada pela calibração. Por isso
o gerador marca `medido: false` — a mesma marca que o básico (266) carrega
desde agosto. Sanidade: pelo mesmo `r_schema`, o básico daria 282; o 266 em uso
veio de regra de três e está a 6% disso.

**Como medir de verdade, com uma execução:** `r = 3,112` (chars/token de texto)
é conhecido, então uma execução real do perfil de vendas basta —
`S = tokens_n8n − chars_contados / r`. É o método do `estima-tokens.js`; a
primeira execução real depois do import resolve, e aí `medido: true`.

`PENDENCIA-S-DESATUALIZADO.md` continua aberta: o número em uso mudou de
"medido para 7, usado para 8" para "estimado para 6". Melhorou; não fechou.

## 9. Como medir se funcionou — e a assimetria que precisa estar escrita

**Por turno é inviável.** Base: 8 fabricações em 232 turnos medíveis = 3,4%.
Pela regra dos três, provar que a taxa caiu abaixo da base exigiria 87 turnos
limpos; metade da base, 176. O volume não existe — o `emporio` fez 8 turnos em
14 dias.

**Por conversa de carrinho multi-passo é barato:** a taxa base é 4 em 6 = 67%.

| conversas limpas | p contra a base de 67% | teto 95% da taxa nova |
|---:|---:|---:|
| 6 | 0,0013 | 39% |
| 8 | 0,0002 | 31% |
| 10 | 0,00002 | 26% |

**CRITÉRIO: 10 conversas multi-passo limpas, roteiro fixo, no
`estudyou-sendbox`.** Uma fabricação em 10 já é compatível com a taxa não ter
caído o suficiente — nesse caso o portão sobe de prioridade e a fusão fica como
economia.

"Limpa" é pelo **cruzamento texto × banco** — o texto afirma item, quantidade ou
total e existe linha correspondente em `pedidos`/`pedido_itens` —, **não** por
`chamadas`. E, pela §2, uma conversa em que `fechar` foi chamada sem
confirmação do cliente também não é limpa.

> **DUAS RESSALVAS, COM DESTAQUE:**
>
> 1. **o banco não guarda histórico de passos — só dá para contar multi-ITEM.**
>    Os 4 em 6 vêm de inspeção manual, e é essa a base sendo usada.
> 2. **SE FALHAR, DERRUBA; SE PASSAR, NÃO CONFIRMA NO MUNDO.** Um roteiro fixo
>    repetido 10 vezes mede a variabilidade do modelo naquele roteiro, não a
>    população de conversas reais. Sem esta frase, dez conversas limpas viram
>    "resolvido".

## 10. Estado da suíte, e o que ficou vermelho de propósito

`npm run teste`: **62 de 64.** Os dois vermelhos são os de antes — o nó `Aplica
Portao` carrega código mais velho que `n8n/aplica-portao.js` — e continuam
corretos pelo motivo da `ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md` §10. A fusão não
os tocou e não podia: rodar o injetor não estava autorizado.

`npm run n8n:sincronia`: **verde em tudo que é da fusão** — os dois wrappers
batem com os dois agents, cada agent tem exatamente as tools do seu perfil (o
oráculo do checker foi atualizado: é uma **segunda cópia de propósito**, e o
comentário dele agora diz isso). A única linha vermelha é a mesma do portão.

Duas coisas do repo que a fusão fez vir à tona e foram corrigidas:

- `tests/n8n-validar.mjs` afirmava `>= 9 arquivos` na pasta de workflows — a
  contagem de agosto. Ficou vermelho porque o repo **encolheu de propósito**.
  Passou a afirmar a propriedade ("existe o principal e ao menos uma tool");
- o mesmo teste usava `tool-fechar-pedido.json` como cobaia da regra 9.
  Repontado para a fundida, que tem a mesma forma.

## 11. O que **não** foi feito

- **nada importado** — os dois JSONs estão prontos, a ordem está na §7;
- **sub-agentes / `agentTool`**: analisado e recusado, não construído;
- **ferramenta de pagamento e portão**: não tocados. O injetor não rodou;
- **contratação**: `vendas` continua uma linha só;
- **migração**: nenhuma;
- **`alvo` no `cancelar`**: não adicionado (§6);
- **a frase do recital** no system message: mantida (§5, item 3).
