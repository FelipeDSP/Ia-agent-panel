# Pendência — como a fatura da OpenAI entra no sistema todo mês

> **Registrada em 18/08/2026. NÃO construída.** A parte técnica da cobrança por
> consumo está decidida e medida em
> [`TOKENS-REAIS-PARA-COBRANCA.md`](TOKENS-REAIS-PARA-COBRANCA.md): fatura como
> âncora, n8n só para a proporção. O que falta não é técnico — é de processo, e
> por isso não se resolve escrevendo código antes de a pergunta ser respondida.

## A pergunta em aberto

O rateio precisa de um total para distribuir, e esse total é a fatura da OpenAI.
**Como esse número chega aqui todo mês?** Não há resposta ainda, e ela decide o
formato da tela:

- **quem pega** — a agência olha o painel da OpenAI e digita, ou alguém puxa da
  Usage/Costs API com uma chave de organização?
- **quando** — a fatura fecha depois do mês; o painel mostra o mês corrente em
  andamento. Enquanto o mês não fecha, o rateio é sobre um total que ainda não
  existe;
- **o que é o total** — a fatura inclui tudo que a organização gastou, e nem tudo
  é atendimento de cliente (embedding de ingestão é, testes internos não são).
  Cobrar o cliente por consumo interno da agência é erro que ele nota.

## A forma provável, quando isso for feito

Um campo no painel onde a agência lança o total do mês e o sistema distribui —
foi o que o próprio uso sugeriu, e é a versão que não depende de nenhuma API
externa nem de credencial nova.

Consequências que já dá para antecipar, e que o desenho vai ter de resolver:

- **É lançamento versionado por mês, não um valor corrente.** A mesma lógica de
  `precos_modelo`: reescrever o total de julho mudaria contas já enviadas. Uma
  linha por mês, imutável depois de fechada.
- **Enquanto não houver lançamento, a tela não pode inventar um.** Mês sem fatura
  lançada mostra proporção sem valor em dinheiro — nunca um valor estimado com
  cara de definitivo, que é como uma conta errada sai sem ninguém perceber.
- **O que existe hoje é a soma de custo calculado por preço de tabela**
  (`precos_modelo` × tokens estimados). Esse número **não** é a fatura, e quando
  os dois aparecerem na mesma tela precisam estar rotulados de forma que a
  diferença entre eles seja óbvia. Dois números parecidos e discordantes na
  mesma tela, sem explicação, é o defeito que a reorganização de `/admin/consumo`
  já teve de consertar uma vez.
- **Margem continua fora** — ver [`PENDENCIA-MARGEM.md`](PENDENCIA-MARGEM.md). O
  gatilho dela é o mesmo: custo mensal virar número que se sente.

## Antes de cobrar: entender por que um tenant custa 4x outro

**Rateio proporcional só é justo se a proporção refletir USO, não configuração
acidental.** Esta seção existe porque a primeira medição já mostra que hoje ela
reflete configuração.

### O que foi medido (18/08/2026, `mensagens_log`)

Os tokens moram na linha de `saida` do turno — a de `entrada` vem zerada, o que
faz média ingênua por `direcao='entrada'` dar zero.

| tenant | turnos | média entrada/turno | menor | maior |
|---|---|---|---|---|
| `emporio` | 21 | **10.495** | 5.546 | 23.386 |
| `restaurante-teste` | 39 | **2.519** | 13 | 7.653 |

### A causa não é a base de conhecimento

A hipótese em aberto era que os ~80 chunks da Fortalize inflavam o contexto do
Empório, e que limpar a base derrubaria a média. **A aritmética diz que não**, e
diz por dois motivos independentes:

**1. O tamanho do prompt do tenant explica quase tudo.**

| tenant | `system_prompt` | ≈ tokens |
|---|---|---|
| `fortalize` | 15.446 chars | 4.967 |
| `emporio` | 12.206 chars | 3.925 |
| `restaurante-teste` | 205 chars | 66 |
| `acqua-lavanderia` | 110 chars | 35 |

O prompt entra em **cada chamada ao modelo**. Rodando a fórmula do
`estima-tokens.js` com o wrapper de vendas (3.767 chars ≈ 1.212 tokens) e
`S = 622`:

```
base 1 chamada, emporio      previsto 5.759   observado 5.546–6.253
base 1 chamada, restaurante  previsto 1.900   observado (média mista) 2.519
```

E os 21 turnos do Empório são **bimodais** — agrupam em ~5,9 mil e ~11,9 mil,
com dois casos em 18,5 mil e 23,4 mil. Isso é 1, 2 e 4 chamadas ao modelo, não
tamanho de base: cada round-trip de ferramenta reenvia o prompt inteiro. Prompt
grande × mais chamadas é o 4x inteiro.

**2. O número não consegue enxergar a base, nem que ela estivesse inflando.**
`CRESCIMENTO_POR_CHAMADA = 55` é tudo o que a fórmula soma por round-trip de
ferramenta. O **tamanho do resultado da tool não entra na conta** — nem catálogo,
nem chunk recuperado. Então os 80 chunks jamais apareceram neste número, e
limpá-los não vai fazê-lo cair.

**Cuidado com a leitura inversa:** o contexto REAL que a OpenAI viu pode muito
bem ter sido inflado pelos chunks. A estimativa é que é cega para isso. Ou seja,
a suspeita pode estar certa sobre a realidade e ainda assim errada sobre este
número — e é este número que iria para a conta.

### Previsão para a conversa de teste

Escrita antes de rodar: **a média não cai para ~3 mil.** Deve ficar em ~6 mil nos
turnos de uma chamada e ~12 mil nos de duas. Se cair para 3 mil, a causa é outra
— prompt encurtado ou turnos que pararam de chamar ferramenta —, e não a limpeza
da base.

### O que isso implica para a cobrança

A estimativa de hoje é **cega justamente para o que é uso** (resultado de
ferramenta, chunk recuperado, tamanho do catálogo consultado) e **sensível
justamente para o que é configuração** (o comprimento do prompt que a agência
escreveu no painel). Cobrar por essa proporção faria o Empório pagar 4x por
alguém ter escrito um prompt de 12 mil caracteres, e a Fortalize pagará mais
ainda — o prompt dela tem 15,4 mil. A decisão sobre isso está na seção
seguinte.

## DECIDIDO em 18/08/2026: normalizar, prompt é custo da agência

Havia duas saídas. **Escolhida a segunda: o rateio é sobre o que é atribuível ao
cliente, e wrapper + schema de tool + system prompt são custo da agência.**

### Por quê

**O cliente não escolheu o prompt — a agência escreveu.** Cobrar por ele
significa que a conta dele muda quando a agência refatora, sem ele ter feito
nada. Uma fatura que se mexe por trabalho interno de quem emite a fatura é
indefensável na primeira vez que for perguntada, e ela vai ser perguntada
exatamente quando subir.

**E a primeira saída tem incentivo perverso:** com o prompt dentro da base de
cobrança, encurtar prompt vira perda de receita. Ou seja, a régua pagaria a
agência para não fazer a otimização que baratearia o produto — e a mesma pessoa
controla os dois lados. A segunda saída inverte o sinal: prompt longo passa a
custar a quem tem a caneta, que é o único arranjo em que a otimização acontece.

Isto não é preciosismo de justiça. É a diferença entre uma régua imprecisa e uma
régua **torta na direção errada**: a estimativa de hoje é cega para o que é uso
(resultado de ferramenta, chunk recuperado, catálogo consultado) e sensível para
o que é configuração (comprimento do prompt). Imprecisão se corrige com
calibração; direção errada não.

### A regra

| Atribuível ao CLIENTE | Custo da AGÊNCIA |
|---|---|
| mensagens (o que o cliente dele escreveu e o que o agente respondeu) | wrapper do perfil (3.767 chars ≈ 1.212 tok) |
| chamadas de ferramenta, e o conteúdo que elas devolvem (catálogo, chunk da KB dele) | schema das tools (`S`: 622 no vendas, 266 no básico) |
| embedding de ingestão do que ele subiu | `system_prompt` do tenant |

**Uma peça não estava na lista e precisa de destino: a janela de memória**
(`historico_chars`, ~970 tokens por mensagem e crescendo com a conversa). É a
conversa do próprio cliente reenviada a cada chamada, então a leitura natural é
**atribuível a ele** — e vale registrar que ela é o maior termo de crescimento da
conta, maior que o prompt em conversa longa. Se a intenção for outra, é aqui que
se escreve.

### O que isso exige de quem for implementar

**A decomposição precisa ser GRAVADA, e hoje não é.** `mensagens_log` guarda só
`tokens_entrada`, `tokens_saida` e `modelo` — o total, já somado. O
`estima-tokens.js` calcula os componentes internamente (wrapper, prompt,
mensagens, `S`, memória) e joga fora todos menos a soma. Sem os componentes, a
regra acima **não é aplicável retroativamente**: não dá para separar depois o que
nunca foi separado na gravação.

Consequência prática: se a cobrança por consumo for acontecer, a primeira coisa a
fazer não é a tela de lançamento da fatura — é o log passar a gravar a
decomposição. É barato (os números já existem no nó, só não saem dele) e é a
única parte que **perde valor a cada dia que não é feita**, porque cada turno que
passa é um turno que nunca poderá ser rateado por esta regra.

### O que continua em aberto

A decisão acima é sobre a REGRA. Ela não depende da fatura ser lançável, e por
isso pôde ser tomada agora. Continua aberto tudo da seção anterior: quem pega a
fatura, quando, e o que conta como consumo de cliente.

## Gatilho para retomar

Quando a cobrança por consumo for de fato faturar — ou seja, quando existir o
primeiro cliente com contrato que diga "você paga pelo que consumir". Até lá o
custo é de centavos e o rateio serve para saber quem pesa, não para emitir
conta.

**O que NÃO fazer antes disso:** construir a tela de lançamento. Ela é fácil e é
a parte errada para começar — sem as três respostas acima ela vai ser refeita.
