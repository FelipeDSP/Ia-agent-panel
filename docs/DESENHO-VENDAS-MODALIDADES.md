# Desenho — modalidades de venda e aviso ao dono

> Conversa de 17/09/2026. **CONSTRUÍDO em 17/09 (ver §8); migrações 69–72 APLICADAS
> em 17/09 (ledger até 20260917220000).** O que o Felipe decidiu está
> marcado como decisão.

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
- **Pedido para entrega vai para um atendente** (Felipe, 17/09, "ao menos por
  enquanto"): quando o cliente pede entrega, o agente não inventa taxa nem
  recusa — chama `transferir_humano` com o carrinho montado no motivo ("quer
  entrega; 2× X, 1× Y, R$ 69,90"). O atendente fecha a venda do jeito dele. É
  opção da conta em *Vendas* (`entrega: "atendente"` | `"nao"`), porque
  `transferir_humano` é desligável: sem ela ligada, a única opção válida é
  `"nao"` (o agente diz que só atende retirada). Default ao criar a config:
  `"atendente"` se a transferência estiver ligada, senão `"nao"`.
- Quem marca pago/retirado é o usuário da conta, em Pedidos (ver §6.1).

## 3. O modelo

`tenant_tools.config` da tool `vendas` ganha:

```json
{
  "modalidades": ["retirada"],
  "entrega": "atendente",
  "pagamentos": ["link", "na_retirada"],
  "notificacao": { "canal": "waha", "sessao": "<agência>", "destino": "55DDD…@c.us",
                   "nota_chatwoot": true },
  "eventos": ["pedido_fechado", "pagamento_confirmado", "pedido_cancelado"]
}
```

(`modalidades` só aceita `retirada` hoje; `"entrega"` dentro de `modalidades`,
`taxa_entrega_*` e `endereco_entrega` são a gaveta — o validador do painel
recusa até existirem. A chave `entrega` de cima é outra coisa: o que fazer
quando pedem entrega, `atendente` | `nao`.)

O carrinho **não é fechado** na transferência: o pedido fica `rascunho`, visível
em *Pedidos* para o atendente, e a pausa da conversa é a mesma da transferência
de hoje (o agente para de responder; a retomada segue o `retomada-pausa`).

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
pergunta endereço (entrega não existe). Se o cliente pede entrega: com
`entrega = atendente`, monta o carrinho normalmente e transfere no fim (não
antes — o atendente recebe o pedido pronto); com `nao`, avisa que só atende
retirada. Teste: mesmo diálogo em dois tenants, um de cada configuração. Com pagamento na hora, a frase certa é
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

## 8. O que foi construído (17/09) e o que falta para entrar no ar

- **Migração 69** (`20260917150000_69_vendas_modalidades.sql`, rollback com os
  4 corpos anteriores verbatim): colunas em `pedidos`; `fechar_pedido` lê
  `pagamento`/`modalidade` do jsonb e valida contra `tenant_tools.config` de
  `vendas` (`vendas_oferta()`); na retirada não expira nem trava o resolver;
  `notificar_venda` com modalidade/pagamento, `eventos` e nota-só;
  `api_agente_aviso_pedido`/`confirmar_aviso`; `painel_marcar_pedido`.
  `teste:migracao-vendas-modalidades` 53/53.
- **Painel**: *Configurações → Vendas* (`formulario-vendas.tsx`, action
  `salvarVendas`), sessão WAHA do aviso em *Clientes → cliente*
  (`salvarVendasAgencia`), *Pedidos* com modalidade/pagamento e os botões
  pago/retirado (`painel/pedidos/acoes.ts` → `painel_marcar_pedido`).
  `src/lib/tools/vendas-config.ts` lê com os mesmos defaults do banco.
- **Serviço**: seção dinâmica do prompt por conta (`pedido/oferta.ts`), tool
  `gerenciar_pedido` com parâmetro `pagamento`, `gerar_link_pagamento` some
  para quem não aceita link, aviso ao dono por WhatsApp + nota
  (`pedido/aviso.ts`) na venda fechada e no webhook de pagamento; portão com
  a exceção "pagamento na retirada" (`RE_PAGAMENTO_NA_RETIRADA`, que não
  vale quando a frase afirma "recebido/caiu"). `teste:agente-servico` 95/95,
  `teste:portao-pagamento` 56/56.
- **Ordem para entrar no ar**: aplicar a 69 → redeploy do painel → redeploy do
  agente. O painel antes da 69 quebraria em *Pedidos* (colunas novas); o
  agente antes da 69 mandaria `pagamento` que a função antiga ignora (fecha
  como link — sem erro, mas sem o comportamento novo).
- **Aviso pela inbox do agente (17/09, migração 70)** — decisão do Felipe:
  nenhuma conta precisa de sessão WAHA. O serviço abre (ou reaproveita) a
  conversa com o número do dono na inbox do agente (`Channel::Api`; o
  integrador roteia pelo `phone_number`, o `source_id` é UUID do Chatwoot —
  provado na conversa 58 da conta 57) e posta nela, com o token de usuário da
  agência (`CHATWOOT_AGENCIA_TOKEN`; o Agent Bot leva 401 em `/contacts` e
  `/conversations`). O canal é derivado no painel: sessão → `waha` (legado),
  sem sessão → `chatwoot`. Vale para venda fechada, pagamento confirmado e
  transferência. Efeito colateral tratado: o dono vira contato na inbox, e a
  resposta dele ao aviso chegaria ao agente — a conversa cujo contato é um
  destino de aviso é descartada no turno (`conversa_do_dono` no trace).
  Pendência da sessão única por conta fechou por dispensa.
- **71 (17/09)**: o fato "pagamento confirmado" que o serviço injeta no
  modelo tem fim — pedido retirado encerra o ciclo; pago sem retirar vale 24 h.
  Sem isso, o pedido pago no balcão travava a conversa em "já está pago".
- **72 (17/09, pedido do Felipe)**: *quem retira* — opção `pedir_nome` em
  *Configurações → Vendas*; com ela o banco recusa fechar sem o nome
  (`nome_retirada` na tool), coluna `pedidos.retirada_nome`, "🙋 Retira" no
  aviso e em *Pedidos*. *Endereço de retirada* + link do mapa na mesma tela:
  o serviço manda ao cliente em mensagem própria logo após fechar para
  retirada (entra em `mensagens_log`, fonte `endereco_retirada`); não é
  "localização" nativa do WhatsApp — em inbox API isso depende do integrador,
  e texto + link funciona em qualquer canal.
- **Gaveta da entrega — o caminho, quando abrir (conversa de 17/09)**: endereço
  da loja (já existe pela retirada) + tabela de taxa por distância (até N km →
  R$ X; acima → não entrega); o agente pede o endereço do cliente, o serviço
  geocodifica e mede (Google Maps Platform: Geocoding + Distance Matrix, cota
  gratuita mensal), grava `modalidade = entrega`, endereço e taxa no pedido;
  endereço que a API não resolve → `transferir_humano`. Felipe cogitou; não
  decidiu. Para retirada o link do mapa continua melhor que pino.
- **Não construído / a saber**: `pedido_cancelado` nunca dispara pela tool —
  a ação `cancelar` do modelo não passa `alvo`, então só descarta carrinho
  (venda fechada não é cancelável pelo agente hoje). O aviso existe no banco
  e no serviço para quando isso mudar. Quem marca pago no painel não é
  avisado (foi ele mesmo). Marcar pago no painel encerra a cobrança aberta
  no banco, mas o link no Asaas fica ativo até vencer sozinho (30 min).

## 7. Ordem de construção (como foi)

1. Migração: colunas em `pedidos` (`modalidade`, `pagamento_modo`, `pago_em`,
   `retirado_em`) + `api_n8n_fechar_pedido` ganhando os campos por chave nova
   no jsonb (o n8n congelado chama a mesma função — sem trocar assinatura) +
   `api_n8n_notificar_venda` lendo os campos novos e os eventos + função nova
   para o painel marcar pago/retirado.
2. Painel do cliente: *Configurações → Vendas* (pagamentos, notificação com
   nota no Chatwoot, eventos) + *Pedidos* com colunas novas e botões
   pago/retirado.
3. Serviço: `fechar` estruturado + prompt condicional ao que o tenant oferece +
   entrega → `transferir_humano` com o carrinho no motivo + webhook do
   pagamento avisando o dono (WhatsApp + nota privada) + caso novo do portão.
4. Testes: três tenants com ofertas diferentes; portão; notificação por evento.
