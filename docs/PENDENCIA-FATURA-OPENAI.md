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

> **TODOS OS NÚMEROS DESTA SEÇÃO SÃO ANTERIORES À OTIMIZAÇÃO DO PROMPT**, feita
> em 18/08 logo depois: o `system_prompt` do `emporio` foi de **12.206 para
> 5.708 caracteres** (−53%), cortando repetição — a regra de não inventar preço
> aparecia em cinco seções, os horários em três — sem tirar regra de
> comportamento. Sem esta marcação a próxima comparação não bateria e pareceria
> defeito. O que a otimização muda está em "Depois da otimização", abaixo.

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

### Depois da otimização do prompt (18/08) — o que esperar agora

Medido rodando o próprio nó com os dois tamanhos de prompt, mesma memória e
mesma mistura de chamadas:

| turno | prompt 12.206 | prompt 5.708 | variação |
|---|---|---|---|
| 1 chamada | 6.566 | 4.477 | **−32%** |
| 2 chamadas | 13.187 | 9.009 | **−32%** |
| 4 chamadas | 26.594 | 18.238 | **−31%** |

**Cortar 53% do prompt derruba ~32% do turno, não 53%.** O prompt é um
componente entre seis: wrapper (1.212/chamada), schema das tools (622/chamada),
memória e mensagens não mudaram. Vale escrever porque a diferença entre os dois
números é exatamente o tipo de coisa que depois vira "a conta não bate".

Projeção para a média do Empório, mantida a mesma mistura de chamadas dos 21
turnos: **10.495 → ~7.100**.

### Previsão para a conversa de teste

> **SUBSTITUÍDA em 18/08.** A previsão original ("a média não cai para ~3 mil;
> fica ~6 mil e ~12 mil") valia com o prompt ANTIGO, e ficou obsoleta no momento
> em que ele foi cortado. Ela continua abaixo porque o raciocínio segue válido —
> o que mudou foi uma variável, não a lógica.
>
> **A previsão que vale agora:** turnos de 1 chamada em ~3.900–4.700, de 2
> chamadas em ~7.500–8.500, média perto de 7 mil.
>
> **E isto virou experimento controlado**, que é melhor do que era: uma variável
> mudou, sozinha, com o antes medido. Se a queda for perto de 32%, confirma que
> o número é dirigido pelo prompt — e confirma junto que a estimativa é
> previsível, que é o ponto de "previsível com a variável errada".
>
> **A armadilha a evitar na leitura:** ver a média cair e creditar à limpeza da
> base. A KB nunca esteve neste número (a fórmula é cega ao tamanho do retorno
> de tool) e o corte do prompt sozinho explica a queda. Se cair MUITO mais que
> 32%, aí sim há algo não modelado — e vale investigar em vez de comemorar.



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

## EM ABERTO: o prompt entra na conta do cliente?

> **Histórico honesto.** Em 18/08 isto chegou a ser registrado como decidido
> ("prompt é custo da agência"). **Reaberto no mesmo dia**, antes de qualquer
> linha de código, porque a decisão estava sendo tomada sem o dado que a torna
> decidível. Fica escrito como discussão em aberto, com os dois lados, para não
> se repetir o padrão de marcar como fechado o que ainda não fechou.

**Princípio em vigor enquanto se mede: "cliente usa, cliente paga."** O modelo de
plano será decidido com 3 a 6 clientes medidos no primeiro mês — não por
argumento.

### A favor de cobrar o prompt do cliente

O prompt foi escrito **a pedido dele** e descreve o negócio dele: cardápio, tom,
política de atendimento. É serviço prestado a esse cliente, e o custo que ele
gera na OpenAI é real e recorrente — a cada chamada.

### Contra

**O tamanho mede quão eficiente foi a escrita, não o que ele pediu.** Reescrever
12 mil caracteres em 6 mil entrega o mesmo atendimento pela metade da conta: o
cliente pagaria pela verbosidade de quem redigiu, sem ter pedido nem uma coisa
nem outra, e a conta mudaria numa refatoração em que ele não participou.

E **cria incentivo contra otimizar**: com o prompt dentro da base de cobrança,
encurtá-lo vira perda de receita — e quem tem a caneta é quem recebe.

### Saída intermediária

Cobrar até um **tamanho de referência** (por exemplo 4 mil caracteres) e tratar o
excedente como custo da agência. Preserva o "serviço prestado a ele" e tira o
prêmio pela verbosidade: o teto vira o alvo de quem escreve. O número de
referência é arbitrário até haver medição — é justamente o que os 3 a 6 clientes
vão dizer.

### Decisão

**Adiada** até haver medição de 3 a 6 clientes. Hoje há dois com prompt de
verdade (`emporio` 5.708 chars desde 18/08, era 12.206; `fortalize` 15.446) e o
resto é seed — decidir
com n = 2, sendo os dois do extremo alto, é decidir pelo caso extremo.

### O que NÃO está em aberto

- **Mensagens, janela de memória e round-trips de ferramenta são do cliente.**
  A memória é a conversa dele reenviada; conversa longa é uso genuíno. (Se um dia
  a intenção for outra, é aqui que se escreve.)
- **Wrapper e schema das tools** nunca foram contestados como custo de
  plataforma, mas herdam o mesmo gatilho: revisar com os mesmos dados.

## A gravação é só gravação

**Nada disso bloqueia guardar os componentes, e é exatamente por isso que a
gravação vem primeiro.** O log guarda os componentes **separados e sem regra
nenhuma aplicada**: nada de coluna "cliente" e "agência", nada de percentual,
nada de teto de referência. A regra entra na **query**, quando houver decisão —
e é essa separação que permite decidir depois sem regravar nada.

O inverso não existe: **decomposição não é retroativa.** `mensagens_log` guarda
hoje só o total já somado, e o `estima-tokens.js` calcula os componentes
internamente e joga fora todos menos a soma. Cada turno que passa é um turno que
nunca poderá ser olhado por componente — e a decisão de plano depende de olhar
por componente, porque um total que mistura uso e configuração leva à decisão
errada.

Com três clientes entrando, a janela de perda é agora. É por isso que esta é a
única parte desta pendência que não espera.

## Gatilho para retomar

Quando a cobrança por consumo for de fato faturar — ou seja, quando existir o
primeiro cliente com contrato que diga "você paga pelo que consumir". Até lá o
custo é de centavos e o rateio serve para saber quem pesa, não para emitir
conta.

**O que NÃO fazer antes disso:** construir a tela de lançamento. Ela é fácil e é
a parte errada para começar — sem as três respostas acima ela vai ser refeita.
