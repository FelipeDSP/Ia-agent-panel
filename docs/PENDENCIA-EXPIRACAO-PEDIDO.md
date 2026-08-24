# Pendência — o relógio da expiração de pedido é frágil de dois jeitos

**Estado:** levantado em 2026-08-21 ao investigar se `aguardando_pagamento`
travava pedido novo. **Não trava** — as duas saídas funcionam e o prompt ensina o
`cancelar_pedido`. O que sobrou são dois defeitos do *relógio*, não do bloqueio.

**Gatilho:** primeira reclamação de pedido que "sumiu" ou que "ficou pendente
para sempre"; ou ao mexer em qualquer coisa que faça `update` em `pedidos`.

## Como a expiração funciona hoje

`expirar_pedidos_vencidos(tenant, conversa)` marca `expirado` todo pedido em
`aguardando_pagamento` cujo `atualizado_em` seja mais velho que
`pedido_horas_para_expirar(tenant)` — que lê
`tenant_tools.config->>'horas_expirar_pagamento'` da tool `vendas`, com **default
24 h**. Nenhum tenant configurou outro valor: os quatro estão em 24 h.

Quando ela dispara, a mensagem é boa e o cliente não perde a viagem:

```
O pedido anterior (nº 1, R$ 10,00) expirou por falta de pagamento e foi liberado.

Pedido atual:
- 2x sonda — R$ 20,00
```

## Defeito 1 — QUALQUER `update` em `pedidos` reseta o relógio

`trg_pedidos_upd` é `BEFORE UPDATE ... EXECUTE FUNCTION set_atualizado_em()`, e a
expiração compara justamente `atualizado_em`. Então **tocar a linha por qualquer
motivo dá 24 h novas ao pedido**, mesmo que o motivo nada tenha a ver com
pagamento.

**Isto não é hipótese — aconteceu em 21/08, por uma correção que eu mesmo fiz.**
O pedido `c49a4b6a` do `emporio` (nº 1, conversa 3) estava com ~29 h paradas, ou
seja **já vencido**: bastaria o cliente escrever para ele expirar e a conversa
liberar. A correção das quantidades dobradas (ver
`PENDENCIA-CARRINHO-MULTI-ITEM.md` §7) fez `update` em `pedido_itens` e em
`pedidos.metadados`, o trigger reescreveu `atualizado_em`, e o pedido voltou a
**2,4 h de idade — com 21,6 h pela frente**.

Consertar dado ressuscitou um pedido vencido. Ninguém pediu isso e nada avisou.

A raiz é a de sempre: **um campo com dois significados**. `atualizado_em` é
"quando a linha mudou" e está sendo lido como "há quanto tempo o cliente não
paga". Enquanto forem a mesma coluna, toda escrita futura tem esse efeito
colateral.

A saída provável é uma coluna própria — `aguardando_desde`, escrita só por
`fechar_pedido` — e a expiração passar a compará-la. Mas isso é migração, e não é
o escopo deste registro.

**Quem escreve em `pedidos` hoje, e portanto mexe no relógio:** `fechar_pedido`,
`adicionar_item`/`remover_item` (via total), `cancelar_pedido`,
`expirar_pedidos_vencidos` e — a partir da migração 52 — o claim da notificação
de venda (`api_n8n_notificar_venda` e `api_n8n_confirmar_notificacao`, que
gravam em `metadados.notificacao`). O desvio da 52 é de **segundos**, medido pelo
`npm run teste:notificar-venda`, porque o claim roda logo depois do fechamento;
mas a lista é o argumento: cada novo escritor de `pedidos` vira um novo
adiador da expiração, calado, e isso só para com a coluna própria.

## Defeito 2 — a expiração é PREGUIÇOSA, como a da pausa

`expirar_pedidos_vencidos` só roda **de dentro** de `pedido_aberto_da_conversa` e
de `api_n8n_adicionar_item`. Ou seja: só quando **aquela mesma conversa** age.

Não há cron, não há varredura. Cliente que fecha um pedido e nunca mais escreve
deixa a linha em `aguardando_pagamento` **para sempre**, e o painel a mostra como
pendente indefinidamente.

É o mesmo formato da lápide da pausa (`conversas.status` seguia `'pausado'` até a
próxima escrita, ver `PAUSA-AUTOMATICA.md`), e a solução lá foi um predicado que
resolve na leitura — `pausa_vigente`. Aqui o equivalente seria a tela calcular
"vencido" em vez de ler `status` cru.

**E isto reforça o item do "marcar como recebido" no painel:** enquanto não
houver como o dono dizer "esse eu recebi", o estado `aguardando_pagamento` só sai
por expiração preguiçosa ou por cancelamento feito pelo agente — nenhum dos dois
sob controle de quem de fato recebeu o dinheiro.

## O que NÃO é problema, e foi confirmado

- **`aguardando_pagamento` não trava o cliente.** `cancelar_pedido` libera na
  hora ("A conversa esta livre para um novo pedido"), e o prompt de vendas ensina
  quando usá-lo (linha 28 do `systemMessage`);
- **`fechar_pedido` é idempotente na escrita**: a segunda chamada responde "O
  pedido nº 1 ja foi fechado" e não cria pedido duplicado;
- o `uq_pedidos_conversa_aberta` faz o que promete: um aberto por conversa,
  contando `rascunho` e `aguardando_pagamento`.

## Uma armadilha de teste, registrada porque custou uma conclusão errada

O primeiro teste desta expiração deu "**não expira**" — e era defeito do
**arranjo**, não da função: envelhecer o pedido com
`update pedidos set atualizado_em = now() - interval '25 hours'` é desfeito **no
mesmo comando** pelo `trg_pedidos_upd`. O `update` roda, o trigger reescreve, e a
linha continua com idade zero.

Para arranjar idade em `pedidos` (ou em qualquer tabela com `set_atualizado_em`)
é preciso desligar o trigger dentro da transação:

```sql
alter table public.pedidos disable trigger trg_pedidos_upd;
update public.pedidos set atualizado_em = now() - interval '25 hours' where ...;
alter table public.pedidos enable trigger trg_pedidos_upd;
```

Com o arranjo certo, a expiração funciona. É a mesma disciplina de sempre:
**confirme que a mutação entrou antes de acreditar no resultado.**
