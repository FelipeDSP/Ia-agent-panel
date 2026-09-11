#!/usr/bin/env node
/**
 * Gera `n8n/workflows/webhook-pagamento-asaas.json` — o webhook que RECEBE a
 * confirmação do Asaas e AVISA o cliente.
 *
 * ---------------------------------------------------------------------------
 * A FORMA
 *
 *   Webhook (POST /asaas-pagamento-sandbox)
 *     -> Extrai Evento (Code)                       token, ids, valor em centavos
 *     -> Aplica Webhook (Postgres)                  api_n8n_pagamento_webhook — a UNICA que escreve `pago`
 *     -> Responde 200                               SEMPRE, com o estado, e ANTES de notificar
 *          -> Aplicou?      sim -> Credencial Chatwoot -> Notifica Cliente -> Confirma Notificado
 *          -> Precisa Humano? sim -> Credencial (humano) -> Nota Privada Fora do Prazo
 *
 * ---------------------------------------------------------------------------
 * POR QUE "RESPONDE 200" VEM ANTES E SEMPRE
 *
 * 15 falhas consecutivas INTERROMPEM a fila do Asaas (medido na doc, 10/09), e
 * a doc manda não esperar processamento demorado para responder. Então a
 * resposta sai logo depois do banco, com o ESTADO (`reconhecido`,
 * `ja_processado`, `aplicou`, `motivo`) — e a notificação ao cliente acontece
 * DEPOIS, sem segurar o Asaas. Token errado também recebe 200: a função já
 * devolveu `reconhecido=false` sem efeito nenhum, e responder 401 a um forjador
 * não protege nada — enquanto responder 401 ao Asaas de verdade, por um token
 * mal configurado do nosso lado, derrubaria a fila inteira.
 *
 * ---------------------------------------------------------------------------
 * A NOTIFICAÇÃO SAI PELO MESMO CAMINHO DO `Envia Mensagem Chatwoot`
 *
 * Mesma credencial (`api_n8n_credencial_chatwoot`, o token de Agent Bot), mesmo
 * endpoint, mesmo `message_type: 'outgoing'`. É isso que faz o `Roteia Evento`
 * do principal ver `sender.type = 'agent_bot'` no webhook de volta e NÃO
 * pausar a conversa — `tests/notificacao-nao-pausa.mjs` prova a regra lendo o
 * switch do JSON; a verificação na instância está no roteiro do doc.
 *
 * O texto vem do banco (`mensagem`, escrito por `api_n8n_pagamento_webhook`),
 * então o valor e o número do pedido não são redigidos aqui nem pelo modelo.
 *
 * ---------------------------------------------------------------------------
 * FORA DO PRAZO: a função não reabre o pedido e devolve `precisa_humano`. O
 * webhook manda uma NOTA PRIVADA (o cliente não vê) com o que aconteceu. A
 * política de expiração (`POLITICA_EXPIRACAO` em tool-pagamento-fonte.mjs)
 * decide se existe um passo ATIVO de desativar o link — pendente da sonda B —
 * e este gerador NÃO liga nada disso enquanto ela for `null`.
 *
 * Uso: node scripts/gerar-webhook-pagamento.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLITICA_EXPIRACAO } from '../n8n/tool-pagamento-fonte.mjs';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const ARQ = path.join(RAIZ, 'n8n', 'workflows', 'webhook-pagamento-asaas.json');
const FONTE_EXTRAI = path.join(RAIZ, 'n8n', 'webhook-pagamento-extrai.js');
const CRED_PG = { postgres: { id: 'MehTUROZlPmHG8kW', name: 'Agent ia Supabase' } };

// Path próprio, sem colidir com `agente-lavanderia-chatwoot-teste-teste`
// (principal) nem `chatwoot-sandbox-pagamento` (passo 0). É PÚBLICO: o segredo
// é o header `asaas-access-token`, validado no banco.
export const PATH_WEBHOOK = 'asaas-pagamento-sandbox';

const corpoExtrai = fs.readFileSync(FONTE_EXTRAI, 'utf8').replace(/\r\n/g, '\n');
// eslint-disable-next-line no-new-func
new Function('$input', corpoExtrai);

if (POLITICA_EXPIRACAO !== null && !['expirou_recusa', 'expirou_aceita'].includes(POLITICA_EXPIRACAO)) {
  throw new Error(`POLITICA_EXPIRACAO invalida: ${POLITICA_EXPIRACAO}`);
}

const LAYOUT = fs.existsSync(ARQ)
  ? Object.fromEntries(JSON.parse(fs.readFileSync(ARQ, 'utf8')).nodes.map((n) => [n.name, { position: n.position, id: n.id, webhookId: n.webhookId }]))
  : {};
const idDe = (s) => s.toLowerCase().replace(/[^a-z]+/g, '-').padEnd(36, '0').slice(0, 36);

const chatwootPost = (nome, pos, corpo, credNo) => ({
  parameters: {
    method: 'POST',
    url: `={{ $('${credNo}').first().json.chatwoot_url }}/api/v1/accounts/{{ $('${credNo}').first().json.chatwoot_account_id }}/conversations/{{ $('Aplica Webhook').first().json.conversation_id }}/messages`,
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'api_access_token', value: `={{ $('${credNo}').first().json.chatwoot_token }}` },
      { name: 'Content-Type', value: 'application/json' },
    ] },
    sendBody: true, contentType: 'raw', rawContentType: 'application/json',
    body: corpo,
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, name: nome, id: idDe(`wh-${nome}`),
  onError: 'continueRegularOutput',
});
const credChatwoot = (nome, pos) => ({
  parameters: {
    operation: 'executeQuery',
    query: 'SELECT chatwoot_url, chatwoot_token, chatwoot_account_id FROM public.api_n8n_credencial_chatwoot($1::uuid);',
    options: { queryReplacement: "={{ [ $('Aplica Webhook').first().json.tenant_id ] }}" },
  },
  type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: pos, name: nome, id: idDe(`wh-${nome}`), credentials: CRED_PG,
});

const nodes = [
  {
    parameters: { httpMethod: 'POST', path: PATH_WEBHOOK, responseMode: 'responseNode', options: {} },
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 300], name: 'Webhook Asaas', id: idDe('wh-webhook'),
    webhookId: LAYOUT['Webhook Asaas']?.webhookId ?? 'asaas-pagamento-sandbox-0000',
  },
  { parameters: { jsCode: corpoExtrai }, type: 'n8n-nodes-base.code', typeVersion: 2, position: [224, 300], name: 'Extrai Evento', id: idDe('wh-extrai') },
  {
    parameters: {
      operation: 'executeQuery',
      query: 'SELECT * FROM public.api_n8n_pagamento_webhook($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::integer);',
      options: { queryReplacement: '={{ [ $json.webhook_token, $json.evento_id, $json.evento, $json.pagamento_id, $json.link_id, $json.referencia, $json.valor_centavos ] }}' },
    },
    type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: [448, 300], name: 'Aplica Webhook', id: idDe('wh-aplica'), credentials: CRED_PG,
  },
  {
    parameters: {
      respondWith: 'json',
      // SO O ESTADO. Nada de tenant, conversa ou valor: a resposta vai para quem
      // chamou, e quem chamou pode nao ser o Asaas.
      responseBody: "={{ JSON.stringify({ reconhecido: $json.reconhecido, ja_processado: $json.ja_processado, aplicou: $json.aplicou, motivo: $json.motivo }) }}",
      options: {},
    },
    type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [672, 300], name: 'Responde 200', id: idDe('wh-responde'),
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'ap1', leftValue: "={{ $('Aplica Webhook').first().json.aplicou }}", rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [896, 160], name: 'Aplicou?', id: idDe('wh-if-aplicou'),
  },
  credChatwoot('Credencial Chatwoot', [1120, 96]),
  chatwootPost('Notifica Cliente', [1344, 96],
    "={{ JSON.stringify({ content: $('Aplica Webhook').first().json.mensagem, message_type: 'outgoing', private: false }) }}",
    'Credencial Chatwoot'),
  {
    parameters: {
      operation: 'executeQuery',
      query: 'SELECT public.api_n8n_confirmar_pagamento_notificado($1::uuid, $2::uuid, $3::boolean, $4::text) AS confirmado;',
      options: { queryReplacement: "={{ [ $('Aplica Webhook').first().json.tenant_id, $('Aplica Webhook').first().json.cobranca_id, !$json.error, $json.error ? String($json.error.message || $json.error).slice(0, 500) : null ] }}" },
    },
    type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: [1568, 96], name: 'Confirma Notificado', id: idDe('wh-confirma'), credentials: CRED_PG,
    onError: 'continueRegularOutput',
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'ph1', leftValue: "={{ $('Aplica Webhook').first().json.precisa_humano }}", rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [896, 464], name: 'Precisa Humano?', id: idDe('wh-if-humano'),
  },
  credChatwoot('Credencial (humano)', [1120, 464]),
  chatwootPost('Nota Privada Fora do Prazo', [1344, 464],
    // Escrita em codigo, com os fatos do banco. O pedido NAO foi reaberto: a
    // decisao e de gente.
    "={{ JSON.stringify({ content: '⚠️ *Pagamento FORA DO PRAZO — pedido nº ' + $('Aplica Webhook').first().json.pedido_numero + '*\\n\\nO Asaas confirmou um pagamento depois de a janela expirar. O pedido NÃO foi reaberto e o pagamento está retido no registro da cobrança.\\n\\nDecida: entregar e reabrir à mão, ou estornar. Motivo: ' + $('Aplica Webhook').first().json.motivo, message_type: 'outgoing', private: true }) }}",
    'Credencial (humano)'),
];

const cx = (d) => [{ node: d, type: 'main', index: 0 }];
const connections = {
  'Webhook Asaas': { main: [cx('Extrai Evento')] },
  'Extrai Evento': { main: [cx('Aplica Webhook')] },
  'Aplica Webhook': { main: [cx('Responde 200')] },
  // Fan-out DEPOIS da resposta: os dois IFs recebem o mesmo item.
  'Responde 200': { main: [[{ node: 'Aplicou?', type: 'main', index: 0 }, { node: 'Precisa Humano?', type: 'main', index: 0 }]] },
  'Aplicou?': { main: [cx('Credencial Chatwoot'), []] },
  'Credencial Chatwoot': { main: [cx('Notifica Cliente')] },
  'Notifica Cliente': { main: [cx('Confirma Notificado')] },
  'Precisa Humano?': { main: [cx('Credencial (humano)'), []] },
  'Credencial (humano)': { main: [cx('Nota Privada Fora do Prazo')] },
};

for (const n of nodes) {
  const antes = LAYOUT[n.name];
  if (antes) { n.position = antes.position; if (antes.id) n.id = antes.id; }
}

// GUARDAS
const bruto = JSON.stringify(nodes);
if (/\$fromAI\(/.test(bruto)) throw new Error('$fromAI no webhook');
if (/aact_/.test(bruto)) throw new Error('chave do Asaas cravada');
if (!/private: false/.test(nodes.find((n) => n.name === 'Notifica Cliente').parameters.body)) throw new Error('a notificacao ao cliente tem de ser publica');
if (!/private: true/.test(nodes.find((n) => n.name === 'Nota Privada Fora do Prazo').parameters.body)) throw new Error('a nota de fora do prazo tem de ser privada');
// A resposta ao Asaas vem ANTES de qualquer HTTP para fora.
const ordem = ['Webhook Asaas', 'Extrai Evento', 'Aplica Webhook', 'Responde 200'];
for (let i = 0; i < ordem.length - 1; i++) {
  if (connections[ordem[i]].main[0][0].node !== ordem[i + 1]) throw new Error(`ordem quebrada em ${ordem[i]}`);
}

const w = { name: 'Pagamento Asaas — Webhook (Sandbox)', nodes, pinData: {}, connections, active: false, settings: { executionOrder: 'v1' }, tags: [] };
fs.writeFileSync(ARQ, JSON.stringify(w, null, 2) + '\n');
console.log(`escrito: ${path.relative(RAIZ, ARQ)} (${nodes.length} nós, path /${PATH_WEBHOOK})`);
console.log(`POLITICA_EXPIRACAO = ${POLITICA_EXPIRACAO ?? 'null (pendente da sonda B) — nenhum passo de desativacao ligado'}`);
console.log('IMPORTAR É PASSO HUMANO — e só depois das 10 conversas do experimento.');
