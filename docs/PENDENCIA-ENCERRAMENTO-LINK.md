# Pendência — o encerramento do link ao fim da janela

**Estado:** desenhado em 14/09/2026, **nada implementado**. O desenho completo
está em [`ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md`](ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md)
§12, e o descritor que o código já lê é `ENCERRAMENTO` em
`n8n/tool-pagamento-fonte.mjs` (derivado de `POLITICA_EXPIRACAO`).

**Gatilho:** antes de contratar `pagamento` para qualquer tenant. É a próxima
entrega da fase, depois de o experimento da fusão fechar (§11.6 da entrega).

## Por que é pendência e não detalhe

Duas medições de 14/09 (§6.9 e §6.11 da entrega):

- **sonda B — `expirou_aceita`**: três dias depois do `endDate`, o link continua
  `active:true` e nenhum dos 16 campos mudou. O Asaas nunca fecha o link. A
  nossa janela é de minutos e o link fica de pé por dias — "pagou pedido morto"
  vira o caminho normal de quem demora, não a corrida do último segundo;
- **sonda D — `cobranca_intacta` + `remocao_recusada`**: desativar o link fecha
  a página, mas a cobrança que o cliente já gerou continua `PENDING`, com QR
  Code servido e a fatura oferecendo Pix e Open Finance. E remover o link com
  cobrança **não existe**: o Asaas recusa com "Não é permitido remover links de
  pagamento com cobranças geradas."

Então o encerramento são **dois passos sobre objetos diferentes** — `PUT
active=false` no link e `DELETE /v3/payments/{id}` em cada cobrança `PENDING`
dele (soft delete, restaurável, registro preservado) — e é **agendado**, porque
o preguiçoso só roda quando a mesma conversa age e o cliente que nunca volta é
exatamente o que deixa o link pagável para sempre.

## O que precisa ser feito (§12.3 da entrega)

1. migração: `pedido_cobrancas.encerrada_em` + `encerramento_detalhe`;
   `api_n8n_cobrancas_a_encerrar()` (global, chave do tenant por linha);
   `api_n8n_confirmar_encerramento(...)`; `revoke` + os dois `grant` em cada
   uma; rollback escrito; teste que arranja uma cobrança vencida na transação
   abortada e afirma que ela sai da varredura depois de confirmada;
2. workflow agendado no n8n (`Schedule Trigger` a cada `ENCERRAMENTO.intervalo_minutos`),
   gerado a partir do repo como os outros, lendo `ENCERRAMENTO` — não escrito
   à mão ao lado dele;
3. o texto da nota privada de `fora_do_prazo` passa a dizer se o encerramento
   já tinha rodado (cobrança encerrada e mesmo assim pagou = corrida; não
   encerrada = varredura atrasada ou falha) — dois diagnósticos diferentes para
   o atendente.

## O que NÃO muda

- `fora_do_prazo` da 61 continua obrigatório: cobre a corrida entre a janela e
  a varredura, e o encerramento que falhou;
- o encerramento não escreve em `pedidos` (não mexe no relógio da expiração de
  pedido, defeito 1 de `PENDENCIA-EXPIRACAO-PEDIDO.md`), não reabre, não
  estorna, não gera link novo.
