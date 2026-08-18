# Pendência — prazo para o rascunho (carrinho abandonado)

> **Registrada em 18/08/2026. NÃO implementada.** O gatilho está no fim.

## O que acontece hoje

A migração 38 expira **só** `aguardando_pagamento`, e o raciocínio da época
continua certo: rascunho é o carrinho do próprio cliente, e expirar destrói
trabalho dele. Há inclusive uma asserção guardando isso —
`tests/migracao-expirar-pedido.mjs`, seção 4: *"rascunho de 90 dias continua
rascunho — é o carrinho do cliente"*, escrita com a nota "a asserção existe para
o dia em que alguém 'generalizar' a regra".

**Mas o carrinho velho volta.** Confirmado no banco em 18/08:

```sql
-- uq_pedidos_conversa_aberta
CREATE UNIQUE INDEX ... ON public.pedidos (tenant_id, conversation_id)
  WHERE status = ANY (ARRAY['rascunho','aguardando_pagamento'])
    AND deletado_em IS NULL
```

O índice de "um pedido aberto por conversa" cobre **os dois** status. E
`pedido_aberto_da_conversa` chama `expirar_pedidos_vencidos` (que não toca em
rascunho) e em seguida faz `where status in ('rascunho','aguardando_pagamento')`.

Resultado: o cliente que abandonou o carrinho ontem e volta hoje **com outra
intenção** encontra o pedido de ontem. Não é bug de código — é a consequência
combinada de duas decisões certas isoladamente.

**Observado:** os dois rascunhos do `emporio` estavam parados havia 17 h quando
foram apagados à mão em 18/08 (eram pedidos de teste). Hoje: zero pedidos em
todos os tenants.

## O desenho proposto

Prazo para rascunho também, **mais longo** que o do fechado — algo como 48 h
contra 24 h. Mesma mecânica de expirar **na leitura** (nada de cron), mesmo
caminho de aviso.

A assimetria tem razão: `aguardando_pagamento` é compromisso assumido, e prazo
curto protege estoque e evita cobrança fora de hora. Rascunho é intenção, e
intenção merece mais corda.

`pedido_horas_para_expirar(tenant)` já lê `horas_expirar_pagamento` da config da
tool com default 24. Hoje **nenhum tenant tem o valor configurado** — os quatro
usam o default. Uma chave irmã (`horas_expirar_rascunho`) segue o mesmo padrão,
e a mesma trava de config inválida cair no default em vez de desligar a
expiração.

## As duas decisões — e o que foi medido sobre cada uma

### 1. O prazo conta de quando?

Da criação, ou da última alteração? Cliente que adiciona item hoje reinicia o
relógio, ou o carrinho tem validade absoluta?

**Armadilha medida, e ela elimina a saída óbvia:** `pedidos.atualizado_em` **não
se move quando o cliente adiciona item**. `api_n8n_adicionar_item` só faz
`insert into public.pedidos` (quando cria); acrescentar item escreve em
`pedido_itens`, e o trigger `trg_pedidos_upd` é `BEFORE UPDATE` — não dispara.

Ou seja: implementar "conta da última alteração" lendo `atualizado_em`
**silenciosamente se comporta como "conta da criação"** para o carrinho que o
cliente foi montando. Passaria em qualquer teste que só olhasse o status.

Se a escolha for "última alteração", há dois caminhos honestos:

- `max(pedido_itens.criado_em)` como relógio, o que também captura remoção de
  item se ela gravar linha;
- fazer `adicionar_item` tocar o pedido de propósito (`update ... set
  atualizado_em = now()`), assumindo que aí `atualizado_em` passa a significar
  "última atividade" e não "última mudança da linha".

E se a escolha for "validade absoluta desde a criação", vale escrever o porquê:
é a regra que o cliente consegue prever ("carrinho dura 2 dias"), enquanto a
janela deslizante pode manter um carrinho vivo por semanas com um item por dia.

### 2. O aviso muda?

Pedido fechado que expira gera *"seu pedido de R$ X venceu"* — e faz sentido,
porque o cliente sabe que fechou algo.

Rascunho abandonado talvez **não mereça aviso**: o cliente pode não lembrar que
montou nada, e receber "seu carrinho expirou" de um carrinho esquecido é
introduzir um assunto que ele não tinha.

O contra a considerar quando for decidir: sumir em silêncio tem modo de falha
próprio — o cliente que **lembrava** volta, não encontra os itens e não recebe
explicação nenhuma. Um meio-termo é não avisar proativamente e deixar o agente
explicar **se** o cliente perguntar pelo pedido anterior.

## Cuidados de implementação

- **A asserção do rascunho de 90 dias vai ficar vermelha, e isso é o esperado.**
  Ela existe justamente para forçar esta conversa. Mudá-la é ato deliberado e
  precisa vir com justificativa no commit — não é "consertar teste".
- **Se a assinatura de `expirar_pedidos_vencidos` mudar**, vale a disciplina da
  família 28/32/37/40/41/42: `drop function` explícito pela lista completa de
  tipos, `create or replace` depois, e grants **nos dois** roles
  (`service_role` e `n8n_agent`), verificados por chamada real com
  `set local role`. `npm run teste:grants-n8n` cobre.
- **Re-rodar `npm run teste:expirar-pedido`** (27 asserções hoje) e o de
  isolamento de pedidos.

## Gatilho

Primeiro cliente reclamando que o agente trouxe pedido velho, **ou** volume que
faça isso acontecer com frequência. Enquanto o volume for o de hoje (zero
pedidos vivos), o defeito é teórico e o custo de errar o prazo é maior que o de
esperar.
