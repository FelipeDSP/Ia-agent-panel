#!/usr/bin/env node
/**
 * Gera os workflows da fatia 2 de vendas.
 *
 * Por que um gerador e nao JSON escrito a mao: o `System Message` do no
 * `AI Agent` e a constante `WRAPPER` do no `Estima Tokens` precisam ser o MESMO
 * texto. Mantidos a mao, divergem — e a divergencia nao quebra nada visivel, so
 * faz o rateio de custo por tenant mentir. Aqui os dois saem da mesma variavel.
 *
 * Reexecutavel: sempre reconstroi a partir de `n8n/workflows/agente-principal.json`,
 * removendo o que ele mesmo tenha adicionado antes.
 *
 * Uso: node scripts/gerar-workflows-vendas.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DIR = path.join(RAIZ, 'n8n', 'workflows');

const CRED_PG = { postgres: { id: 'MehTUROZlPmHG8kW', name: 'Agent ia Supabase' } };
const TOOL_NOME = 'vendas';

// IDs fixos: n8n regenera na importacao, mas JSON com id repetido e recusado.
const uid = (s) => `venda-${s}`.padEnd(36, '0').slice(0, 36);

// ---------------------------------------------------------------------------
// Blocos comuns a todo sub-workflow de venda
// ---------------------------------------------------------------------------

/**
 * `Busca Config` e `Vendas Ativa?` sao SEMPRE os dois primeiros nos depois do
 * trigger — antes de qualquer Postgres de escrita e de qualquer HTTP. Se a
 * checagem ficasse depois, uma conversa de tenant sem vendas contratada criaria
 * linha em `pedidos` antes de descobrir que a tool esta desligada: vazaria dado,
 * nao so comportamento.
 */
function blocoTrava(x = 608, y = 400) {
  return [
    {
      parameters: {
        operation: 'executeQuery',
        query: `SELECT chatwoot_url, chatwoot_token, tool_ativa, config\nFROM public.api_n8n_config_tool($1::uuid, '${TOOL_NOME}');`,
        options: { queryReplacement: '={{ [ $json.tenant_id ] }}' },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6,
      position: [x, y],
      name: 'Busca Config',
      id: uid('cfg'),
      credentials: CRED_PG,
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'v1',
              leftValue: '={{ $json.tool_ativa }}',
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
      position: [x + 224, y],
      name: 'Vendas Ativa?',
      id: uid('if'),
    },
  ];
}

function noIndisponivel(x, y) {
  return {
    parameters: {
      assignments: {
        assignments: [
          {
            id: 'off-1',
            name: 'resultado',
            type: 'string',
            // Texto para o agente repassar. Nao revela que existe um modulo de
            // vendas que o cliente nao contratou.
            value: '=Nao e possivel montar pedido por aqui. Ofereca ajuda pelos outros meios ou transfira para um atendente.',
          },
        ],
      },
      options: {},
    },
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [x, y],
    name: 'Vendas Indisponivel',
    id: uid('off'),
  };
}

function noRetorno(x, y, id = 'ok', expr = '={{ $json.resultado }}') {
  return {
    parameters: {
      assignments: {
        assignments: [
          { id: 'ok-1', name: 'resultado', type: 'string', value: expr },
        ],
      },
      options: {},
    },
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [x, y],
    name: 'Retorno',
    id: uid(id),
  };
}

// ---------------------------------------------------------------------------
// Notificacao de venda (migracao 52) — so no `fechar`
// ---------------------------------------------------------------------------
/**
 * TRES REGRAS QUE ESTA CADEIA OBEDECE, e cada uma existe por um motivo:
 *
 * 1. NOTIFICAR NUNCA DERRUBA A VENDA. O pedido ja esta fechado quando esta parte
 *    roda. Fazer o agente dizer ao cliente que deu erro num pedido correto e
 *    trocar um problema por outro. Por isso os tres nos novos tem
 *    `onError: continueRegularOutput`: falha de banco, de sessao WAHA ou de rede
 *    some para o cliente e sobra gravada em `metadados.notificacao`.
 *
 * 2. UM TERMINAL SO. A sub-workflow devolve ao agente o que o ULTIMO no
 *    executado produziu. Ramo paralelo aqui faria o retorno depender de qual
 *    ramo terminou por ultimo — as vezes o texto do pedido, as vezes a resposta
 *    do WhatsApp. Entao a notificacao fica EM SERIE e os dois caminhos
 *    (notificou / nao notificou) desaguam no MESMO `Retorno`.
 *
 * 3. `.first()` E NAO `.item`. `Reivindica Notificacao` devolve ZERO LINHAS
 *    quando nao ha o que notificar — que e o caso dos quatro tenants hoje, todos
 *    com `vendas.config = {}`. Com `alwaysOutputData` o n8n fabrica um item
 *    vazio, e item fabricado nao tem pareamento: `$('Fecha Pedido').item`
 *    estouraria "Can't get data for expression" em TODA venda de tenant sem
 *    numero configurado. `.first()` nao depende de pareamento.
 */
const TRIGGER = "$('When Executed by Another Workflow')";
function nosNotificacao() {
  return [
    {
      parameters: {
        operation: 'executeQuery',
        query: 'SELECT pedido_id, numero, sessao, destino, mensagem\n'
             + 'FROM public.api_n8n_notificar_venda($1::uuid, $2::bigint);',
        options: {
          queryReplacement: `={{ [ ${TRIGGER}.item.json.tenant_id, ${TRIGGER}.item.json.conversation_id ] }}`,
        },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6,
      position: [1280, 320],
      name: 'Reivindica Notificacao',
      id: uid('not-rei'),
      credentials: CRED_PG,
      // Zero linhas e resposta NORMAL ("nao ha o que notificar"), nao erro. Sem
      // isto o fluxo morreria aqui e o agente ficaria sem o texto do pedido.
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: 'not-1',
              // `|| ''` porque o item fabricado pelo `alwaysOutputData` nao tem
              // a chave, e `notEmpty` sobre `undefined` com typeValidation
              // estrita e erro, nao `false`.
              leftValue: "={{ $json.destino || '' }}",
              rightValue: '',
              operator: { type: 'string', operation: 'notEmpty', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1504, 320],
      name: 'Tem Notificacao?',
      id: uid('not-if'),
    },
    {
      parameters: {
        resource: 'Chatting',
        operation: 'Send Text',
        session: "={{ $('Reivindica Notificacao').first().json.sessao }}",
        chatId: "={{ $('Reivindica Notificacao').first().json.destino }}",
        // O texto vem PRONTO do banco. Montar aqui poria a formatacao numa
        // expressao que nenhum teste alcanca; no SQL ela e medida com o pedido
        // real (`npm run teste:notificar-venda`).
        text: "={{ $('Reivindica Notificacao').first().json.mensagem }}",
        requestOptions: {},
      },
      type: '@devlikeapro/n8n-nodes-waha.WAHA',
      typeVersion: 202502,
      position: [1728, 208],
      name: 'Notifica Venda WAHA',
      id: uid('not-waha'),
      credentials: { wahaApi: { id: 'gx2yKmYvYBBJ2Yhl', name: 'WAHA account' } },
      onError: 'continueRegularOutput',
    },
    {
      parameters: {
        operation: 'executeQuery',
        query: 'SELECT public.api_n8n_confirmar_notificacao($1::uuid, $2::uuid, $3::boolean, $4::text) AS confirmado;',
        options: {
          // `$json.error` so existe porque o no do WAHA esta em
          // `continueRegularOutput`: no sucesso ele nao vem. E o que separa
          // `enviado_em` de `falhou_em` — e "reservado" nunca vira "enviado" por
          // omissao.
          queryReplacement: `={{ [ ${TRIGGER}.item.json.tenant_id, $('Reivindica Notificacao').first().json.pedido_id, !$json.error, $json.error ? String($json.error.message || $json.error).slice(0, 500) : null ] }}`,
        },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6,
      position: [1952, 208],
      name: 'Confirma Notificacao',
      id: uid('not-conf'),
      credentials: CRED_PG,
      onError: 'continueRegularOutput',
    },
  ];
}

function envelope(nome, nodes, connections) {
  return { name: nome, nodes, pinData: {}, connections, active: false, settings: { executionOrder: 'v1' }, tags: [] };
}

const gravar = (arq, obj) => {
  fs.writeFileSync(path.join(DIR, arq), JSON.stringify(obj, null, 2) + '\n');
  console.log('  gerado:', arq);
};

// ---------------------------------------------------------------------------
// 1. Consultar Catalogo
// ---------------------------------------------------------------------------
{
  const nodes = [
    {
      parameters: { workflowInputs: { values: [{ name: 'tenant_id' }, { name: 'termo' }] } },
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1.1,
      position: [384, 400],
      name: 'When Executed by Another Workflow',
      id: uid('cat-trg'),
    },
    ...blocoTrava(),
    {
      parameters: {
        operation: 'executeQuery',
        /*
         * A QUERY FICOU BURRA DE PROPOSITO (migracao 41).
         *
         * Antes ela montava o texto aqui: `string_agg` + `format` + o fallback
         * 'Nenhum produto encontrado com esse termo.'. Duas consequencias ruins:
         *
         *  - o texto que o agente le vivia numa string dentro de um JSON de
         *    workflow, fora do alcance de qualquer teste — e este projeto ja
         *    perdeu producao por escapamento errado em no de workflow;
         *  - o fallback dizia "nenhum produto encontrado" sem saber se o
         *    catalogo tem 40 itens ou zero, que sao situacoes diferentes.
         *
         * Agora a funcao devolve SEMPRE uma linha, com os totais e com o texto
         * pronto. Mudar a frase passa a ser migracao com rollback, e nao
         * reimportacao manual de workflow.
         */
        query: 'SELECT texto AS resultado\nFROM public.api_n8n_buscar_produtos($1::uuid, $2::text);',
        options: { queryReplacement: '={{ [ $(\'When Executed by Another Workflow\').item.json.tenant_id, $(\'When Executed by Another Workflow\').item.json.termo ] }}' },
      },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6,
      position: [1056, 320],
      name: 'Busca Produtos',
      id: uid('cat-q'),
      credentials: CRED_PG,
    },
    noRetorno(1280, 320, 'cat-ok'),
    noIndisponivel(1056, 496),
  ];
  const connections = {
    'When Executed by Another Workflow': { main: [[{ node: 'Busca Config', type: 'main', index: 0 }]] },
    'Busca Config': { main: [[{ node: 'Vendas Ativa?', type: 'main', index: 0 }]] },
    'Vendas Ativa?': {
      main: [
        [{ node: 'Busca Produtos', type: 'main', index: 0 }],
        [{ node: 'Vendas Indisponivel', type: 'main', index: 0 }],
      ],
    },
    'Busca Produtos': { main: [[{ node: 'Retorno', type: 'main', index: 0 }]] },
  };
  gravar('tool-consultar-catalogo.json', envelope('Tool - Consultar Catalogo (Multi-Tenant)', nodes, connections));
}

// ---------------------------------------------------------------------------
// 2. Gerenciar Pedido — adicionar / remover / ver
// ---------------------------------------------------------------------------
{
  // Switch com tres saidas e nao um CASE em SQL: o CASE do Postgres so avalia o
  // ramo escolhido, mas depender dessa sutileza para que "ver" nao adicione item
  // ao carrinho e o tipo de aposta que este projeto ja pagou caro. Roteamento
  // explicito, visivel no JSON e no validador.
  const q = (sql, reps) => ({
    parameters: {
      operation: 'executeQuery',
      query: sql,
      options: { queryReplacement: reps },
    },
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    credentials: CRED_PG,
  });
  const T = "$('When Executed by Another Workflow').item.json";

  const nodes = [
    {
      parameters: {
        workflowInputs: {
          values: [
            { name: 'tenant_id' },
            { name: 'conversation_id', type: 'number' },
            { name: 'acao' },
            { name: 'produto_id' },
            { name: 'quantidade', type: 'number' },
            { name: 'observacao' },
          ],
        },
      },
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1.1,
      position: [384, 400],
      name: 'When Executed by Another Workflow',
      id: uid('ger-trg'),
    },
    ...blocoTrava(),
    {
      parameters: {
        rules: {
          values: [
            { conditions: { options: { caseSensitive: false, typeValidation: 'strict', version: 2 }, conditions: [{ id: 'a1', leftValue: `={{ ${T}.acao }}`, rightValue: 'adicionar', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, outputKey: 'adicionar' },
            { conditions: { options: { caseSensitive: false, typeValidation: 'strict', version: 2 }, conditions: [{ id: 'r1', leftValue: `={{ ${T}.acao }}`, rightValue: 'remover', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, outputKey: 'remover' },
            { conditions: { options: { caseSensitive: false, typeValidation: 'strict', version: 2 }, conditions: [{ id: 'v1', leftValue: `={{ ${T}.acao }}`, rightValue: 'ver', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, outputKey: 'ver' },
          ],
        },
        options: { fallbackOutput: 3, renameFallbackOutput: 'invalida' },
      },
      type: 'n8n-nodes-base.switch',
      typeVersion: 3.2,
      position: [1056, 400],
      name: 'Qual Acao?',
      id: uid('ger-sw'),
    },
    // `nullif(btrim(...), '')` em TODO parametro que vem do $fromAI: o valor
    // chega como string e o modelo manda VAZIA quando nao tem o dado. `''::uuid`
    // e `''::int` estouram no cast, antes de a funcao ter chance de responder —
    // foi assim que o fechamento quebrou na primeira venda real (migracao 28).
    // Com null, a funcao devolve texto que o agente repassa, que e o desenho.
    { ...q('SELECT public.api_n8n_adicionar_item($1::uuid, $2::bigint,\n' +
           '       nullif(btrim($3::text), \'\')::uuid,\n' +
           '       coalesce(nullif(btrim($4::text), \'\')::int, 1),\n' +
           '       nullif(btrim($5::text), \'\')) AS resultado;',
           `={{ [ ${T}.tenant_id, ${T}.conversation_id, ${T}.produto_id, ${T}.quantidade, ${T}.observacao ] }}`),
      position: [1280, 208], name: 'Adiciona Item', id: uid('ger-add') },
    { ...q('SELECT public.api_n8n_remover_item($1::uuid, $2::bigint, nullif(btrim($3::text), \'\')::uuid) AS resultado;',
           `={{ [ ${T}.tenant_id, ${T}.conversation_id, ${T}.produto_id ] }}`),
      position: [1280, 368], name: 'Remove Item', id: uid('ger-rem') },
    { ...q('SELECT public.api_n8n_ver_pedido($1::uuid, $2::bigint) AS resultado;',
           `={{ [ ${T}.tenant_id, ${T}.conversation_id ] }}`),
      position: [1280, 528], name: 'Ve Pedido', id: uid('ger-ver') },
    {
      parameters: {
        assignments: { assignments: [{ id: 'inv-1', name: 'resultado', type: 'string', value: '=Acao invalida. Use adicionar, remover ou ver.' }] },
        options: {},
      },
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [1280, 688],
      name: 'Acao Invalida',
      id: uid('ger-inv'),
    },
    noRetorno(1520, 400, 'ger-ok'),
    noIndisponivel(1056, 592),
  ];
  const connections = {
    'When Executed by Another Workflow': { main: [[{ node: 'Busca Config', type: 'main', index: 0 }]] },
    'Busca Config': { main: [[{ node: 'Vendas Ativa?', type: 'main', index: 0 }]] },
    'Vendas Ativa?': {
      main: [
        [{ node: 'Qual Acao?', type: 'main', index: 0 }],
        [{ node: 'Vendas Indisponivel', type: 'main', index: 0 }],
      ],
    },
    'Qual Acao?': {
      main: [
        [{ node: 'Adiciona Item', type: 'main', index: 0 }],
        [{ node: 'Remove Item', type: 'main', index: 0 }],
        [{ node: 'Ve Pedido', type: 'main', index: 0 }],
        [{ node: 'Acao Invalida', type: 'main', index: 0 }],
      ],
    },
    'Adiciona Item': { main: [[{ node: 'Retorno', type: 'main', index: 0 }]] },
    'Remove Item': { main: [[{ node: 'Retorno', type: 'main', index: 0 }]] },
    'Ve Pedido': { main: [[{ node: 'Retorno', type: 'main', index: 0 }]] },
    'Acao Invalida': { main: [[{ node: 'Retorno', type: 'main', index: 0 }]] },
  };
  gravar('tool-gerenciar-pedido.json', envelope('Tool - Gerenciar Pedido (Multi-Tenant)', nodes, connections));
}

// ---------------------------------------------------------------------------
// 3 e 4. Fechar e Cancelar — tools proprias, nao valores de um parametro
// ---------------------------------------------------------------------------
// Acao irreversivel nao fica atras de $fromAI junto com acao reversivel: o
// agente chamar "fechar" quando o cliente perguntou "quanto ficou?" trava o
// pedido, e "cancelar" por engano apaga o carrinho.
for (const [arq, nome, fn, extras, reps] of [
  ['tool-fechar-pedido.json', 'Tool - Fechar Pedido (Multi-Tenant)',
   // TEXT e nao jsonb: `$fromAI` manda string, inclusive vazia, e `''::jsonb`
   // estoura. A funcao normaliza (migracao 28) — texto solto vira observacao.
   'SELECT public.api_n8n_fechar_pedido($1::uuid, $2::bigint, $3::text) AS resultado;',
   [{ name: 'metadados' }],
   "={{ [ $('When Executed by Another Workflow').item.json.tenant_id, $('When Executed by Another Workflow').item.json.conversation_id, $('When Executed by Another Workflow').item.json.metadados ] }}"],
  ['tool-cancelar-pedido.json', 'Tool - Cancelar Pedido (Multi-Tenant)',
   'SELECT public.api_n8n_cancelar_pedido($1::uuid, $2::bigint) AS resultado;',
   [],
   "={{ [ $('When Executed by Another Workflow').item.json.tenant_id, $('When Executed by Another Workflow').item.json.conversation_id ] }}"],
]) {
  const ehFechar = arq.includes('fechar');
  const curto = ehFechar ? 'fec' : 'can';
  const nodes = [
    {
      parameters: { workflowInputs: { values: [{ name: 'tenant_id' }, { name: 'conversation_id', type: 'number' }, ...extras] } },
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1.1,
      position: [384, 400],
      name: 'When Executed by Another Workflow',
      id: uid(curto + '-trg'),
    },
    ...blocoTrava(),
    {
      parameters: { operation: 'executeQuery', query: fn, options: { queryReplacement: reps } },
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6,
      position: [1056, 320],
      name: ehFechar ? 'Fecha Pedido' : 'Cancela Pedido',
      id: uid(curto + '-q'),
      credentials: CRED_PG,
    },
    // No `fechar`, o `Retorno` le do no NOMEADO e nao de `$json`: entre ele e o
    // `Fecha Pedido` passaram a existir tres nos, e `$json.resultado` ali seria
    // a resposta do WhatsApp, nao o texto do pedido.
    ehFechar
      ? noRetorno(2176, 320, `${curto}-ok`, "={{ $('Fecha Pedido').first().json.resultado }}")
      : noRetorno(1280, 320, `${curto}-ok`),
    noIndisponivel(1056, 496),
    ...(ehFechar ? nosNotificacao() : []),
  ];
  const acao = ehFechar ? 'Fecha Pedido' : 'Cancela Pedido';
  const cn = (destino) => [{ node: destino, type: 'main', index: 0 }];
  const connections = {
    'When Executed by Another Workflow': { main: [cn('Busca Config')] },
    'Busca Config': { main: [cn('Vendas Ativa?')] },
    'Vendas Ativa?': { main: [cn(acao), cn('Vendas Indisponivel')] },
    // Em serie, um terminal so. Ver o comentario de `nosNotificacao()`.
    ...(ehFechar
      ? {
        'Fecha Pedido': { main: [cn('Reivindica Notificacao')] },
        'Reivindica Notificacao': { main: [cn('Tem Notificacao?')] },
        'Tem Notificacao?': { main: [cn('Notifica Venda WAHA'), cn('Retorno')] },
        'Notifica Venda WAHA': { main: [cn('Confirma Notificacao')] },
        'Confirma Notificacao': { main: [cn('Retorno')] },
      }
      : { [acao]: { main: [cn('Retorno')] } }),
  };
  gravar(arq, envelope(nome, nodes, connections));
}

// ---------------------------------------------------------------------------
// 5. Conserto do Resolver Conversa
// ---------------------------------------------------------------------------
// DOIS defeitos, ambos pre-existentes:
//  (a) ele buscava tool_ativa e NUNCA checava — o fluxo ia direto de Busca
//      Config para o Chatwoot. Desligar "Resolver conversa" no painel nao
//      surtia efeito nenhum;
//  (b) nao havia guarda de pedido pendente: o agente encerraria a conversa com
//      um carrinho em aberto.
{
  const arq = 'Tool - Resolver Conversa (Multi-Tenant).json';
  const w = JSON.parse(fs.readFileSync(path.join(DIR, arq), 'utf8'));
  const jaTem = w.nodes.some((n) => n.name === 'Tool Ativa?');
  if (jaTem) {
    console.log('  resolver-conversa: ja consertado, nada a fazer');
  } else {
    w.nodes.push(
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: 'ra1', leftValue: '={{ $json.tool_ativa }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
            combinator: 'and',
          },
          options: {},
        },
        type: 'n8n-nodes-base.if',
        typeVersion: 2.2,
        position: [832, 608],
        name: 'Tool Ativa?',
        id: uid('res-if'),
      },
      {
        parameters: {
          operation: 'executeQuery',
          query: 'SELECT public.api_n8n_tem_pedido_pendente($1::uuid, $2::bigint) AS pendente;',
          options: { queryReplacement: "={{ [ $('When Executed by Another Workflow').item.json.tenant_id, $('When Executed by Another Workflow').item.json.conversation_id ] }}" },
        },
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.6,
        position: [1056, 512],
        name: 'Tem Pedido Pendente',
        id: uid('res-ped'),
        credentials: CRED_PG,
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: 'rp1', leftValue: '={{ $json.pendente }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
            combinator: 'and',
          },
          options: {},
        },
        type: 'n8n-nodes-base.if',
        typeVersion: 2.2,
        position: [1280, 512],
        name: 'Pedido Pendente?',
        id: uid('res-if2'),
      },
      {
        parameters: {
          assignments: { assignments: [{ id: 'rp-1', name: 'resultado', type: 'string', value: '=Ha um pedido em aberto nesta conversa. Confirme com o cliente se ele quer fechar ou cancelar o pedido ANTES de encerrar o atendimento.' }] },
          options: {},
        },
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [1520, 400],
        name: 'Pedido em Aberto',
        id: uid('res-pen'),
      },
      {
        parameters: {
          assignments: { assignments: [{ id: 'ro-1', name: 'resultado', type: 'string', value: '=Nao foi possivel encerrar por aqui. Despeca-se do cliente normalmente.' }] },
          options: {},
        },
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [1056, 720],
        name: 'Tool Indisponivel',
        id: uid('res-off'),
      },
    );
    // Reposiciona o que ja existia para caber o fluxo novo.
    const mv = (nome, pos) => { const n = w.nodes.find((x) => x.name === nome); if (n) n.position = pos; };
    mv('Resolve no Chatwoot', [1520, 592]);
    mv('Retorno Sucesso', [1760, 592]);

    w.connections['Busca Config'] = { main: [[{ node: 'Tool Ativa?', type: 'main', index: 0 }]] };
    w.connections['Tool Ativa?'] = {
      main: [
        [{ node: 'Tem Pedido Pendente', type: 'main', index: 0 }],
        [{ node: 'Tool Indisponivel', type: 'main', index: 0 }],
      ],
    };
    w.connections['Tem Pedido Pendente'] = { main: [[{ node: 'Pedido Pendente?', type: 'main', index: 0 }]] };
    w.connections['Pedido Pendente?'] = {
      main: [
        [{ node: 'Pedido em Aberto', type: 'main', index: 0 }],
        [{ node: 'Resolve no Chatwoot', type: 'main', index: 0 }],
      ],
    };
    fs.writeFileSync(path.join(DIR, arq), JSON.stringify(w, null, 2) + '\n');
    console.log('  consertado:', arq, '(guarda de tool_ativa + guarda de pedido pendente)');
  }
}

console.log('\nSub-workflows prontos. O principal e gerado por gerar-principal-vendas.mjs.');
