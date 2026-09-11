#!/usr/bin/env node
/**
 * Gera `n8n/workflows/tool-gerar-link-pagamento.json` a partir de
 * `n8n/tool-pagamento-fonte.mjs` e `n8n/tool-pagamento-resposta.js`.
 *
 * ---------------------------------------------------------------------------
 * A FORMA
 *
 *   Trigger(tenant_id, conversation_id)
 *     -> Busca Config -> Pagamento Ativa?
 *          nao -> Pagamento Indisponivel -> Monta Resposta
 *          sim -> Reserva Cobranca                         (api_n8n_gerar_cobranca)
 *                  -> Reserva OK?
 *                       nao -> Embrulha Reserva -> Monta Resposta   (motivo vira frase)
 *                       sim -> Ja Existia?
 *                               sim -> Embrulha Reserva -> Monta Resposta   (URL que ja existe)
 *                               nao -> Cria Link Asaas   (HTTP, chave DO TENANT)
 *                                       -> Asaas OK?
 *                                            sim -> Registra Cobranca -> Embrulha Sucesso -> Monta Resposta
 *                                            nao -> Registra Falha    -> Embrulha Falha   -> Monta Resposta
 *     Monta Resposta -> Retorno
 *
 * `tool_ativa` E A PRIMEIRA COISA (Busca Config -> Pagamento Ativa?), como em
 * toda tool — e `api_n8n_gerar_cobranca` confere de novo por dentro. Duas
 * camadas, nenhuma decorativa.
 *
 * ---------------------------------------------------------------------------
 * O QUE O MODELO VE: a description e um schema com ZERO propriedades. Nao ha
 * `$fromAI` neste sub-workflow, e o gerador ABORTA se encontrar um — valor,
 * produto, prazo, nada vem do modelo.
 *
 * A CHAVE DO ASAAS e a do tenant, devolvida por `api_n8n_gerar_cobranca` na
 * linha da reserva, e usada no header do no HTTP por expressao. Nao ha
 * credencial do n8n para o Asaas, de proposito: credencial do n8n e uma por
 * instancia, e a chave e uma por tenant.
 *
 * Uso: node scripts/gerar-tool-pagamento.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DUE_DATE_LIMIT_DAYS, ENTRADAS, NOME_WORKFLOW, TOOL_NOME } from '../n8n/tool-pagamento-fonte.mjs';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const ARQ = path.join(RAIZ, 'n8n', 'workflows', 'tool-gerar-link-pagamento.json');
const FONTE_RESPOSTA = path.join(RAIZ, 'n8n', 'tool-pagamento-resposta.js');

const CRED_PG = { postgres: { id: 'MehTUROZlPmHG8kW', name: 'Agent ia Supabase' } };

const corpoResposta = fs.readFileSync(FONTE_RESPOSTA, 'utf8').replace(/\r\n/g, '\n');
if (!/\breturn\b/.test(corpoResposta.replace(/\/\/.*$/gm, ''))) {
  throw new Error('tool-pagamento-resposta.js sem `return` fora de comentario — o no entregaria vazio');
}
// eslint-disable-next-line no-new-func
new Function('$input', corpoResposta);   // compila antes de gravar

const LAYOUT = fs.existsSync(ARQ)
  ? Object.fromEntries(JSON.parse(fs.readFileSync(ARQ, 'utf8')).nodes.map((n) => [n.name, { position: n.position, id: n.id }]))
  : {};
const idDe = (s) => s.toLowerCase().replace(/[^a-z]+/g, '-').padEnd(36, '0').slice(0, 36);
const TRG = 'When Executed by Another Workflow';
const entrada = (campo) => `$('${TRG}').item.json.${campo}`;

const setObjeto = (nome, valor, pos) => ({
  parameters: {
    assignments: { assignments: [{ id: `${idDe(nome).slice(0, 8)}-1`, name: 'reserva', type: 'object', value: valor }] },
    options: {},
  },
  type: 'n8n-nodes-base.set', typeVersion: 3.4, position: pos, name: nome, id: idDe(`pag-${nome}`),
});

const nodes = [
  {
    parameters: { workflowInputs: { values: ENTRADAS } },
    type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 400], name: TRG, id: idDe('pag-trg'),
  },
  {
    parameters: {
      operation: 'executeQuery',
      query: `SELECT chatwoot_url, chatwoot_token, tool_ativa, config\nFROM public.api_n8n_config_tool($1::uuid, '${TOOL_NOME}');`,
      options: { queryReplacement: '={{ [ $json.tenant_id ] }}' },
    },
    type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: [224, 400], name: 'Busca Config', id: idDe('pag-cfg'), credentials: CRED_PG,
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'p1', leftValue: '={{ $json.tool_ativa }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [448, 400], name: 'Pagamento Ativa?', id: idDe('pag-if-ativa'),
  },
  // tool inativa: o motivo vira frase pelo mesmo caminho dos outros
  setObjeto('Pagamento Indisponivel', "={{ { ok: false, motivo: 'tool_inativa' } }}", [672, 592]),
  {
    parameters: {
      operation: 'executeQuery',
      // NAO HA PARAMETRO DE VALOR. A funcao le pedidos.total_centavos por dentro.
      query: 'SELECT * FROM public.api_n8n_gerar_cobranca($1::uuid, $2::bigint);',
      options: { queryReplacement: `={{ [ ${entrada('tenant_id')}, ${entrada('conversation_id')} ] }}` },
    },
    type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: [672, 304], name: 'Reserva Cobranca', id: idDe('pag-reserva'), credentials: CRED_PG,
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'r1', leftValue: '={{ $json.ok }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [896, 304], name: 'Reserva OK?', id: idDe('pag-if-ok'),
  },
  setObjeto('Embrulha Reserva', "={{ $('Reserva Cobranca').first().json }}", [1120, 496]),
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: 'j1', leftValue: '={{ $json.ja_existia }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [1120, 208], name: 'Ja Existia?', id: idDe('pag-if-existia'),
  },
  {
    parameters: {
      method: 'POST',
      // BASE E CHAVE DO TENANT, da linha da reserva. A URL e DERIVADA do ambiente
      // no banco (nunca guardada), entao chave de sandbox nunca aponta para
      // producao.
      url: "={{ $json.base_url }}/v3/paymentLinks",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'access_token', value: '={{ $json.api_key }}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      contentType: 'raw',
      rawContentType: 'application/json',
      // A UNICA conversao centavos -> decimal, na fronteira com o Asaas.
      // `vence_em` e DATA (o Asaas nao aceita hora); `dueDateLimitDays` e o
      // menor prazo do lado dele; `externalReference` e o id da cobranca, por
      // onde o webhook volta.
      body: `={{ JSON.stringify({
  name: $json.descricao,
  description: 'Pedido nº ' + $json.pedido_numero,
  billingType: 'PIX',
  chargeType: 'DETACHED',
  value: Math.round(Number($json.valor_centavos)) / 100,
  endDate: String($json.vence_em).slice(0, 10),
  dueDateLimitDays: ${DUE_DATE_LIMIT_DAYS},
  externalReference: $json.referencia_externa,
  notificationEnabled: false
}) }}`,
      options: {},
    },
    type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1344, 112], name: 'Cria Link Asaas', id: idDe('pag-http-asaas'),
    // O Asaas fora do ar NAO pode derrubar a execucao: o item segue com `error`
    // e o ramo de falha registra e devolve texto que o modelo sabe tratar.
    onError: 'continueRegularOutput',
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          { id: 'a1', leftValue: "={{ $json.id ?? '' }}", rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
          { id: 'a2', leftValue: "={{ $json.url ?? '' }}", rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
        ],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [1568, 112], name: 'Asaas OK?', id: idDe('pag-if-asaas'),
  },
  {
    parameters: {
      operation: 'executeQuery',
      query: 'SELECT public.api_n8n_registrar_cobranca($1::uuid, $2::uuid, true, $3::text, $4::text) AS registrado;',
      options: {
        queryReplacement: `={{ [ ${entrada('tenant_id')}, $('Reserva Cobranca').first().json.cobranca_id, $json.id, $json.url ] }}`,
      },
    },
    type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: [1792, 16], name: 'Registra Cobranca', id: idDe('pag-registra'), credentials: CRED_PG,
  },
  {
    parameters: {
      operation: 'executeQuery',
      query: 'SELECT public.api_n8n_registrar_cobranca($1::uuid, $2::uuid, false, null, null, $3::text) AS registrado;',
      options: {
        queryReplacement: `={{ [ ${entrada('tenant_id')}, $('Reserva Cobranca').first().json.cobranca_id, String($json.error ? ($json.error.message || JSON.stringify($json.error)) : JSON.stringify($json)).slice(0, 500) ] }}`,
      },
    },
    type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: [1792, 208], name: 'Registra Falha', id: idDe('pag-registra-falha'), credentials: CRED_PG,
  },
  {
    parameters: {
      assignments: { assignments: [
        { id: 'es-1', name: 'reserva', type: 'object', value: "={{ $('Reserva Cobranca').first().json }}" },
        { id: 'es-2', name: 'asaas', type: 'object', value: "={{ $('Cria Link Asaas').first().json }}" },
      ] },
      options: {},
    },
    type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [2016, 16], name: 'Embrulha Sucesso', id: idDe('pag-embrulha-ok'),
  },
  {
    parameters: {
      assignments: { assignments: [
        { id: 'ef-1', name: 'reserva', type: 'object', value: "={{ $('Reserva Cobranca').first().json }}" },
        { id: 'ef-2', name: 'falha_http', type: 'boolean', value: '={{ true }}' },
      ] },
      options: {},
    },
    type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [2016, 208], name: 'Embrulha Falha', id: idDe('pag-embrulha-falha'),
  },
  {
    parameters: { jsCode: corpoResposta },
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [2240, 400], name: 'Monta Resposta', id: idDe('pag-monta'),
  },
  {
    parameters: {
      assignments: { assignments: [{ id: 'ok-1', name: 'resultado', type: 'string', value: '={{ $json.resultado }}' }] },
      options: {},
    },
    type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [2464, 400], name: 'Retorno', id: idDe('pag-retorno'),
  },
];

const cx = (d) => [{ node: d, type: 'main', index: 0 }];
const connections = {
  [TRG]: { main: [cx('Busca Config')] },
  'Busca Config': { main: [cx('Pagamento Ativa?')] },
  'Pagamento Ativa?': { main: [cx('Reserva Cobranca'), cx('Pagamento Indisponivel')] },
  'Pagamento Indisponivel': { main: [cx('Monta Resposta')] },
  'Reserva Cobranca': { main: [cx('Reserva OK?')] },
  'Reserva OK?': { main: [cx('Ja Existia?'), cx('Embrulha Reserva')] },
  'Ja Existia?': { main: [cx('Embrulha Reserva'), cx('Cria Link Asaas')] },
  'Embrulha Reserva': { main: [cx('Monta Resposta')] },
  'Cria Link Asaas': { main: [cx('Asaas OK?')] },
  'Asaas OK?': { main: [cx('Registra Cobranca'), cx('Registra Falha')] },
  'Registra Cobranca': { main: [cx('Embrulha Sucesso')] },
  'Registra Falha': { main: [cx('Embrulha Falha')] },
  'Embrulha Sucesso': { main: [cx('Monta Resposta')] },
  'Embrulha Falha': { main: [cx('Monta Resposta')] },
  'Monta Resposta': { main: [cx('Retorno')] },
};

for (const n of nodes) {
  const antes = LAYOUT[n.name];
  if (antes) { n.position = antes.position; if (antes.id) n.id = antes.id; }
}

// GUARDAS antes de gravar.
const bruto = JSON.stringify(nodes);
if (/\$fromAI\(/.test(bruto)) throw new Error('$fromAI dentro do sub-workflow de pagamento — valor NUNCA vem do modelo');
if (/aact_/.test(bruto)) throw new Error('chave do Asaas cravada no JSON');
const nomes = new Set(nodes.map((n) => n.name));
const alcanca = (de, alvo, v = new Set()) => de === alvo || (!v.has(de) && (v.add(de), (connections[de]?.main ?? []).flat().some((c) => alcanca(c.node, alvo, v))));
for (const n of nomes) {
  if (n === 'Retorno') continue;
  if (!alcanca(n, 'Retorno')) throw new Error(`no "${n}" nao chega ao Retorno`);
}
if (connections[TRG].main[0][0].node !== 'Busca Config') throw new Error('tool_ativa nao e a primeira coisa');

const w = { name: NOME_WORKFLOW, nodes, pinData: {}, connections, active: false, settings: { executionOrder: 'v1' }, tags: [] };
fs.writeFileSync(ARQ, JSON.stringify(w, null, 2) + '\n');

const relido = JSON.parse(fs.readFileSync(ARQ, 'utf8')).nodes.find((n) => n.name === 'Monta Resposta').parameters.jsCode;
if (relido !== corpoResposta) throw new Error('o corpo relido difere da fonte');

console.log(`escrito: ${path.relative(RAIZ, ARQ)} (${nodes.length} nós)`);
console.log('IMPORTAR É PASSO HUMANO — e só depois das 10 conversas do experimento.');
