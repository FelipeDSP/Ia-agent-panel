// ============================================================================
// EXTRAI EVENTO — corpo do no Code do webhook do Asaas.
//
// ESTE ARQUIVO E A FONTE; a copia no JSON e injetada por
// `scripts/gerar-webhook-pagamento.mjs`.
//
// ----------------------------------------------------------------------------
// O QUE ELE FAZ, E O QUE ELE NAO FAZ
// ----------------------------------------------------------------------------
// Tira do request SO o que `api_n8n_pagamento_webhook` recebe: o token do
// header, o id do evento, o tipo, e os identificadores do pagamento. NAO decide
// nada — quem decide (token vale? evento repetido? cobranca existe? dentro do
// prazo?) e a funcao do banco, que e a UNICA que escreve `pago`.
//
// NAO REPASSA O PAYLOAD INTEIRO. O corpo do webhook traz nome e documento do
// pagador, e `pagamento_eventos` nao tem coluna para isso de proposito (61).
// O que nao chega ao banco nao vaza.
//
// O TOKEN vem do header `asaas-access-token` — e o que o Asaas manda. Corpo do
// webhook e entrada externa e nao autentica nada; um POST forjado sem o token
// certo vira `reconhecido=false` na funcao e nao produz efeito.
//
// DINHEIRO: o Asaas manda `value` em reais decimais; aqui vira INTEIRO em
// centavos, e assim segue ate o banco.
// ============================================================================
const req = $input.first().json ?? {};
const headers = req.headers ?? {};
const body = req.body ?? {};
const pagamento = body.payment ?? {};

const token = headers['asaas-access-token'] ?? headers['Asaas-Access-Token'] ?? '';

return [{
  json: {
    webhook_token: String(token),
    evento_id: String(body.id ?? ''),
    evento: String(body.event ?? ''),
    pagamento_id: pagamento.id != null ? String(pagamento.id) : null,
    link_id: pagamento.paymentLink != null ? String(pagamento.paymentLink) : null,
    referencia: pagamento.externalReference != null ? String(pagamento.externalReference) : null,
    valor_centavos: typeof pagamento.value === 'number' ? Math.round(pagamento.value * 100) : null,
  },
}];
