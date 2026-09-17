# Desenho — modalidades de venda e aviso ao dono

> Conversa de 17/09/2026. **Só desenho; nada construído.** O que o Felipe
> decidiu está marcado como decisão; o que falta decidir está na §6.

## 1. O problema

O agente já fecha uma venda de ponta a ponta (catálogo → pedido → link → Pix →
webhook → "Pagamento confirmado!"), mas **o dono do estabelecimento não fica
sabendo**: a notificação de venda fechada existe no banco
(`api_n8n_notificar_venda`, WAHA) e nenhum tenant a tem configurada (não há
tela); o webhook do pagamento avisa o cliente, não o dono. E o pedido só conhece
um jeito de pagar (link, antes) — não há "pagar na entrega", "retirar na loja".

## 2. Decisões já tomadas

- **Configurável por tenant, pelo cliente, no painel** (Felipe, 17/09): não
  desenhar para o Empório — toda conta futura configura o que oferece em
  *Configurações → Vendas*. A agência não precisa entrar.
- A notificação ao dono segue o padrão que já existe na transferência
  (`tenant_tools.config.notificacao`): canal `waha`, `destino` do cliente,
  `sessao` da agência. **Também nota privada no Chatwoot** (Felipe, 17/09).
- **ENTREGA FICA NA GAVETA** (Felipe, 17/09): a taxa de entrega varia por
  localização em muitos estabelecimentos (bairro/zona/distância), e resolver
  isso puxa cadastro de bairros ou API de mapas. Por enquanto o agente só
  vende para **retirada**. O modelo abaixo deixa `modalidades` como lista e
  `pagamento_modo` como enum justamente para `entrega` entrar depois sem
  migração de estrutura — mas **nada de entrega é construído agora**: nem
  campo de endereço, nem taxa, nem `na_entrega`.
- Quem marca pago/retirado é o usuário da conta, em Pedidos (ver §6.1).

## 3. O modelo

`tenant_tools.config` da tool `vendas` ganha:

```json
{
  "modalidades": ["retirada"],
  "pagamentos": ["link", "na_retirada"],
  "notificacao": { "canal": "waha", "sessao": "<agência>", "destino": "55DDD…@c.us",
                   "nota_chatwoot": true },
  "eventos": ["pedido_fechado", "pagamento_confirmado", "pedido_cancelado"]
}
```

(`modalidades` só aceita `retirada` hoje; `entrega`, `taxa_entrega_*` e
`endereco_entrega` são a gaveta — o validador do painel recusa até existirem.)

`pedidos` ganha colunas (migração), preenchidas pelo `fechar` como argumentos
**estruturados** (não mais texto solto em `metadados`): `modalidade`
(`retirada`; check aberto a `entrega` depois), `pagamento_modo`
(`link`|`na_retirada`), `pago_em`, `retirado_em`.

## 4. Estados

`rascunho → fechado → pago → retirado` (+ `cancelado`, `expirado`).

- pagamento por **link**: `fechado` = `aguardando_pagamento` (como hoje); o
  webhook marca `pago`; o relógio de 24 h expira como hoje;
- pagamento **na retirada**: `fechado` NÃO é `aguardando_pagamento` — não
  expira em 24 h, e `resolver_conversa` não trava (o beco de 16/09 some para
  esse caso). Quem marca `pago` e `retirado` é o **usuário da conta, em
  Pedidos** (dois botões; "pago" pode marcar os dois de uma vez quando o
  cliente paga ao retirar).

## 5. O que o agente diz — e o portão

O prompt (seção de `gerenciar_pedido`) passa a perguntar **só** o que o tenant
oferece: se só há link, não oferece "na retirada", e vice-versa; nunca
pergunta endereço (entrega não existe). Com pagamento na hora, a frase certa é
"pedido confirmado, você paga quando retirar" — o portão hoje lê
"pagamento"+"confirmado" como afirmação de recebimento; precisa de um caso novo
em `teste:portao-pagamento`: **"pagamento na retirada" é combinação, não
recebimento** (mesma família da exceção da regra 1 de 16/09).

## 6. O que falta decidir

1. ~~Quem marca pago/entregue~~ — **resolvido por construção (Felipe, 17/09):**
   hoje cada conta tem UM usuário (o admin), então quem marca é *o usuário da
   conta, em Pedidos*. Quem PODE marcar vira permissão quando existir o tópico
   **usuários por conta** (admin cria atendentes com menos poder que ele) —
   tópico grande, que o Felipe quer ver DEPOIS deste. Construir os botões sem
   supor papel: a checagem de permissão entra quando o modelo de usuários
   existir.
2. ~~Nota privada no Chatwoot~~ — **sim** (Felipe, 17/09).
3. ~~Taxa de entrega~~ — **entrega inteira na gaveta** (Felipe, 17/09): taxa
   varia por localização; sem decisão de como cobrá-la não há entrega. Quando
   voltar, começa por aqui (fixa × bairro × distância).

Nada em aberto: o desenho está pronto para construir.

## 7. Ordem de construção

1. Migração: colunas em `pedidos` (`modalidade`, `pagamento_modo`, `pago_em`,
   `retirado_em`) + `api_n8n_fechar_pedido` ganhando os campos por chave nova
   no jsonb (o n8n congelado chama a mesma função — sem trocar assinatura) +
   `api_n8n_notificar_venda` lendo os campos novos e os eventos + função nova
   para o painel marcar pago/retirado.
2. Painel do cliente: *Configurações → Vendas* (pagamentos, notificação com
   nota no Chatwoot, eventos) + *Pedidos* com colunas novas e botões
   pago/retirado.
3. Serviço: `fechar` estruturado + prompt condicional ao que o tenant oferece +
   webhook do pagamento avisando o dono (WhatsApp + nota privada) + caso novo
   do portão.
4. Testes: três tenants com ofertas diferentes; portão; notificação por evento.
