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

## Gatilho para retomar

Quando a cobrança por consumo for de fato faturar — ou seja, quando existir o
primeiro cliente com contrato que diga "você paga pelo que consumir". Até lá o
custo é de centavos e o rateio serve para saber quem pesa, não para emitir
conta.

**O que NÃO fazer antes disso:** construir a tela de lançamento. Ela é fácil e é
a parte errada para começar — sem as três respostas acima ela vai ser refeita.
