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
  `sessao` da agência.

## 3. O modelo

`tenant_tools.config` da tool `vendas` ganha:

```json
{
  "modalidades": ["entrega", "retirada"],
  "pagamentos": ["link", "na_entrega", "na_retirada"],
  "taxa_entrega_centavos": 0,
  "notificacao": { "canal": "waha", "sessao": "<agência>", "destino": "55DDD…@c.us" },
  "eventos": ["pedido_fechado", "pagamento_confirmado", "pedido_cancelado"]
}
```

`pedidos` ganha colunas (migração), preenchidas pelo `fechar` como argumentos
**estruturados** (não mais texto solto em `metadados`): `modalidade`
(`entrega`|`retirada`), `pagamento_modo` (`link`|`na_entrega`|`na_retirada`),
`endereco_entrega text`, `pago_em`, `entregue_em`.

## 4. Estados

`rascunho → fechado → pago → entregue|retirado` (+ `cancelado`, `expirado`).

- pagamento por **link**: `fechado` = `aguardando_pagamento` (como hoje); o
  webhook marca `pago`; o relógio de 24 h expira como hoje;
- pagamento **na entrega/retirada**: `fechado` NÃO é `aguardando_pagamento` —
  não expira em 24 h, e `resolver_conversa` não trava (o beco de 16/09 some
  para esse caso). Quem marca `pago` e `entregue/retirado` é o **dono, em
  Pedidos** (dois botões).

## 5. O que o agente diz — e o portão

O prompt (seção de `gerenciar_pedido`) passa a perguntar **só** o que o tenant
oferece: se só há retirada, não pergunta endereço; se só há link, não oferece
"na entrega". Com pagamento na hora, a frase certa é "pedido confirmado, você
paga na entrega" — o portão hoje lê "pagamento"+"confirmado" como afirmação de
recebimento; precisa de um caso novo em `teste:portao-pagamento`: **"pagamento
na entrega/na retirada" é combinação, não recebimento** (mesma família da
exceção da regra 1 de 16/09).

## 6. O que falta decidir

1. **Quem marca pago/entregue** para pedidos na hora — o dono no painel do
   cliente (proposta) ou o atendente no Chatwoot? (Felipe ainda não respondeu.)
2. **Nota privada no Chatwoot** além do WhatsApp — sim/não.
3. **Taxa de entrega**: valor fixo por tenant, ou por bairro/faixa? Começar
   com fixo.

## 7. Ordem de construção

1. Migração: colunas em `pedidos` + `api_n8n_fechar_pedido` ganhando os campos
   por chave nova no jsonb (o n8n congelado chama a mesma função — sem trocar
   assinatura) + `api_n8n_notificar_venda` lendo os campos novos e os eventos.
2. Painel do cliente: *Configurações → Vendas* (modalidades, pagamentos, taxa,
   notificação, eventos) + *Pedidos* com colunas novas e botões pago/entregue.
3. Serviço: `fechar` estruturado + prompt condicional ao que o tenant oferece +
   webhook do pagamento avisando o dono + caso novo do portão.
4. Testes: três tenants com ofertas diferentes; portão; notificação por evento.
