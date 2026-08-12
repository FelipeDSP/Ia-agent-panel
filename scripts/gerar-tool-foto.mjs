#!/usr/bin/env node
/**
 * Gera o sub-workflow "Tool - Enviar Foto do Produto".
 *
 * O agente envia UMA foto de um item do catalogo quando o cliente pede.
 *
 * FLUXO
 *
 *   Trigger (tenant_id, conversation_id, produto_id)
 *     -> Pode Enviar?        api_n8n_enviar_foto: decide E REGISTRA a tentativa
 *     -> Permitido?
 *          nao -> Resposta ao Agente (recusa com instrucao)
 *          sim -> Assina URL   Edge Function foto-produto, URL de 60s
 *              -> Baixa Foto   do Storage privado
 *              -> Envia ao Chatwoot   multipart, imagem + legenda numa mensagem
 *              -> Resposta ao Agente (confirmacao)
 *
 * A DECISAO E DO BANCO, nao daqui. `api_n8n_enviar_foto` confere contratacao,
 * produto, janela, e grava a tentativa em `fotos_enviadas` — permitida ou nao.
 * Repetir a decisao no workflow criaria duas verdades sobre a mesma coisa, que e
 * o problema que a migracao 30 consertou entre tools_ativas e config_tool.
 *
 * A TRAVA E ANTES DE QUALQUER EFEITO. Nenhum byte sai do Storage e nenhuma
 * chamada vai ao Chatwoot antes do veredicto — mesma ordem que o
 * `teste:trava-vendas` exige das tools de venda.
 *
 * MULTIPART, e nao URL no corpo: o teste de 11/08 mostrou que o Chatwoot
 * devolve 422 para `data_url` e 200 para os bytes. Ele re-hospeda a imagem, e e
 * por isso que o bucket pode continuar privado.
 *
 * Uso: node scripts/gerar-tool-foto.mjs   (npm run n8n:tool-foto)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const ARQ = path.join(RAIZ, 'n8n', 'workflows', 'tool-enviar-foto.json');
const FONTE = path.join(RAIZ, 'n8n', 'enviar-foto-resposta.js');

const CRED_PG = { postgres: { id: 'MehTUROZlPmHG8kW', name: 'Agent ia Supabase' } };

// Layout preservado como no gerador do principal: se o arquivo ja existe, o
// canvas manda. Coordenadas abaixo valem so na primeira geracao.
const LAYOUT = fs.existsSync(ARQ)
  ? Object.fromEntries(
      JSON.parse(fs.readFileSync(ARQ, 'utf8')).nodes.map((n) => [n.name, { position: n.position, id: n.id }]),
    )
  : {};

const corpoResposta = fs.readFileSync(FONTE, 'utf8');
try {
  // eslint-disable-next-line no-new-func
  new Function('$input', corpoResposta);
} catch (e) {
  console.error('ERRO: n8n/enviar-foto-resposta.js nao compila — ' + e.message);
  process.exit(1);
}

const idDe = (s) => s.toLowerCase().replace(/[^a-z]+/g, '-').padEnd(36, '0').slice(0, 36);

const nodes = [
  {
    parameters: {
      workflowInputs: {
        values: [{ name: 'tenant_id' }, { name: 'conversation_id' }, { name: 'produto_id' }],
      },
    },
    type: 'n8n-nodes-base.executeWorkflowTrigger',
    typeVersion: 1.1,
    position: [384, 400],
    id: idDe('trigger-foto'),
    name: 'When Executed by Another Workflow',
  },
  {
    parameters: {
      operation: 'executeQuery',
      query:
        'SELECT permitido, motivo, produto_nome, preco_centavos, foto_path,\n' +
        '       chatwoot_url, chatwoot_token\n' +
        '  FROM public.api_n8n_enviar_foto($1::uuid, $2::bigint, $3::uuid);',
      options: { queryReplacement: '={{ [ $json.tenant_id, $json.conversation_id, $json.produto_id ] }}' },
    },
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position: [608, 400],
    id: idDe('pode-enviar'),
    name: 'Pode Enviar?',
    credentials: CRED_PG,
    notes:
      'Decide E REGISTRA. Grava a tentativa em fotos_enviadas mesmo quando recusa — a recusa e o '
      + 'dado que diz se a trava esta trabalhando. Devolve credencial SO quando permite.',
    notesInFlow: true,
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'permitido',
            leftValue: '={{ $json.permitido }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [832, 400],
    id: idDe('permitido'),
    name: 'Permitido?',
    notes:
      'A trava vem ANTES de qualquer efeito: nenhum byte sai do Storage e nada vai ao Chatwoot '
      + 'sem o veredicto. Mesma ordem que o teste:trava-vendas exige das tools de venda.',
    notesInFlow: true,
  },
  {
    parameters: {
      method: 'POST',
      url: '={{ $env.SUPABASE_URL }}/functions/v1/foto-produto',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'x-foto-secret', value: '={{ $env.FOTO_SECRET }}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      contentType: 'raw',
      rawContentType: 'application/json',
      body:
        "={{ JSON.stringify({ tenant_id: $('When Executed by Another Workflow').first().json.tenant_id, "
        + 'foto_path: $json.foto_path }) }}',
      options: {},
    },
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1056, 304],
    id: idDe('assina-url'),
    name: 'Assina URL',
    notes:
      'O n8n nao tem credencial de Storage, e pôr service_role aqui daria a ele o banco inteiro — '
      + 'o oposto da migracao 21. A Edge Function assina so dentro da pasta do tenant, e a URL vive '
      + '60s: o unico consumidor e o proximo no.',
    notesInFlow: true,
  },
  {
    parameters: {
      url: '={{ $json.url }}',
      options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
    },
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1280, 304],
    id: idDe('baixa-foto'),
    name: 'Baixa Foto',
  },
  {
    parameters: {
      method: 'POST',
      url:
        "={{ $('Pode Enviar?').first().json.chatwoot_url }}/api/v1/accounts/"
        + "{{ $('When Executed by Another Workflow').first().json.account_id "
        + "?? $('Pode Enviar?').first().json.chatwoot_account_id }}/conversations/"
        + "{{ $('When Executed by Another Workflow').first().json.conversation_id }}/messages",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'api_access_token', value: "={{ $('Pode Enviar?').first().json.chatwoot_token }}" },
        ],
      },
      sendBody: true,
      contentType: 'multipart-form-data',
      bodyParameters: {
        parameters: [
          { parameterType: 'formBinaryData', name: 'attachments[]', inputDataFieldName: 'data' },
          // Legenda na MESMA mensagem: o teste de 11/08 confirmou que imagem +
          // content viram uma mensagem so no WhatsApp. Duas mensagens teriam
          // ordem imprevisivel.
          { name: 'content', value: "={{ $('Pode Enviar?').first().json.produto_nome }}" },
          { name: 'message_type', value: 'outgoing' },
          { name: 'private', value: 'false' },
        ],
      },
      options: {},
    },
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1504, 304],
    id: idDe('envia-chatwoot'),
    name: 'Envia ao Chatwoot',
    notes:
      'MULTIPART, nao URL no corpo: o Chatwoot devolve 422 para data_url e 200 para os bytes '
      + '(teste de 11/08). Ele re-hospeda a imagem — e por isso o bucket segue privado.',
    notesInFlow: true,
  },
  {
    parameters: {
      assignments: {
        assignments: [
          { id: 'ok-1', name: 'enviada', type: 'boolean', value: '={{ true }}' },
          {
            id: 'ok-2',
            name: 'produto_nome',
            type: 'string',
            value: "={{ $('Pode Enviar?').first().json.produto_nome }}",
          },
        ],
      },
      options: {},
    },
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [1728, 304],
    id: idDe('marca-enviada'),
    name: 'Marca Enviada',
  },
  {
    parameters: { jsCode: corpoResposta },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1952, 400],
    id: idDe('resposta-agente'),
    name: 'Resposta ao Agente',
    notes:
      'Traduz o veredicto numa frase que o AGENTE le — nao e mensagem para o cliente. Cada recusa '
      + 'diz o que houve E o que fazer, para o modelo nao improvisar a explicacao.',
    notesInFlow: true,
  },
];

const cx = (destino) => [[{ node: destino, type: 'main', index: 0 }]];

const connections = {
  'When Executed by Another Workflow': { main: cx('Pode Enviar?') },
  'Pode Enviar?': { main: cx('Permitido?') },
  'Permitido?': {
    main: [
      [{ node: 'Assina URL', type: 'main', index: 0 }],
      [{ node: 'Resposta ao Agente', type: 'main', index: 0 }],
    ],
  },
  'Assina URL': { main: cx('Baixa Foto') },
  'Baixa Foto': { main: cx('Envia ao Chatwoot') },
  'Envia ao Chatwoot': { main: cx('Marca Enviada') },
  'Marca Enviada': { main: cx('Resposta ao Agente') },
};

for (const n of nodes) {
  const antes = LAYOUT[n.name];
  if (antes) {
    n.position = antes.position;
    if (antes.id) n.id = antes.id;
  }
}

const w = {
  name: 'Tool - Enviar Foto do Produto (Multi-Tenant)',
  nodes,
  pinData: {},
  connections,
  active: false,
  settings: { executionOrder: 'v1' },
  tags: [],
};

fs.writeFileSync(ARQ, JSON.stringify(w, null, 2) + '\n');

const novos = nodes.filter((n) => !LAYOUT[n.name]).map((n) => n.name);
console.log(`tool-enviar-foto.json gerado: ${nodes.length} nos`);
console.log(
  novos.length === nodes.length
    ? '  primeira geracao — posicoes padrao'
    : novos.length
      ? `  layout preservado; ${novos.length} no(s) novo(s): ${novos.join(', ')}`
      : '  layout do canvas preservado, nenhum no reposicionado',
);
