#!/usr/bin/env node
/**
 * Gera `n8n/workflows/tool-gerenciar-pedido.json` — a ferramenta de pedido
 * FUNDIDA (adicionar | remover | ver | fechar | cancelar) — a partir de
 * `n8n/tool-pedido-acoes.mjs`.
 *
 * ---------------------------------------------------------------------------
 * O QUE A FUSÃO É
 *
 * Três sub-workflows (`gerenciar`, `fechar`, `cancelar`) viram um. O molde é o
 * do `gerenciar`, que já tinha a forma certa:
 *
 *   Trigger -> Busca Config -> Vendas Ativa?
 *     Vendas Ativa? -> Qual Acao? | Vendas Indisponivel
 *     Qual Acao?    -> <um nó Postgres por ação> | Acao Invalida
 *     todos         -> Retorno
 *
 * Fundir é acrescentar dois ramos ao `Qual Acao?` e trazer a lógica dos outros
 * dois. A lista de ações NÃO está aqui: está em `tool-pedido-acoes.mjs`, e o
 * switch, a description do principal e a seção do prompt saem todos de lá.
 *
 * ---------------------------------------------------------------------------
 * O RAMO `fechar` CARREGA A NOTIFICAÇÃO AO DONO, e isso muda o `Retorno`
 *
 * O sub-workflow de fechar tinha, depois do `Fecha Pedido`, a cadeia
 * `Reivindica Notificacao -> Tem Notificacao? -> Notifica Venda WAHA ->
 * Confirma Notificacao`. Ela vem inteira, com os mesmos `onError` e
 * `alwaysOutputData` — sem eles, WAHA fora do ar derrubaria o fechamento.
 *
 * Só que depois dessa cadeia `$json` é a saída do `Confirma Notificacao`, não o
 * resultado do fechamento. O `Retorno` único lê `$json.resultado`; nos outros
 * quatro ramos isso é o retorno do Postgres, e no `fechar` seria `undefined`.
 * Por isso existe o `Resultado do Fechamento`: um Set que recupera
 * `$('Fecha Pedido').first().json.resultado` e entra no `Retorno` com o mesmo
 * formato dos demais. TODA ação termina em `Retorno` — ramo sem destino é o modo
 * de falha conhecido deste projeto.
 *
 * ---------------------------------------------------------------------------
 * PRESERVA `id` E `position` do arquivo existente (mesma escolha do
 * `gerar-principal.mjs`), então organizar o canvas na UI não é apagado a cada
 * geração. NÃO importa nada: importar é passo humano.
 *
 * Uso: node scripts/gerar-tool-pedido.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACOES, ENTRADAS, NOME_WORKFLOW, TOOL_NOME, textoAcaoInvalida,
} from '../n8n/tool-pedido-acoes.mjs';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const ARQ = path.join(RAIZ, 'n8n', 'workflows', 'tool-gerenciar-pedido.json');

// As mesmas credenciais dos sub-workflows originais. São ids da instância —
// `n8n-validar` recusa placeholder.
const CRED_PG = { postgres: { id: 'MehTUROZlPmHG8kW', name: 'Agent ia Supabase' } };
const CRED_WAHA = { wahaApi: { id: 'gx2yKmYvYBBJ2Yhl', name: 'WAHA account' } };

const LAYOUT = fs.existsSync(ARQ)
  ? Object.fromEntries(
      JSON.parse(fs.readFileSync(ARQ, 'utf8')).nodes.map((n) => [n.name, { position: n.position, id: n.id }]),
    )
  : {};

const idDe = (s) => s.toLowerCase().replace(/[^a-z]+/g, '-').padEnd(36, '0').slice(0, 36);
const TRG = 'When Executed by Another Workflow';
const entrada = (campo) => `$('${TRG}').item.json.${campo}`;

// ---------------------------------------------------------------------------
// Nós
// ---------------------------------------------------------------------------
const nodes = [];

nodes.push({
  parameters: { workflowInputs: { values: ENTRADAS } },
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  typeVersion: 1.1,
  position: [384, 400],
  name: TRG,
  id: 'venda-ger-trg'.padEnd(36, '0'),
});

// `tool_ativa` É A PRIMEIRA COISA. O principal é compartilhado por todos os
// clientes; esta checagem é o que impede a ferramenta de valer para quem não
// contratou. A fusão não abre exceção.
nodes.push({
  parameters: {
    operation: 'executeQuery',
    query: `SELECT chatwoot_url, chatwoot_token, tool_ativa, config\nFROM public.api_n8n_config_tool($1::uuid, '${TOOL_NOME}');`,
    options: { queryReplacement: '={{ [ $json.tenant_id ] }}' },
  },
  type: 'n8n-nodes-base.postgres',
  typeVersion: 2.6,
  position: [608, 400],
  name: 'Busca Config',
  id: 'venda-cfg'.padEnd(36, '0'),
  credentials: CRED_PG,
});

nodes.push({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'v1', leftValue: '={{ $json.tool_ativa }}', rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  },
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [832, 400],
  name: 'Vendas Ativa?',
  id: 'venda-if'.padEnd(36, '0'),
});

// O switch: UMA regra por ação, na ordem de ACOES, e o fallback é a última
// saída. `caseSensitive: false` porque o modelo escreve "Fechar" às vezes.
nodes.push({
  parameters: {
    rules: {
      values: ACOES.map((a) => ({
        conditions: {
          options: { caseSensitive: false, typeValidation: 'strict', version: 2 },
          conditions: [{
            id: `acao-${a.acao}`,
            leftValue: `={{ ${entrada('acao')} }}`,
            rightValue: a.acao,
            operator: { type: 'string', operation: 'equals' },
          }],
          combinator: 'and',
        },
        outputKey: a.acao,
      })),
    },
    options: { fallbackOutput: ACOES.length, renameFallbackOutput: 'invalida' },
  },
  type: 'n8n-nodes-base.switch',
  typeVersion: 3.2,
  position: [1056, 400],
  name: 'Qual Acao?',
  id: 'venda-ger-sw'.padEnd(36, '0'),
});

// Um nó Postgres por ação. A query é a do sub-workflow original, verbatim; o
// `queryReplacement` é derivado de `params`, na ordem de `$1..$n` — então a
// contagem de parâmetros não tem como divergir da query (o validador confere
// as duas de qualquer jeito).
ACOES.forEach((a, i) => {
  nodes.push({
    parameters: {
      operation: 'executeQuery',
      query: a.query,
      options: {
        queryReplacement: `={{ [ ${a.params.map(entrada).join(', ')} ] }}`,
      },
    },
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position: [1280, 160 + i * 128],
    name: a.no,
    id: idDe(`venda-ger-${a.acao}`),
    credentials: CRED_PG,
  });
});

nodes.push({
  parameters: {
    assignments: { assignments: [{ id: 'inv-1', name: 'resultado', type: 'string', value: `=${textoAcaoInvalida()}` }] },
    options: {},
  },
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  position: [1280, 160 + ACOES.length * 128],
  name: 'Acao Invalida',
  id: 'venda-ger-inv'.padEnd(36, '0'),
});

// --- a cadeia de notificação do `fechar`, trazida inteira do sub-workflow ---
const fechar = ACOES.find((a) => a.notificaVenda);
if (!fechar) throw new Error('nenhuma ação marcada com notificaVenda — o ramo de notificação ficaria sem dono');

nodes.push({
  parameters: {
    operation: 'executeQuery',
    query: 'SELECT pedido_id, numero, sessao, destino, mensagem\nFROM public.api_n8n_notificar_venda($1::uuid, $2::bigint);',
    options: { queryReplacement: `={{ [ ${entrada('tenant_id')}, ${entrada('conversation_id')} ] }}` },
  },
  type: 'n8n-nodes-base.postgres',
  typeVersion: 2.6,
  position: [1520, 208],
  name: 'Reivindica Notificacao',
  id: 'venda-not-rei'.padEnd(36, '0'),
  credentials: CRED_PG,
  // Sem estes dois, a notificação falhando (ou não havendo o que notificar)
  // derrubaria o FECHAMENTO — que já aconteceu no banco. Eram assim no
  // sub-workflow de fechar e continuam.
  alwaysOutputData: true,
  onError: 'continueRegularOutput',
});

nodes.push({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'not-1', leftValue: "={{ $json.destino || '' }}", rightValue: '',
        operator: { type: 'string', operation: 'notEmpty', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  },
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [1744, 208],
  name: 'Tem Notificacao?',
  id: 'venda-not-if'.padEnd(36, '0'),
});

nodes.push({
  parameters: {
    resource: 'Chatting',
    operation: 'Send Text',
    session: "={{ $('Reivindica Notificacao').first().json.sessao }}",
    chatId: "={{ $('Reivindica Notificacao').first().json.destino }}",
    text: "={{ $('Reivindica Notificacao').first().json.mensagem }}",
    requestOptions: {},
  },
  type: '@devlikeapro/n8n-nodes-waha.WAHA',
  typeVersion: 202502,
  position: [1968, 112],
  name: 'Notifica Venda WAHA',
  id: 'venda-not-waha'.padEnd(36, '0'),
  credentials: CRED_WAHA,
  onError: 'continueRegularOutput',
});

nodes.push({
  parameters: {
    operation: 'executeQuery',
    query: 'SELECT public.api_n8n_confirmar_notificacao($1::uuid, $2::uuid, $3::boolean, $4::text) AS confirmado;',
    options: {
      queryReplacement: `={{ [ ${entrada('tenant_id')}, $('Reivindica Notificacao').first().json.pedido_id, !$json.error, $json.error ? String($json.error.message || $json.error).slice(0, 500) : null ] }}`,
    },
  },
  type: 'n8n-nodes-base.postgres',
  typeVersion: 2.6,
  position: [2192, 112],
  name: 'Confirma Notificacao',
  id: 'venda-not-conf'.padEnd(36, '0'),
  credentials: CRED_PG,
  onError: 'continueRegularOutput',
});

// O que devolve ao `Retorno` o resultado do FECHAMENTO, e não o da notificação.
nodes.push({
  parameters: {
    assignments: {
      assignments: [{
        id: 'fech-1', name: 'resultado', type: 'string',
        value: `={{ $('${fechar.no}').first().json.resultado }}`,
      }],
    },
    options: {},
  },
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  position: [2416, 208],
  name: 'Resultado do Fechamento',
  id: 'venda-ger-fech-res'.padEnd(36, '0'),
});

nodes.push({
  parameters: {
    assignments: { assignments: [{ id: 'ok-1', name: 'resultado', type: 'string', value: '={{ $json.resultado }}' }] },
    options: {},
  },
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  position: [2640, 400],
  name: 'Retorno',
  id: 'venda-ger-ok'.padEnd(36, '0'),
});

nodes.push({
  parameters: {
    assignments: {
      assignments: [{
        id: 'off-1', name: 'resultado', type: 'string',
        value: '=Nao e possivel montar pedido por aqui. Ofereca ajuda pelos outros meios ou transfira para um atendente.',
      }],
    },
    options: {},
  },
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  position: [1056, 640],
  name: 'Vendas Indisponivel',
  id: 'venda-off'.padEnd(36, '0'),
});

// ---------------------------------------------------------------------------
// Ligações — TODA ação termina em `Retorno`
// ---------------------------------------------------------------------------
const cx = (destino) => [{ node: destino, type: 'main', index: 0 }];

const connections = {
  [TRG]: { main: [cx('Busca Config')] },
  'Busca Config': { main: [cx('Vendas Ativa?')] },
  'Vendas Ativa?': { main: [cx('Qual Acao?'), cx('Vendas Indisponivel')] },
  'Qual Acao?': { main: [...ACOES.map((a) => cx(a.no)), cx('Acao Invalida')] },
  'Acao Invalida': { main: [cx('Retorno')] },
  'Reivindica Notificacao': { main: [cx('Tem Notificacao?')] },
  'Tem Notificacao?': { main: [cx('Notifica Venda WAHA'), cx('Resultado do Fechamento')] },
  'Notifica Venda WAHA': { main: [cx('Confirma Notificacao')] },
  'Confirma Notificacao': { main: [cx('Resultado do Fechamento')] },
  'Resultado do Fechamento': { main: [cx('Retorno')] },
};
for (const a of ACOES) {
  connections[a.no] = { main: [cx(a.notificaVenda ? 'Reivindica Notificacao' : 'Retorno')] };
}

// Preserva id e posição de quem já existia.
for (const n of nodes) {
  const antes = LAYOUT[n.name];
  if (antes) { n.position = antes.position; if (antes.id) n.id = antes.id; }
}

const w = {
  name: NOME_WORKFLOW,
  nodes,
  pinData: {},
  connections,
  active: false,
  settings: { executionOrder: 'v1' },
  tags: [],
};

fs.writeFileSync(ARQ, JSON.stringify(w, null, 2) + '\n');

// Guarda: cada ação de ACOES tem um nó, uma saída do switch e um caminho até
// `Retorno`. Se alguém acrescentar uma ação lá e esquecer aqui, este é o lugar
// que reclama — antes de o arquivo existir.
const nomes = new Set(nodes.map((n) => n.name));
for (const a of ACOES) {
  if (!nomes.has(a.no)) throw new Error(`ação ${a.acao} sem nó`);
}
const alcanca = (de, alvo, vistos = new Set()) => {
  if (de === alvo) return true;
  if (vistos.has(de)) return false;
  vistos.add(de);
  return (connections[de]?.main ?? []).flat().some((c) => alcanca(c.node, alvo, vistos));
};
for (const a of ACOES) {
  if (!alcanca(a.no, 'Retorno')) throw new Error(`ação ${a.acao} não chega ao Retorno`);
}
if (!alcanca('Acao Invalida', 'Retorno')) throw new Error('Acao Invalida não chega ao Retorno');

const novos = nodes.filter((n) => !LAYOUT[n.name]).map((n) => n.name);
console.log(`escrito: ${path.relative(RAIZ, ARQ)} (${nodes.length} nós, ${ACOES.length} ações)`);
if (novos.length) console.log(`  nós novos (posição padrão): ${novos.join(', ')}`);
console.log('IMPORTAR É PASSO HUMANO — este script não fala com a instância.');
