# Pendência — margem por cliente no consumo

> Registrada em **2026-08-17**, junto com a reorganização de `/admin/consumo`.
> **Não implementada de propósito.** Este arquivo existe para que a decisão de
> não fazer não vire esquecimento de fazer.

## O que ficou de fora

A tela de consumo mostra **custo** — tokens × tabela de preços. Não mostra
margem: quanto a agência cobra do cliente menos o que ela paga à OpenAI.

## Por que não agora

**1. Não existe valor de plano em lugar nenhum do schema.** `tenants` tem nome,
slug, Chatwoot, prompt e modelo; `tenant_tools` tem quais tools foram
contratadas. Nenhuma das duas guarda preço de venda. Margem exige criar esse
campo — e criar o campo é decidir o modelo de cobrança:

- valor fixo por cliente?
- por faixa de volume (mensagens, conversas, tokens)?
- por tool contratada, somando o que foi vendido?

As três levam a schemas diferentes e a telas diferentes. Escolher errado agora
custa uma migração depois, com cliente em produção.

**2. O provedor de pagamento está em aberto.** Quem cobra decide o que é a
fonte da verdade do preço. Se a cobrança passar a viver num Stripe (ou
equivalente), o valor do plano é dado *dele*, e duplicá-lo aqui cria duas
verdades que divergem no primeiro reajuste. Modelar preço antes de saber onde
ele mora é a ordem errada.

**3. O custo atual é de centavos.** Em agosto de 2026 o cliente mais caro fecha
o mês em **US$ 0,04**. Margem sobre quatro centavos não informa decisão nenhuma —
é ruído com uma casa decimal a mais. Margem importa quando o número é material.

## Gatilho para retomar

Qualquer um dos dois:

- **Planos diferentes entre clientes.** No momento em que dois clientes pagarem
  valores diferentes, "quanto sobra de cada um" vira pergunta real, e a resposta
  deixa de ser a mesma para todo mundo.
- **O custo mensal virar número que se sinta.** Não há limiar exato para isto,
  e não precisa haver: é quando abrir `/admin/consumo` e o total causar reação.

Ordem de trabalho quando o gatilho disparar: **primeiro** decidir o modelo de
cobrança (fixo / faixa / por tool), **depois** o schema, **por último** a tela.
Fazer a tela primeiro força o schema pela conveniência do layout.

## O que já está pronto quando a hora chegar

- `billing_consumo_mensal()` já devolve custo por tenant e por mês, com o preço
  da época. O lado do custo da conta não precisa de nada novo.
- `src/lib/billing/consumo.ts` já monta a visão do mês e o histórico por tenant;
  margem entra como mais um campo derivado, não como outra tela.
- O mesmo gatilho de materialidade vale para `LIMIAR_VARIACAO_USD` (o piso de
  dez centavos que decide qual variação merece destaque). Ele foi calibrado para
  a escala de centavos de hoje e sobe junto quando o custo subir.
