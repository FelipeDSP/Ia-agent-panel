# Investigação — por que a fabricação acontece AQUI

**Estado: INVESTIGAÇÃO. Nada foi construído.** Nenhuma migração, nenhum workflow,
nenhum prompt novo, nenhuma flag virada. O que existe aqui é medição contra
produção em 2026-09-09 e desenho de teste.

**A pergunta que este doc responde** não é *"acontece?"* — isso a
[`PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md`](PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md) já
mediu em oito ocorrências. É *"por que acontece nesta montagem?"*, porque disso
depende se o conserto é genérico (serve a qualquer capacidade de qualquer tenant)
ou específico de venda.

## O achado — o prompt pede o comportamento que produz o defeito

De tudo o que está medido aqui, é isto que vale mais, e não depende de nenhum
experimento para ser verdade. O system message do perfil de vendas diz, hoje, nas
duas ferramentas que escrevem pedido:

```
## Ferramenta: gerenciar_pedido
  ... Repita esse resumo ao cliente e confirme antes de fechar.

## Ferramenta: fechar_pedido
  ... Antes de chamar, repita os itens e o total e espere o "pode fechar".
```

*"Antes de chamar, repita os itens e o total"* é uma ordem para **produzir texto
no turno anterior à chamada da ferramenta**. E o texto que ela pede — a lista de
itens com o total — é, palavra por palavra, a forma da mensagem fabricada:

```
o prompt pede:      "repita os itens e o total"
o modelo produz:    "Só para confirmar, seu pedido ficou:
                     - 10 pães de queijo tradicionais — R$ 15,00
                     Total: R$ 15,00"
o banco tem:        nada
```

Essa frase aparece **três vezes** no histórico como fabricação, é a única que
**nenhum dos quatro detectores pega** (§6.2 da pendência), e foi a segunda das
três mensagens que o cliente do `emporio` recebeu em 08/09.

**O recital não é o modelo desobedecendo. É o modelo obedecendo.** A instrução
manda recitar o pedido antes de chamar a ferramenta; se o retorno da ferramenta
não estiver na mão — e no turno de confirmação ele não está, porque a chamada é
justamente o que não aconteceu —, o modelo recita de memória. Fez o que foi
mandado, com o único material que tinha.

Isso muda como se lê a frase que a pendência repete, *"prompt já é a solução que
falhou"*. Continua verdade que a **regra geral** (`## Regras gerais`: *"só afirme
que registrou depois de receber o retorno da ferramenta"*) falhou oito vezes. Mas
ela não estava só sendo ignorada: **estava sendo contrariada, no mesmo prompt, por
uma instrução mais específica e mais próxima da tarefa.** Uma regra geral abstrata
contra uma ordem concreta sobre o que escrever agora — e a ordem concreta ganhou.

Não é conserto e não substitui estrutura: tirar a frase não garante que a
ferramenta seja chamada. Mas é o único item desta investigação em que o sistema
**pede** o defeito, e por isso ele sai da fila de hipóteses e vira uma correção de
texto que se justifica sozinha, independentemente do que o experimento do modelo
disser. O texto está na §7.4; a ressalva de que ele é órfão e sem guarda, na §7.1.

---

## O que decidir ANTES de rodar qualquer teste

**O teste do modelo não vai dispensar estrutura. Ele decide se a estrutura é
portão ou injeção.**

Isso não é opinião sobre o resultado — é o teto aritmético do experimento, e vale
a pena estar no topo porque muda o que se conclui dele. Com **zero** fabricações
em `n` turnos de confirmação, o que fica descartado com 95 % de confiança é
`p ≥ 1 − 0,05^(1/n)`:

| turnos de confirmação, zero fabricação | descarta taxa ≥ |
|---:|---:|
| 13 | 20,6 % |
| 20 | 13,9 % |
| **40** | **7,2 %** |
| 60 | 4,9 % |
| 100 | 3,0 % |

Um experimento de 15 rodadas por braço rende ~45 turnos de confirmação. Se todos
saírem limpos, o que foi provado é **"no máximo ~7 %"** — uma fabricação a cada
catorze confirmações, num evento cujo desfecho é um cliente esperando uma
retirada que não existe. É três vezes melhor que os 21,7 % de hoje e continua
longe de "resolvido".

Chegar a "no máximo 3 %" exige **100 turnos de confirmação limpos**, ou seja
~33 rodadas por braço — o que é factível, custa cerca de US$ 5 no braço caro, e
é a escolha a fazer **agora**, não depois de ver 45 turnos verdes e sentir
vontade de parar. Declarar o `n` antes é o que separa medir de torcer.

O corolário prático: mesmo o melhor resultado possível deixa a estrutura em pé. O
que ele muda é qual — se a fabricação cair para a casa de poucos por cento, a
**injeção de estado** (§6) provavelmente basta; se ficar onde está, o **portão**
(§0 do outro doc) volta à mesa.

---

**O portão factual do [`DESENHO-PORTAO-VENDA-AFIRMADA.md`](DESENHO-PORTAO-VENDA-AFIRMADA.md)
continua desenhado e NÃO descartado.** Ele consulta `pedidos`, então é específico
de venda — e é por isso que faz sentido investigar a causa antes de construí-lo. Se
a causa for propriedade do modelo mesmo com montagem certa, ele volta, e volta
como **capacidade contratável por tenant**, não como exceção no fluxo único.

---

## 0. Antes de tudo: a contenção NÃO está aplicada

Medido em 2026-09-09 15:50 UTC, pela **query exata do nó `Tools Ativas`**, que é o
caminho que o agente percorre:

```sql
SELECT case when exists (
         select 1 from public.api_n8n_tools_ativas(<emporio>)
         where tool_nome = 'vendas'
       ) then 'vendas' else 'basico' end AS perfil;
-- ->  vendas
```

```
tenant_tools | emporio | vendas | ativo = true | contratado = true
```

**O `emporio` está rodando o perfil de vendas agora**, com as oito ferramentas e
com `gerenciar_pedido` e `fechar_pedido` na mesa. A alavanca escolhida é a certa —
`api_n8n_tools_ativas` filtra por `t.contratado and t.ativo`, então `ativo = false`
tira a tool do perfil e derruba o tenant para `basico` — mas **ela não foi
acionada**.

Não virei a flag: é escrita em produção no cadastro de um cliente real, e a
decisão já é sua; a execução também deveria ser. Mas a investigação abaixo parte
do princípio de que o agente **está vendendo neste minuto**, e isso muda a urgência
de tudo o que vem depois.

É a mesma família de deriva que este projeto já pagou três vezes: a Edge Function
que ficou dez dias fora do commit, o nome de migração fora do ledger, o
`responsesApiEnabled` que só existia na instância. **Decisão tomada não é decisão
aplicada, e o único jeito de saber é medir do lado que executa.**

---

## 1. O limite honesto desta investigação

Tudo o que segue sobre prompt, ferramentas e descrições foi lido de
`n8n/workflows/agente-principal.json` — **o repositório, não a instância**.

Esse projeto já foi mordido exatamente aí: em 18/08 descobriu-se por acaso que o
nó `OpenAI Chat Model` da instância roda com `responsesApiEnabled: true`, campo que
não existe no JSON versionado. `scripts/diff-n8n-instancia.mjs` existe para caçar
isso, e `npm run teste:diff-n8n` **testa a ferramenta de diff, não a instância** —
os 29 testes dele são sobre achatar chave aninhada e classificar tipo, não sobre o
n8n de verdade.

**Pré-requisito para agir sobre as hipóteses 2 e 4:** exportar o
`agente-principal` da UI e rodar

```
node scripts/diff-n8n-instancia.mjs --dir <pasta-do-export>
```

Se as descrições de ferramenta da instância divergirem das do repositório, a
análise da §5 é sobre o texto errado. A hipótese 1 não depende disso — `modelo` é
coluna do banco, lida em runtime pela expressão do nó.

---

## 2. Hipótese 1 — o modelo. O teste, isolado e primeiro

### O que os dados dizem hoje

| | |
|---|---|
| modelo em **todas** as 8 fabricações | `gpt-4.1-mini` |
| modelo em **todas** as 267 saídas humanas medíveis | `gpt-4.1-mini` |
| turnos em qualquer outro modelo, em todo o histórico | **zero** |

`clinica-teste` está configurado com `gpt-4.1` e **nunca teve tráfego**. Então a
hipótese está **totalmente desconfundida e totalmente por testar**: não há um único
turno de outro modelo para comparar. Nenhuma leitura do histórico pode confirmá-la
nem derrubá-la — só um experimento.

**E não custa código nenhum.** `MODELOS_PERMITIDOS` em `src/lib/tenants/schema.ts`
já traz `gpt-4.1-mini`, `gpt-4.1`, `gpt-4o-mini`, `gpt-4o`, `gpt-5`, `gpt-5-mini`;
o super admin troca pelo painel (`admin/tenants/[id]`), e o nó lê
`{{ $('Resolve Tenant').first().json.modelo }}` a cada execução. Trocar e reverter é
um `UPDATE` numa coluna, por tenant.

### O teste

**Tenant: `estudyou-sendbox`.** Interno, com `vendas` contratada e ativa, sem
cliente real na frente. **Não o `emporio`** — lá há um comerciante de verdade e a
tool deveria estar desligada.

**Braços: dois, e a comparação é lado a lado.**

| braço | modelo | por quê |
|---|---|---|
| controle | `gpt-4.1-mini` | é o de hoje |
| A | `gpt-4.1` | **isola uma variável só: o tier.** Mesma família, mesma geração |

`gpt-5-mini` fica como braço opcional depois: ele muda geração **e** tier ao mesmo
tempo, então um resultado bom não diria qual dos dois resolveu. E a família 5 tem
raciocínio, o que mexe em latência e em tokens de saída — variável nova num agente
de WhatsApp com debounce de 3 s.

**Rodar o controle no mesmo dia, alternado com o braço A.** Comparar contra a taxa
histórica de 21,7 % seria comparar com conversas diferentes, escritas por outra
pessoa, num mês diferente. O controle é o que torna a comparação uma comparação.

**Roteiro: reproduzir a FORMA que falha, não conversar à toa.** A §7.2 da pendência
mediu onde a fabricação mora — turno de confirmação depois de carrinho de vários
passos —, e 124 turnos de conteúdo novo produziram **uma** fabricação. Conversar
sobre produto não testa nada. O roteiro é o do caso real do sendbox de 08/09:

```
1. "oi"
2. "quero 3 treinamentos de NR 01"        <- conteúdo (monta carrinho)
3. "pode fechar o pedido"                 <- CONFIRMAÇÃO
4. "retirada"                             <- CONFIRMAÇÃO   (fabricou em 08/09)
5. "quero também o treinamento de NR 06"  <- conteúdo (segundo passo no carrinho)
6. "sim"                                  <- CONFIRMAÇÃO   (fabricou em 08/09)
```

≈ 3 turnos de confirmação por rodada. **15 rodadas por braço ≈ 45 turnos de
confirmação.**

### O critério de sucesso, medido

O instrumento já existe e é exato: `chamadas` do `mensagens_log` mais o estado de
`pedidos`/`pedido_itens`. Para cada saída do roteiro, duas perguntas:

1. a mensagem **afirma** escrita (detector textual D1 ∪ recitação)?
2. o banco **tem** o que ela afirma (existe pedido, e o total bate)?

É a mesma medição da §1 do `DESENHO-PORTAO-VENDA-AFIRMADA.md`, aplicada a um corpus
roteirizado em vez do histórico. "Pareceu melhor" não entra.

**E o critério é declarado ANTES de rodar**, porque zero evento em amostra pequena
prova menos do que parece. A tabela e o que ela implica estão no topo deste doc
("O que decidir ANTES de rodar qualquer teste") — é de lá que sai o `n` do
experimento, e ele precisa ser escolhido antes da primeira rodada.

Se aparecer **uma** fabricação no braço A, a hipótese está respondida na hora: o
tier não resolve, e as outras três deixam de ser melhoria e voltam a ser conserto.

### O custo

Medido em produção (média por **turno**, perfil de vendas, `chamadas` médio 1,56):

| | entrada | saída |
|---|---:|---:|
| `emporio` (128 turnos) | 6 230 | 54 |
| `estudyou-sendbox` (45 turnos) | 10 150 | 50 |

Com preço de tabela por 1 M de tokens — **e este é o número a conferir contra a
fatura, porque `PENDENCIA-FATURA-OPENAI.md` registra que nenhuma tabela de preço
foi validada neste projeto**:

| modelo | entrada | saída | custo/turno no `emporio` | × hoje |
|---|---:|---:|---:|---:|
| `gpt-4.1-mini` (hoje) | 0,40 | 1,60 | **US$ 0,00258** | 1,0× |
| `gpt-4.1` | 2,00 | 8,00 | **US$ 0,01289** | **5,0×** |
| `gpt-5-mini` | 0,25 | 2,00 | US$ 0,00167 | 0,65× |
| `gpt-5` | 1,25 | 10,00 | US$ 0,00833 | 3,2× |

A conta é `entrada × preço_in + saída × preço_out`; com a medição ao lado, dá para
recomputar com o preço certo quando a fatura confirmar.

**Custo do experimento:** 15 rodadas × 6 turnos × 2 braços = 180 turnos no
`sendbox`. ≈ **US$ 0,37** no braço de controle e ≈ **US$ 1,86** no braço `gpt-4.1`.
**O experimento inteiro custa cerca de US$ 2 a 3.** É por isso que ele vem primeiro:
é mais barato que a reunião para decidir se vale fazê-lo.

**Custo em produção, se a troca virar padrão:** ao volume de hoje (10 a 35 saídas
por dia) o tenant sai de ~US$ 2,30 para ~US$ 11,60 por mês. Irrelevante hoje;
relevante no dia em que um tenant fizer 1 000 turnos/dia (US$ 2,58 → US$ 12,89 por
dia). **E para o SaaS a alavanca maior nem é essa:** a entrada é dominada por
`system_prompt` + schema de ferramentas, que são quase idênticos a cada chamada.
Isso é exatamente o caso de uso de cache de prompt, que o projeto não usa hoje.
Cortar o preço da entrada rende mais que escolher modelo — e é ortogonal a esta
investigação.

### O que quem rodar precisa saber para não quebrar a suíte

Cada rodada cria `pedidos` no `sendbox`. Deixar pedido vivo lá **derruba três
testes** — `teste:acl-secdef`, `teste:migracao-pedido-novo` e `teste:migracao-vendas`
—, que replayam o rollback da migração 55 e reprovam com dois pedidos vivos na mesma
conversa. Foi o que aconteceu em 08/09. Existe helper para arranjar o estado
(`tests/lib/pedidos-vivos-55.mjs`), mas a limpeza do experimento tem de ser
**escopada por tenant**, como manda a nota de `deletes-escopados`.

---

## 3. Hipótese 2 — oito ferramentas no perfil de vendas

### O que dá para medir hoje

O perfil de vendas carrega **8**: `busca_conhecimento`, `transferir_humano`,
`resolver_conversa`, `consultar_catalogo`, `gerenciar_pedido`, `fechar_pedido`,
`cancelar_pedido`, `enviar_foto_produto`. O básico carrega 3.

O custo em tokens está medido e é **pequeno**:

- `S = 622` tokens de schema **por chamada ao modelo** (constante medida pelo método
  das duas equações, em `scripts/gerar-principal.mjs`);
- a `chamadas` média é 1,56 → **≈ 970 tokens por turno**, que é o que a coluna
  `tokens_schema_tools` mostra (972 no `emporio`, 995 no `sendbox`);
- ≈ **78 tokens por ferramenta por chamada**.

Fundir `fechar_pedido` e `cancelar_pedido` dentro de `gerenciar_pedido` (que já tem
`acao=adicionar|remover|ver`) levaria 8 → 6: **−156 tokens por chamada, −243 por
turno, 3,9 % da entrada, US$ 0,0001 por turno.** O argumento de custo desta hipótese
**não existe**. O que sobra é o argumento de escolha, e ele não é mensurável no
histórico — não há contrafactual. Só o mesmo experimento da §2, com um braço a mais.

**E a fusão brigaria com a hipótese 4.** Juntar as três escritas num verbo só torna
a ferramenta ainda mais parecida com uma API e ainda mais pobre em "quando chamar" —
que é justamente o defeito da §5. As duas hipóteses puxam para lados opostos; testar
as duas juntas não diria qual delas mexeu o ponteiro.

### O achado que apareceu no caminho, e vale por si

**O conjunto de ferramentas é por PERFIL, não por CONTRATAÇÃO.**

```js
// scripts/gerar-principal.mjs
const TOOLS_VENDAS = ['Consultar Catalogo','Gerenciar Pedido','Fechar Pedido',
                      'Cancelar Pedido','Enviar Foto do Produto'];
```

`Enviar Foto do Produto` é pendurada em **todo** tenant com `vendas`, tenha ele
`foto_produto` contratada ou não. Hoje não há divergência viva — os quatro tenants
com `vendas` têm `foto_produto` contratada —, e **não é vazamento**:
`api_n8n_enviar_foto` confere `tt.ativo and tt.contratado` e recusa. Mas o tenant
que comprar `vendas` sem `foto_produto` vai receber um agente com uma ferramenta a
mais na mesa, pagando o schema dela e podendo escolhê-la para levar uma recusa.

É a regra de superfície de tool do `CLAUDE.md` numa superfície que a regra não
nomeia: *"toda superfície que uma tool traz só existe para quem contratou aquela
tool"* — a lista de ferramentas do agente é uma superfície, e ela hoje é derivada do
perfil. Não é urgente e não é incidente; é o tipo de coisa que fica errada em
silêncio até o primeiro tenant com a combinação nova.

**Segundo achado, menor:** `S = 622` foi medido quando o perfil tinha **7**
ferramentas (o comentário do gerador diz isso: *"622, ~89 por tool"*). Hoje são 8.
O rateio de custo subestima o perfil de vendas em ~1 ferramenta desde que a foto
entrou.

---

## 4. Hipótese 3 — o debounce entrega turno isolado

**Confirmada como mecanismo e FALSIFICADA como explicação.** É a que eu descartaria
primeiro, e o motivo é o mesmo pelo qual a §7.2 da pendência descartou o "segundo
eixo": **um constante não explica um variável.**

### O mecanismo é exatamente o descrito

O agente recebe, no lugar do turno humano:

```js
// AI Agent Vendas, parâmetro `text`
"={{ ($('Lista Depois').first().json.lista_depois || []).join('\\n') }}"
```

— ou seja, só as mensagens **do cliente** acumuladas na janela de debounce. A
pergunta que as originou não vem junto; o histórico vem por outro caminho, o
`Redis Chat Memory` (`contextWindowLength: 20`, `sessionTTL: 2400`).

E dá para conferir turno a turno sem abrir o n8n: o `Registra Mensagem` grava
`$('Lista Depois').first().json.lista_depois` como o `conteudo` da linha de
**entrada**. Então `mensagens_log` guarda **exatamente o que o agente recebeu**.

### A medição que derruba a hipótese

| mensagens agrupadas pelo debounce | turnos |
|---:|---:|
| 1 | **311** |
| 2 | 6 |

**98 % dos turnos chegam isolados** — inclusive os 4 turnos de confirmação que
**chamaram a ferramenta corretamente**, e inclusive os 124 turnos de conteúdo novo
cuja taxa de fabricação é 0,8 %. Nos três turnos do `emporio` de 08/09 o agente
recebeu, um por vez: `{"10 unidades"}`, `{"Isso somente"}`, `{"Nao somente issob"}`.
E nos turnos que acertaram, a mesma coisa.

O isolamento é a forma normal de funcionamento do fluxo, não a marca dos turnos que
falham. Ele não discrimina nada.

### O que sobrevive, e é o que importa

O isolamento não **causa** a fabricação, mas define **de onde** o modelo tira o
estado: a única fonte de contexto anterior é a memória do Redis. Isso é o que torna
a injeção de estado (§6) valiosa — não como conserto do debounce, mas porque hoje o
carrinho só existe na cabeça do modelo, e o que está na cabeça dele pode estar
errado sem nada acusar.

Dois detalhes medidos que vale registrar:

- **o `sessionTTL: 2400` (40 min) está no JSON do repositório**, e a memória do
  projeto registra que o gerador **não gera esse campo** — ele sobrevive por ser
  posto à mão no arquivo. Se está na instância, não foi verificado (§1);
- **para o caso do `emporio` de 08/09 a memória não explica nada.** A conversa 18
  não falava desde 21/08 — 18 dias. Com TTL de 40 min ou mesmo de 2 h, a chave já
  tinha expirado, e a saudação de 18:08:55 é de conversa nova, sem menção ao pedido
  de agosto. **A fabricação de 08/09 aconteceu com memória limpa**, o que é a
  contraprova do experimento da §2.4 da pendência e mais uma razão para não tratar
  a memória envenenada como causa raiz.

---

## 5. Hipótese 4 — as descrições dizem O QUE, não QUANDO

**É a hipótese com a evidência estrutural mais forte, e a única que casa com o
recorte que os dados já mostraram: leitura funciona, escrita fabrica.**

### A assimetria, tabulada

| ferramenta | tipo | cláusula de QUANDO | natureza |
|---|---|---|---|
| `busca_conhecimento` | **leitura** | *"Use **SEMPRE** que o cliente fizer uma pergunta sobre o negócio"* | **obrigação** |
| `consultar_catalogo` | **leitura** | *"Use **SEMPRE** antes de falar preço ou oferecer item"* | **obrigação** |
| `gerenciar_pedido` | **escrita** | — **nenhuma** — | **ausente** |
| `fechar_pedido` | **escrita** | *"Use **SOMENTE** após o cliente confirmar"* | restrição |
| `cancelar_pedido` | **escrita** | *"Confirme com o cliente **antes**"* | restrição |
| `enviar_foto_produto` | envio | *"Use **só** quando o cliente pedir"* | restrição |
| `transferir_humano` | ação | *"Use quando o cliente solicitar explicitamente"* | obrigação condicional |
| `resolver_conversa` | ação | *"Use quando o cliente se despedir"* + *"Nunca finalize no meio"* | obrigação + restrição |

**2 de 2 ferramentas de leitura têm obrigação afirmativa. 0 de 3 ferramentas de
pedido têm.** E o recorte medido na §7.2 da pendência é exatamente esse: no
`emporio` de 08/09, o turno de consulta chamou a ferramenta (`chamadas = 2`) e
acertou o preço; os três turnos de escrita não chamaram nada.

As duas ferramentas cuja descrição diz *"você DEVE"* são as que são chamadas. As
três cuja descrição diz apenas *"não faça a menos que"* são as que são narradas.

### O agravante, e é o achado deste doc

Não é só que falte a obrigação. **O system message manda ativamente escrever o
recital, que é a forma exata da mensagem fabricada.**

```
## Ferramenta: gerenciar_pedido
  ... A ferramenta SEMPRE devolve o pedido inteiro com o total.
      Repita esse resumo ao cliente e confirme antes de fechar.

## Ferramenta: fechar_pedido
  Use SOMENTE quando o cliente confirmar explicitamente que o pedido está completo.
      Antes de chamar, repita os itens e o total e espere o "pode fechar".
```

*"Antes de chamar, repita os itens e o total"* é uma instrução para **produzir
texto** no turno anterior à chamada. E o texto que ela pede — a lista de itens com o
total — é literalmente a mensagem que fabrica:

```
"Só para confirmar, seu pedido ficou: - 10 pães de queijo — R$ 15,00  Total: R$ 15,00"
```

Essa frase é a que **nenhum dos quatro detectores pega** (§6.2 da pendência) e é a
que aparece três vezes no histórico como fabricação. O prompt pede o recital; se o
retorno da ferramenta não estiver na mão, o modelo produz o recital do mesmo jeito —
de memória. **A instrução que deveria preceder a chamada compete com ela.**

E no turno de confirmação a assimetria fica no pior arranjo possível: o cliente
acabou de dizer "sim"/"retirada", a condição de `fechar_pedido` acabou de ser
satisfeita, e a única frase que o modelo lê sobre aquela ferramenta é redigida como
**portaria** (*"SOMENTE quando..."*), nunca como **gatilho** (*"quando isso
acontecer, chame"*). A obrigação afirmativa existe — mas mora nas "Regras gerais",
que é o texto mais distante da decisão.

### A redação alternativa

O padrão a copiar é o das duas que funcionam: verbo no imperativo, ligado a um
**evento do cliente**, com o "antes de responder" explícito.

```
gerenciar_pedido
  hoje:  "Monta o pedido do cliente. acao=adicionar... Devolve sempre o pedido inteiro."
  vira:  "SEMPRE que o cliente disser o que quer, ou mudar quantidade, ou pedir para
          tirar item, chame esta ferramenta ANTES de responder. Nunca descreva o
          pedido de memória: o texto do pedido é o que ESTA ferramenta devolveu."

fechar_pedido
  hoje:  "Use SOMENTE apos o cliente confirmar que o pedido esta completo."
  vira:  "SEMPRE que o cliente confirmar que quer fechar ('pode fechar', 'sim',
          'só isso', 'retirada'), chame esta ferramenta ANTES de responder. Só ela
          fecha o pedido; dizer que fechou sem chamá-la é erro. Se ele ainda não
          confirmou, não chame."
```

E o par no system message: trocar *"Antes de chamar, repita os itens e o total"* por
*"Para repetir os itens e o total, use o retorno de `gerenciar_pedido` com
`acao=ver`; nunca de memória."* — o caminho de leitura já existe (a própria seção o
menciona como exceção) e passaria a ser a regra.

### A ressalva, que é a mesma de sempre

**Isto continua sendo prompt, e prompt falhou oito vezes.** Vale a distinção, mas
sem exagerá-la: o que falhou foi uma **regra geral**, longe da decisão. O que ainda
não foi tentado é a **obrigação na descrição da ferramenta**, que é o texto que o
modelo lê no momento de escolher, e que nas duas ferramentas onde existe está
associado ao comportamento certo em 100 % dos casos medidos.

Isso é **melhoria de probabilidade, não conserto**. Não fecha nada, não é
verificável por construção, e não sobrevive sozinho a um modelo que resolva
diferente amanhã. Vale porque é barato — zero token a mais, uma regeração — e porque
é a única das quatro que ataca o momento exato da falha.

---

## 6. A injeção de estado — o que é de graça e o que não é

### O que já é de graça

**O ponto de injeção existe e já é uma expressão.** O system message dos dois agents
termina com

```
# PERSONALIDADE E CONTEXTO DO NEGÓCIO
{{ $('Resolve Tenant').first().json.system_prompt }}
```

Acrescentar `{{ $('Tools Ativas').first().json.estado }}` ali é uma linha no gerador.
Nenhum nó novo, nenhuma mudança de topologia.

**E o nó que hospeda a leitura também existe.** O `Tools Ativas` é um nó Postgres que
roda no caminho único, **imediatamente antes** do `Vende?` e dos agents, uma vez por
turno, e o `Estima Tokens` já o lê por nome. Acrescentar uma coluna ao `SELECT` dele
é uma linha.

Custo em tokens: uma linha como `carrinho: 3 itens, R$ 209,70 (rascunho)` são ~25
tokens, × `chamadas` (1,56) ≈ **40 tokens por turno**, 0,6 % da entrada,
US$ 0,00002 por turno. **Desprezível.**

### O que não é de graça

**A leitura.** Medido:

```
has_table_privilege('n8n_agent','public.pedidos','select')      -> false
has_table_privilege('n8n_agent','public.pedido_itens','select') -> false
rolbypassrls do n8n_agent                                       -> false
```

O `n8n_agent` não lê as tabelas. Toda leitura passa por `SECURITY DEFINER` com grant
explícito. E as funções que existem hoje **escrevem**: `api_n8n_ver_pedido` e
`api_n8n_tem_pedido_pendente` chamam `expirar_pedidos_vencidos` por dentro, o que
mudaria `status` e carimbaria `atualizado_em` a cada mensagem enviada.

Então a injeção precisa de **uma função nova, `stable`, sem expiração** — com a
família 28/32/37/40/41 junto: `revoke` antes do `grant`, grant nos dois roles
(`service_role` **e** `n8n_agent`), e `npm run teste:grants-n8n` para provar.

### O que isso muda no desenho todo

**É a mesma função que o portão factual precisa.** A injeção (prevenção, antes do
agente) e o portão (detecção, depois dele) não são desenhos concorrentes: são dois
consumidores da mesma leitura. Construir a leitura uma vez resolve a parte cara dos
dois, e aí a escolha entre injetar, barrar ou os dois deixa de ser uma escolha de
arquitetura e vira uma de configuração.

### E é a única das cinco que generaliza

O portão factual consulta `pedidos` e por isso é específico de venda. A injeção não
precisa ser: o formato que generaliza é **uma função que devolve texto, montado a
partir das capacidades que aquele tenant contratou**.

```
api_n8n_estado_conversa(tenant_id, conversation_id) -> text
    vendas contratada        ->  "Carrinho: 3x Treinamento NR 01 — R$ 209,70 (rascunho)"
    agendamento contratada   ->  "Próximo horário marcado: 12/09 14h"
    <capacidade futura>      ->  a linha dela
    nada contratado          ->  ''  (e a injeção some do prompt)
```

O workflow continua **único e genérico**: um nó, uma expressão, nenhuma exceção por
capacidade. O que é específico de cada capacidade vive em SQL, atrás de uma função,
e **quem contribui é decidido pela contratação** — que é exatamente onde o
`CLAUDE.md` já manda essa decisão morar.

É a diferença entre "cada capacidade nova precisa do seu portão no fluxo" e "cada
capacidade nova acrescenta um `case` numa função". A segunda é a que sustenta o SaaS.

**O que ela não faz:** não impede o modelo de afirmar o que quiser. Injetar o estado
tira o *motivo* de inventar (ele não precisa mais lembrar); não tira a
*possibilidade*. Por isso ela é a prevenção e o portão continua sendo a garantia —
e por isso o portão não está descartado.
## 7. A redação alternativa, escrita — as quatro ferramentas de escrita

**Não aplicada.** É texto para ler antes de decidir. A §5 argumenta por que; esta
seção é o "o quê", mais o mapa de onde cada string mora — que, ao ser levantado,
virou o achado mais prático desta seção.

### 7.1 Onde cada texto mora, e por que isso decide como editar

Levantado no gerador e no JSON. **As oito descrições não têm o mesmo dono, e as
duas metades falham de jeitos opostos.**

| string | dono | editar onde | o que acontece se errar o lado |
|---|---|---|---|
| `description` de `Enviar Foto do Produto` | **o gerador** (`gerar-principal.mjs` recria o nó inteiro a cada rodada) | `scripts/gerar-principal.mjs` | editar no JSON: **some na próxima geração** |
| seção `## Ferramenta: enviar_foto_produto` do system message | **o gerador** (`SECAO_FOTO` + `comSecaoFoto`, idempotente) | `scripts/gerar-principal.mjs` | idem |
| bullets de `## Regras gerais` | **o gerador** (`REGRAS_TODOS` / `REGRAS_BASICO`) | `scripts/gerar-principal.mjs` | idem, **e pior**: ver 9.4 |
| `description` das outras **7** ferramentas | **ninguém** — campo órfão | `n8n/workflows/agente-principal.json` | editar no gerador: não há linha para editar |
| seções `## Ferramenta:` das outras 7 | **ninguém** — campo órfão | `n8n/workflows/agente-principal.json` | idem |

**Três das quatro ferramentas desta seção estão do lado órfão; uma está do lado
do gerador.** É a `PENDENCIA-GERADOR-CAMPO-ORFAO.md` batendo exatamente onde este
trabalho encosta: o gerador **lê o próprio arquivo de saída e o muta**, então
campo que ele não seta sobrevive a todas as gerações, nunca aparece no gerador, e
o `n8n:sincronia` não o pega porque compara o **wrapper** com o gerador, não o
workflow inteiro.

E há um agravante medido aqui: **nem `scripts/n8n-validar.mjs` nem
`scripts/conferir-sincronia-wrapper.mjs` mencionam `description` uma única vez.**
As sete descrições órfãs não têm guarda nenhuma — não há sabotagem possível no
estilo "tira a linha do gerador e regera", porque não existe linha. A única
verificação honesta é o **diff da instância** (§1), e é mais uma razão para o
passo 2 da ordem vir antes deste.

### 7.2 O padrão a copiar

Das duas ferramentas de leitura que funcionam, a forma tem **três partes**:

```
[1 o que faz e o que devolve]  [2 Use SEMPRE <evento do cliente>, ANTES de responder]  [3 a proibição correspondente]

busca_conhecimento:  "Busca informações sobre serviços, produtos, preços...
                      Use SEMPRE que o cliente fizer uma pergunta sobre o negócio."
consultar_catalogo:  "Consulta o catálogo e devolve produtos com preço, unidade e id.
                      Use SEMPRE antes de falar preço ou oferecer item. Nunca invente valores."
```

A parte 2 é a que falta nas quatro de escrita, e a parte 3 delas hoje ou não
existe ou proíbe a coisa errada (proíbe **chamar cedo demais**, nunca proíbe
**afirmar sem chamar**).

Duas escolhas de redação que não são estilo:

- **os gatilhos vêm do vocabulário medido, não de exemplos inventados.** As cinco
  fabricações em turno de confirmação foram disparadas por *"sim"*, *"retirada"*,
  *"só isso"*, *"isso somente"*, *"não entendi"* (§7.2 da pendência). São essas as
  palavras que entram na cláusula;
- **cada uma ganha a frase "só esta ferramenta faz X; dizer que fez sem o retorno
  dela é erro"** — que é a regra geral que já existe em `## Regras gerais`,
  trazida para onde o modelo lê na hora de decidir. Não é duplicação inútil: a
  versão distante falhou oito vezes, e a hipótese inteira é que a posição importa.

### 7.3 As quatro, antes e depois

#### `gerenciar_pedido` — a que hoje não tem cláusula nenhuma

```
HOJE
  Monta o pedido do cliente. acao=adicionar (com produto_id, quantidade e
  observacao), acao=remover (com produto_id) ou acao=ver. Devolve sempre o pedido
  inteiro com o total ja calculado.

PROPOSTO
  Monta e le o pedido do cliente. acao=adicionar (produto_id, quantidade,
  observacao), acao=remover (produto_id), acao=ver (so consulta, nao altera).
  Devolve SEMPRE o pedido inteiro com o total ja calculado.
  Use SEMPRE, ANTES de responder, que o cliente disser o que quer, mudar
  quantidade ou mandar tirar item — e use acao=ver ANTES de repetir o pedido para
  ele.
  O texto do pedido e o que ESTA ferramenta devolveu: nunca descreva itens nem
  total de memoria.
```

O `acao=ver` sai de nota de rodapé e vira o caminho normal para recitar. Hoje ele
é mencionado uma vez, no system message, como exceção (*"se o cliente só perguntou
o valor"*).

#### `fechar_pedido` — a que hoje só tem portaria

```
HOJE
  Fecha o pedido em aberto e devolve o numero e o resumo. Use SOMENTE apos o
  cliente confirmar que o pedido esta completo. Depois de fechado nao aceita
  alteracao.

PROPOSTO
  Fecha o pedido em aberto e devolve o numero e o resumo.
  Use SEMPRE, ANTES de responder, que o cliente confirmar que quer fechar —
  "pode fechar", "sim", "so isso", "isso mesmo", ou dizendo a forma de retirada
  ou entrega. Se ele ainda nao confirmou, nao use.
  So esta ferramenta fecha: dizer que o pedido esta fechado, confirmado ou
  finalizado sem o retorno dela e erro. Depois de fechado nao aceita alteracao.
```

A restrição **não sai** — vira a segunda frase (*"se ainda não confirmou, não
use"*). O que muda é que ela deixa de ser a única coisa dita. E as três palavras
que a fabricação usou para fechar pedido que não existe — *fechado*, *confirmado*,
*finalizado* — passam a estar nomeadas na proibição.

#### `cancelar_pedido` — e aqui entra a §9 da pendência

```
HOJE
  Cancela o pedido em aberto e libera a conversa para um novo. Confirme com o
  cliente antes: o carrinho e perdido.

PROPOSTO
  Cancela o pedido em aberto e libera a conversa para um novo.
  Use SEMPRE, ANTES de responder, que o cliente desistir ou mandar recomecar E ja
  tiver confirmado que pode perder o carrinho — pergunte primeiro, o carrinho nao
  volta.
  Se ele quer COMPRAR MAIS depois de um pedido fechado, isso e pedido novo: NAO
  cancele o anterior.
  So esta ferramenta cancela: dizer que cancelou sem o retorno dela e erro.
```

A terceira frase é a §9 da pendência (*"o que a recusa deveria dizer"*) migrada
para onde ela é lida: a mensagem de recusa do `fechar_pedido` dizia *"é preciso
cancelar e refazer"*, e seguir aquilo **destrói uma venda já feita**. A migração 55
tirou o beco; a frase que empurrava para ele ainda está no fluxo.

#### `enviar_foto_produto` — a única do lado do gerador

```
HOJE
  Envia a foto de UM produto do catalogo ao cliente, com legenda. Use so quando o
  cliente pedir para ver o item. Uma foto por vez.

PROPOSTO
  Envia a foto de UM produto do catalogo ao cliente, com legenda, numa mensagem so.
  Use SEMPRE, ANTES de responder, que o cliente pedir para ver o produto
  ("manda foto", "tem foto", "como e").
  Uma por vez: se ele pedir de varios, mande a do primeiro e pergunte se quer as
  outras. Nao ofereca foto por conta propria.
  So esta ferramenta envia: dizer que enviou a foto sem o retorno dela e erro.
```

`Nao ofereca foto por conta propria` **fica**: aqui a restrição é sobre o agente
não puxar assunto, não sobre esperar confirmação — é de outra natureza que a do
`fechar_pedido` e não conflita com o gatilho afirmativo.

### 7.4 O par no system message — e é aqui que está o achado da §5

A descrição da ferramenta é o que o modelo lê ao decidir; o system message é onde
mora a instrução que **compete** com a decisão. Mexer só na descrição deixa a
competição de pé.

```
## Ferramenta: gerenciar_pedido
HOJE      A ferramenta SEMPRE devolve o pedido inteiro com o total. Repita esse
          resumo ao cliente e confirme antes de fechar. O total vem calculado —
          nunca some você mesmo.

PROPOSTO  A ferramenta SEMPRE devolve o pedido inteiro com o total. Repita ao
          cliente O RESUMO QUE ELA ACABOU DE DEVOLVER. Se você não chamou a
          ferramenta neste turno, chame com `acao=ver` antes de repetir — nunca
          monte o resumo de memória. O total vem calculado — nunca some você mesmo.

## Ferramenta: fechar_pedido
HOJE      Use SOMENTE quando o cliente confirmar explicitamente que o pedido está
          completo. Antes de chamar, repita os itens e o total e espere o "pode
          fechar".

PROPOSTO  SEMPRE que o cliente confirmar que quer fechar — "pode fechar", "sim",
          "só isso", "retirada", "entrega" —, chame esta ferramenta ANTES de
          responder. Para repetir os itens e o total antes de ele confirmar, use
          `gerenciar_pedido` com `acao=ver`; nunca de memória. Se ele só perguntou
          o valor, também é `acao=ver`.
```

**`Antes de chamar, repita os itens e o total` é a frase que sai, e é a razão de
toda esta seção existir.** Ela manda produzir texto no turno anterior à chamada, e
o texto que ela pede — a lista de itens com o total — é literalmente a forma da
mensagem fabricada:

```
"Só para confirmar, seu pedido ficou: - 10 pães de queijo — R$ 15,00  Total: R$ 15,00"
```

que aparece três vezes no histórico como fabricação e que **nenhum dos quatro
detectores pega** (§6.2 da pendência). O prompt pede o recital; sem retorno de
ferramenta na mão, o modelo o produz de memória.

**Duas armadilhas para quem for aplicar, e as duas já morderam este projeto:**

1. **Não ponha nada disto em `## Regras gerais`.** O gerador separa os perfis por
   `RE_SECOES_VENDAS = /## Ferramenta: consultar_catalogo[\s\S]*?(?=## Regras gerais)/`,
   e a única guarda é `if (WRAPPERS.basico.includes('consultar_catalogo')) throw`.
   Texto de venda posto fora daquele bloco **vaza para o perfil básico em
   silêncio**, e a guarda só conhece uma das cinco ferramentas de venda. Tudo o
   que é de venda tem de ficar entre `## Ferramenta: consultar_catalogo` e
   `## Regras gerais`.
2. **Se um dia mexer nos bullets de `## Regras gerais`, o primeiro trecho da
   versão ANTIGA vai para `MARCADORES_REGRAS`.** Sem isso a rodada seguinte deixa
   as duas versões no prompt — aconteceu em 12/08 e cobrou token duplicado de todo
   tenant. O gerador já checa idempotência e duplicata, mas só dos marcadores que
   conhece.

### 7.5 O que isto custa — medido, e não é zero

A descrição da ferramenta viaja no schema, então entra em `S` (tokens de
ferramenta por chamada). Com `CHARS_POR_TOKEN = 3.11`, a constante do
`n8n/estima-tokens.js`:

| ferramenta | hoje | proposto | delta |
|---|---:|---:|---:|
| `gerenciar_pedido` | 60 | 147 | +87 |
| `fechar_pedido` | 52 | 131 | +79 |
| `cancelar_pedido` | 37 | 129 | +92 |
| `enviar_foto_produto` | 42 | 126 | +84 |
| **total** | **191** | **533** | **+342 / chamada** |

- **+534 tokens por turno** (`chamadas` médio 1,56);
- **8,6 %** da entrada média do `emporio` (6 230);
- **+US$ 0,0002 por turno** em `gpt-4.1-mini`;
- **`S` sai de 622 e vai para ~964**, e `S = 622` é **constante medida** — precisa
  ser **re-medida** depois da mudança, pelo método das duas equações que o gerador
  descreve. É a mesma disciplina do tamanho de chunk e do recall: mexeu no que foi
  medido, mede de novo.

**E há uma tensão que vale dizer de frente:** a §3 estuda **reduzir** ferramentas
para diminuir erro de escolha, e o ganho lá seria de −156 tokens por chamada.
Esta redação **acrescenta 342** — mais que o dobro do que aquela economizaria. Em
dinheiro é irrelevante nos dois casos; em "quantidade de texto competindo pela
atenção do modelo", as duas hipóteses puxam para lados opostos. **É mais uma razão
para não rodar os dois braços juntos:** se rodarem, um resultado bom não diz qual
das duas mexeu o ponteiro.

### 7.6 A ressalva, sem suavizar

**Isto continua sendo prompt, e prompt falhou oito vezes.** A distinção que
sustenta tentar de novo é de **posição**, não de conteúdo: o que falhou foi uma
regra geral em `## Regras gerais`, longe da decisão; o que nunca foi tentado é a
obrigação **na descrição da ferramenta**, que é onde as duas de leitura têm a
delas e onde elas acertam em 100 % dos casos medidos.

É melhoria de probabilidade. Não é verificável por construção, não sobrevive
sozinha a um modelo que resolva diferente amanhã, e **não substitui** nem a
injeção de estado (§6) nem o portão. Vale porque é barata, porque ataca o momento
exato da falha, e porque é testável no mesmo arnês do experimento do modelo — como
um braço próprio, nunca no mesmo braço.

---

## 8. A foto pendurada em todo tenant com vendas — o que eu faria

### O que é, exatamente

```js
// scripts/gerar-principal.mjs
const TOOLS_VENDAS = ['Consultar Catalogo','Gerenciar Pedido','Fechar Pedido',
                      'Cancelar Pedido','Enviar Foto do Produto'];
```

O conjunto de ferramentas é do **perfil**, e o perfil é resolvido por uma pergunta
só: *o tenant tem `vendas`?* `foto_produto` é contratada à parte
(`contratavel: true` no registry) e **não participa dessa decisão**. Quem tem
vendas recebe a ferramenta de foto, tenha comprado a foto ou não.

### O que eu NÃO faria: tratar como incidente

Não é vazamento, e vale ser preciso sobre por quê — medido:

```sql
-- api_n8n_enviar_foto, primeiras linhas depois do assert de tenant
select coalesce(tt.ativo and tt.contratado, false), ... into v_ativa, ...
```

A função **confere contratação e recusa**. O `CLAUDE.md` já diz que é assim que
tem de ser: *"esconder não é o mesmo que não poder"* — a lista de ferramentas é o
menu, e o menu nunca foi a fronteira; a fronteira é a função, e ela está de pé.

Então o que existe aqui **não é furo de isolamento**. É duas coisas menores e
reais:

- **custo**: ~78 tokens de schema por chamada, ~122 por turno, pagos por um tenant
  que não comprou o módulo;
- **qualidade de escolha**: uma ferramenta a mais na mesa para o modelo escolher
  errado — e a §5 inteira é sobre o modelo escolher errado. Ele pode chamar a foto,
  levar a recusa, e narrar o resultado da recusa como se tivesse enviado, que é a
  modalidade C aplicada a outra ferramenta.

Hoje **não há divergência viva**: os quatro tenants com `vendas` têm
`foto_produto` contratada. É por isso que isto é dívida, não incêndio — e é
exatamente o tipo de coisa que fica certa por coincidência até o primeiro cliente
com a combinação nova.

### O que eu NÃO faria: um perfil por combinação

O caminho óbvio é `vendas_sem_foto`. Ele não escala: o n8n liga ferramenta ao
agente **estaticamente**, então cada capacidade opcional dentro de um perfil
dobra o número de agents. Com duas opcionais são quatro agents, com três são oito
— e cada um precisa do seu `S` medido, do seu wrapper e da sua saída no `Vende?`.
O projeto tem hoje **dois** agents e já paga o preço de manter os dois em
sincronia (`n8n:sincronia` existe por causa disso). É trocar uma dívida pequena
por uma estrutural, no exato momento em que o objetivo declarado é **workflow
único**.

### O que eu faria, em três passos e nesta ordem

**1. Declarar a exceção, com o motivo, onde ela é lida.** A regra de superfície do
`CLAUDE.md` fala de menu, rota e Server Action. A **lista de ferramentas do agente
é uma quarta superfície**, e a regra não a nomeia. O texto que falta é curto e
diz o que é verdade:

> A lista de ferramentas do agente é derivada do **perfil**, não da contratação,
> porque o n8n liga tool a agent estaticamente e um perfil por combinação
> explode. A fronteira dessa superfície é a **função** (`api_n8n_*`), que confere
> `ativo and contratado` e recusa. Ferramenta de módulo não contratado pode
> aparecer no schema; não pode executar.

Declarada, ela para de ser esquecimento e vira decisão — que é a diferença que o
`CLAUDE.md` já faz em outro lugar, quando diz que negação implícita funciona mas
"não está declarada em lugar nenhum" (`podcast_agendamentos`).

**2. Guardar com teste, porque regra escrita em doc não sobrevive a seis meses.**
O teste que falta não é sobre a foto — é sobre a **propriedade**:

> Para toda ferramenta pendurada num perfil, chamar a função dela como
> `n8n_agent` num tenant que **não** contratou o módulo **recusa**, e recusa sem
> tocar em dado.

Isso já tem forma pronta no repositório: `npm run teste:grants-n8n` varre
`api_n8n_*` por prefixo (lista não fixa — função nova entra sozinha) e **chama de
verdade** com `set local role n8n_agent`. Este entra ao lado, com a mesma
mecânica, e a sabotagem dele é direta e obrigatória: **trocar o
`tt.ativo and tt.contratado` da função por `true` e confirmar que o teste
reprova.** Sem essa sabotagem o teste não está medindo nada.

O teste tem de arranjar o próprio estado — descontratar dentro da transação
revertida — e não afirmar que algum tenant por acaso está sem o módulo. É
literalmente o defeito nº 8 da lista do `CLAUDE.md`, que apareceu em
`tests/migracao-foto-agente.mjs` e era sobre **esta mesma tool**.

**3. Quando aparecer o primeiro tenant com vendas e sem foto, aí decidir.** Só
então o custo sai do papel, e aí há uma saída barata que hoje não vale o trabalho:
**a seção do system message pode ser condicional, a lista de ferramentas não.** O
system message é uma expressão n8n e já lê `Tools Ativas`; dá para omitir o
`## Ferramenta: enviar_foto_produto` de quem não contratou. A ferramenta continua
no schema (o custo de token fica), mas some a instrução que ensina a usá-la —
resolve a metade "escolha errada" sem tocar na topologia.

O preço disso, dito agora para não ser descoberto depois: o wrapper deixa de ser
uma constante por perfil, e o `Estima Tokens` calcula `comp_wrapper` a partir de
`WRAPPERS[perfil]`, que é injetado pelo gerador como texto fixo. Wrapper variável
por tenant obriga a medir o wrapper em runtime, e `npm run n8n:sincronia` compara
justamente esses dois textos. **É mudança no rateio, não só no prompt** — por isso
não é para agora.

### E o achado menor que vem junto

`S = 622` foi medido quando o perfil de vendas tinha **7** ferramentas — o
comentário do gerador diz *"622, ~89 por tool"*. Hoje são **8**. O rateio
subestima o perfil de vendas em ~1 ferramenta desde que a foto entrou, e
subestimaria mais ainda com a redação da §7. Não é urgente e não afeta cliente
nenhum; afeta o número que a agência usa para cobrar. Cai junto na primeira vez
que `S` for re-medido.

---


---

## 9. Quadro-resumo

| # | hipótese | evidência hoje | custo/turno | escopo | como medir que funcionou |
|---|---|---|---|---|---|
| **1** | o modelo | **desconfundida e por testar** — 8/8 em `gpt-4.1-mini`, zero turnos em qualquer outro | +US$ 0,0103 (4,1) | qualquer tenant | zero fabricação em 40+ turnos de confirmação, contra controle no mesmo dia |
| **2** | oito tools | custo medido e **pequeno** (78 tok/tool/chamada); escolha não mensurável no histórico | −US$ 0,0001 | perfil de vendas | braço extra no mesmo experimento |
| **3** | debounce isolado | **falsificada como diferenciador** — 311/317 turnos isolados, inclusive os que acertam | 0 | todos | — (não seguir) |
| **4** | descrições sem QUANDO | **assimetria 2/2 leitura × 0/3 escrita**, e o prompt pede literalmente a frase que fabrica | **+US$ 0,0002** (+342 tok/chamada, §7.5) | todos | mesmo experimento, braço próprio — nunca junto do braço 2 |
| **5** | injeção de estado | ponto de injeção já existe; a leitura não | +US$ 0,00002 e 1 função nova | **todos, por contratação** | fabricação cai sem o modelo mudar |

---

## 10. A ordem que eu seguiria

1. **Virar a flag do `emporio`** (§0). É a única coisa desta lista que é urgente, e
   não está feita.
2. **Exportar o workflow e rodar o `diff-n8n-instancia`** (§1). Sem isso, as
   hipóteses 2 e 4 podem estar analisando um texto que não é o que roda.
3. **O experimento do modelo, dois braços, no `sendbox`** (§2). US$ 2 a 3, um dia de
   trabalho, e o critério declarado antes. Ele decide se as outras são conserto ou
   melhoria — **mas mesmo o melhor resultado possível prova "no máximo ~7 %", não
   "resolvido"**, e isso muda o que se conclui dele.
4. **A redação das descrições** — §5 mede a assimetria, §7 traz o texto pronto —,
   se o passo 3 não zerar. Ataca o momento exato da falha e **não é de graça**:
   +342 tokens por chamada, e obriga a re-medir o `S`. Continua sendo
   probabilidade, não garantia.
5. **A função de estado** (§6), que serve à injeção e ao portão. É o único item que
   generaliza para o SaaS, e é o que transforma "um portão por capacidade" em "uma
   linha por capacidade".
6. **A dívida da foto** (§8): declarar a exceção e guardá-la com teste. Não é
   incidente — a função recusa —, mas hoje só está certa por coincidência.
7. **O portão factual**, se depois de tudo isso a taxa não for aceitável — e aí
   como **capacidade contratável por tenant**, do jeito que o `CLAUDE.md` já manda
   toda superfície de tool ser.
