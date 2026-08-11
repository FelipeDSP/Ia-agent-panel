#!/usr/bin/env node
/**
 * Aplica a fatia 2 de vendas ao workflow principal.
 *
 * O que faz, e por que por script:
 *
 *  1. acrescenta os 4 nos `toolWorkflow` de venda ligados ao AI Agent;
 *  2. reescreve o `System Message` do AI Agent com as secoes das tools novas;
 *  3. reescreve a constante `WRAPPER` do no `Estima Tokens` A PARTIR DO MESMO
 *     TEXTO. Este e o motivo principal de existir um gerador: mantidos a mao os
 *     dois divergem, e a divergencia nao quebra nada visivel — so faz o rateio
 *     de custo por tenant mentir. (Ja tinham divergido: o WRAPPER estava sem a
 *     secao de `resolver_conversa`, que o AI Agent tem desde que a tool entrou.)
 *  4. sobe `contextWindowLength` do Redis Chat Memory de 5 (default) para 20.
 *
 * Reexecutavel: remove o que ele mesmo adicionou antes de adicionar de novo.
 *
 * Uso: node scripts/gerar-principal-vendas.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const ARQ = path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json');
const w = JSON.parse(fs.readFileSync(ARQ, 'utf8'));

const no = (nome) => w.nodes.find((n) => n.name === nome);

// ---------------------------------------------------------------------------
// 1. Secoes de system prompt das tools novas
// ---------------------------------------------------------------------------
// Ficam ANTES de "## Regras gerais", junto das outras ferramentas.

const SECOES_VENDAS = `## Ferramenta: consultar_catalogo
Use para descobrir o que o cliente pode comprar, com preço e unidade. SEMPRE consulte antes de falar preço — nunca invente valor nem calcule desconto. Cada item vem com um id; guarde o id para usar em gerenciar_pedido.

## Ferramenta: gerenciar_pedido
Monta o pedido junto com o cliente. Ações:
- \`adicionar\`: informe produto_id (vindo de consultar_catalogo), quantidade e, se houver, observação do cliente ("sem cebola", "bem passado").
- \`remover\`: informe o produto_id do item a tirar.
- \`ver\`: mostra o pedido atual sem alterar nada.
A ferramenta SEMPRE devolve o pedido inteiro com o total. Repita esse resumo ao cliente e confirme antes de fechar. O total vem calculado — nunca some você mesmo.

## Ferramenta: fechar_pedido
Use SOMENTE quando o cliente confirmar explicitamente que o pedido está completo. Antes de chamar, repita os itens e o total e espere o "pode fechar". Depois de fechado o pedido NÃO aceita mais alteração. Se o cliente só perguntou o valor, use gerenciar_pedido com ação \`ver\`.

## Ferramenta: cancelar_pedido
Use quando o cliente desistir do pedido ou pedir para recomeçar. Cancela o pedido em aberto e libera a conversa para um novo. Confirme com o cliente antes — o carrinho é perdido.

`;

// ---------------------------------------------------------------------------
// 2. Reconstroi o system message e o WRAPPER a partir da MESMA string
// ---------------------------------------------------------------------------

const agente = no('AI Agent');
const smAtual = agente.parameters.options.systemMessage;

// O systemMessage e `=<texto fixo>{{ expressao do prompt do tenant }}`.
const corte = smAtual.indexOf('{{');
if (corte < 0) throw new Error('systemMessage sem expressao do tenant — formato inesperado');
const cauda = smAtual.slice(corte); // "{{ $('Resolve Tenant')... }}"
let fixo = smAtual.slice(1, corte); // sem o '=' inicial

// Idempotencia: tira as secoes de venda se ja estiverem la.
fixo = fixo.replace(/## Ferramenta: consultar_catalogo[\s\S]*?(?=## Regras gerais)/, '');

if (!fixo.includes('## Regras gerais')) throw new Error('systemMessage sem "## Regras gerais" — nao sei onde inserir');
const novoFixo = fixo.replace('## Regras gerais', SECOES_VENDAS + '## Regras gerais');

agente.parameters.options.systemMessage = '=' + novoFixo + cauda;

// O WRAPPER e o mesmo texto, sem o '=' e sem a expressao.
const est = no('Estima Tokens');
let code = est.parameters.jsCode;
const ini = code.indexOf('const WRAPPER = `');
const fim = code.indexOf('`;', ini);
if (ini < 0 || fim < 0) throw new Error('WRAPPER nao encontrado no Estima Tokens');

// Escapa o que quebraria o template literal.
const paraLiteral = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
code = code.slice(0, ini) + 'const WRAPPER = `' + paraLiteral(novoFixo) + code.slice(fim);

// ---------------------------------------------------------------------------
// 3. TOKENS_FERRAMENTAS — provisorio, para o Felipe recalibrar medindo
// ---------------------------------------------------------------------------
// 110 cobria 3 tools (~37 por schema). As 4 de venda tem mais parametros que a
// media, entao a estimativa e conservadora. NAO E MEDICAO: o valor real sai do
// `tokenUsageEstimate` do sub-no OpenAI Chat Model, comparando uma execucao
// antes e uma depois. Enquanto nao for medido, o rateio de custo erra para menos.
const TOKENS_PROVISORIO = 320;
code = code.replace(
  /const TOKENS_FERRAMENTAS = \d+;/,
  `const TOKENS_FERRAMENTAS = ${TOKENS_PROVISORIO}; // PROVISORIO — recalibrar medindo (ver runbook)`,
);
est.parameters.jsCode = code;

// ---------------------------------------------------------------------------
// 4. Janela de memoria: 5 (default) -> 20
// ---------------------------------------------------------------------------
// Com o carrinho reinjetado a cada turno pelas tools, 5 mensagens deixavam o
// agente perder o fio da conversa antes de fechar o pedido.
const mem = no('Redis Chat Memory');
mem.parameters.contextWindowLength = 20;

// ---------------------------------------------------------------------------
// 5. Os 4 nos toolWorkflow
// ---------------------------------------------------------------------------
// workflowId fica com placeholder: o ID real so existe depois de importar os
// sub-workflows. O runbook manda substituir — e o texto e greppavel de proposito.

const T_TENANT = "={{ $('Resolve Tenant').item.json.tenant_id }}";
const T_CONV = "={{ $('Extrair e Filtrar').item.json.conversation_id }}";
const fromAI = (nome, desc, tipo = 'string') =>
  `={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('${nome}', \`${desc}\`, '${tipo}') }}`;

const esquema = (campos) =>
  campos.map(([id, tipo]) => ({
    id, displayName: id, required: false, defaultMatch: false, display: true,
    canBeUsedToMatch: true, type: tipo,
  }));

const TOOLS = [
  {
    nome: 'Consultar Catalogo',
    placeholder: 'SUBSTITUIR_ID_CONSULTAR_CATALOGO',
    arquivo: 'Tool - Consultar Catalogo (Multi-Tenant)',
    x: 848,
    description:
      'Consulta o catálogo do cliente e devolve produtos com preço, unidade e id. Use SEMPRE antes de falar preço ou oferecer item. Nunca invente valores.',
    valores: { tenant_id: T_TENANT, termo: fromAI('termo', 'o que o cliente procura, ex: pizza, camisa, lavagem') },
    campos: [['tenant_id', 'string'], ['termo', 'string']],
  },
  {
    nome: 'Gerenciar Pedido',
    placeholder: 'SUBSTITUIR_ID_GERENCIAR_PEDIDO',
    arquivo: 'Tool - Gerenciar Pedido (Multi-Tenant)',
    x: 1008,
    description:
      'Monta o pedido do cliente. acao=adicionar (com produto_id, quantidade e observacao), acao=remover (com produto_id) ou acao=ver. Devolve sempre o pedido inteiro com o total já calculado.',
    valores: {
      tenant_id: T_TENANT,
      conversation_id: T_CONV,
      acao: fromAI('acao', 'adicionar, remover ou ver'),
      produto_id: fromAI('produto_id', 'id do produto vindo de consultar_catalogo; vazio quando acao=ver'),
      quantidade: fromAI('quantidade', 'quantas unidades; 1 se o cliente nao disser', 'number'),
      observacao: fromAI('observacao', 'observacao do cliente sobre o item, ex: sem cebola. vazio se nao houver'),
    },
    campos: [['tenant_id', 'string'], ['conversation_id', 'number'], ['acao', 'string'],
             ['produto_id', 'string'], ['quantidade', 'number'], ['observacao', 'string']],
  },
  {
    nome: 'Fechar Pedido',
    placeholder: 'SUBSTITUIR_ID_FECHAR_PEDIDO',
    arquivo: 'Tool - Fechar Pedido (Multi-Tenant)',
    x: 1168,
    description:
      'Fecha o pedido em aberto e devolve o numero e o resumo. Use SOMENTE apos o cliente confirmar que o pedido esta completo. Depois de fechado nao aceita alteracao.',
    valores: {
      tenant_id: T_TENANT,
      conversation_id: T_CONV,
      metadados: fromAI('metadados', 'json com entrega/retirada/observacao geral, ex: {"entrega":"retirada"}. vazio se nao houver'),
    },
    campos: [['tenant_id', 'string'], ['conversation_id', 'number'], ['metadados', 'string']],
  },
  {
    nome: 'Cancelar Pedido',
    placeholder: 'SUBSTITUIR_ID_CANCELAR_PEDIDO',
    arquivo: 'Tool - Cancelar Pedido (Multi-Tenant)',
    x: 1328,
    description:
      'Cancela o pedido em aberto e libera a conversa para um novo. Confirme com o cliente antes: o carrinho e perdido.',
    valores: { tenant_id: T_TENANT, conversation_id: T_CONV },
    campos: [['tenant_id', 'string'], ['conversation_id', 'number']],
  },
];

// Idempotencia: remove versoes anteriores destes nos.
const nomesVenda = new Set(TOOLS.map((t) => t.nome));
w.nodes = w.nodes.filter((n) => !nomesVenda.has(n.name));
for (const nome of nomesVenda) delete w.connections[nome];

for (const t of TOOLS) {
  w.nodes.push({
    parameters: {
      description: t.description,
      workflowId: {
        __rl: true,
        value: t.placeholder,
        mode: 'list',
        cachedResultUrl: `/workflow/${t.placeholder}`,
        cachedResultName: t.arquivo,
      },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: t.valores,
        matchingColumns: [],
        schema: esquema(t.campos),
        attemptToConvertTypes: false,
        convertFieldsToString: false,
      },
    },
    type: '@n8n/n8n-nodes-langchain.toolWorkflow',
    typeVersion: 2.2,
    position: [t.x, 576],
    id: `venda-tool-${t.placeholder.toLowerCase().slice(14, 26)}`.padEnd(36, '0').slice(0, 36),
    name: t.nome,
  });
  w.connections[t.nome] = { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] };
}

fs.writeFileSync(ARQ, JSON.stringify(w, null, 2) + '\n');

console.log('agente-principal.json atualizado:');
console.log('  + 4 nos toolWorkflow (workflowId com placeholder SUBSTITUIR_ID_*)');
console.log('  + secoes de vendas no System Message do AI Agent');
console.log('  = WRAPPER do Estima Tokens reescrito a partir do MESMO texto');
console.log(`  = TOKENS_FERRAMENTAS -> ${TOKENS_PROVISORIO} (provisorio, recalibrar medindo)`);
console.log('  = contextWindowLength do Redis Chat Memory -> 20');
