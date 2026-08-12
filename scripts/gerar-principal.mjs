#!/usr/bin/env node
/**
 * Gera o workflow principal a partir do repo.
 *
 * FATIA 3 — TOOLS POR PERFIL. O AI Agent deixa de ser um no com as 7 tools
 * penduradas e vira DOIS, um por perfil de plano, roteados por Switch. Tenant
 * que nao contratou vendas para de carregar o schema das 4 tools de venda em
 * toda mensagem — que e o custo que `tool_ativa` nao cobria (ele bloqueia o
 * EFEITO, nao o CUSTO).
 *
 * POR QUE DOIS AGENTS E NAO MONTAGEM DINAMICA: as conexoes `ai_tool` do n8n sao
 * estaticas na definicao do workflow; nao existe montar a lista em runtime. O
 * corte "vende ou nao vende" e o unico que nao vira combinatoria (2^7), e se
 * justifica porque as 3 tools basicas sao TOOLS_BASELINE — todo tenant tem.
 *
 * POR QUE UM GERADOR: dois system prompts mantidos a mao divergem, e a
 * divergencia nao quebra nada visivel — so faz o rateio mentir. Ja aconteceu
 * duas vezes neste repo (o WRAPPER sem a secao de resolver_conversa, e o
 * `$('Webhook1')` orfao que o n8n/README.md conta). Aqui os dois wrappers e os
 * dois system messages saem da MESMA fonte, e `npm run n8n:sincronia` falha alto
 * se divergirem.
 *
 * Reexecutavel e idempotente. Preserva o que so existe na instancia: os
 * workflowId reais dos sub-workflows.
 *
 * Uso: node scripts/gerar-principal.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const ARQ = path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json');
const w = JSON.parse(fs.readFileSync(ARQ, 'utf8'));

const no = (nome) => w.nodes.find((n) => n.name === nome);
const CRED_PG = { postgres: { id: 'MehTUROZlPmHG8kW', name: 'Agent ia Supabase' } };

// ---------------------------------------------------------------------------
// 0. Layout: o canvas e do Felipe, nao do gerador
// ---------------------------------------------------------------------------
// O gerador RECRIA cinco nos (os dois agents, Tools Ativas, Vende? e Perfil Nao
// Resolvido) em vez de editar no lugar — e recriar significava reposicionar nas
// coordenadas cravadas aqui embaixo.
//
// O efeito e que arrumar o canvas na UI e reexportar nao sobrevivia a
// `node scripts/gerar-principal.mjs`: os cinco pulavam de volta e o resto ficava
// onde estava, o que e pior que tudo errado — o desenho fica meio arrumado.
// Aconteceu em 12/08/2026, depois de o canvas ja ter sido organizado.
//
// Agora posicao e id sao snapshot ANTES de mexer e reaplicados no fim. As
// coordenadas em POSICAO_NOVA valem so para no que ainda nao existe, ou seja,
// na primeira geracao. Depois disso o canvas manda.
//
// O `id` vai junto porque o n8n regenera os ids no import; preservar evita que
// cada ciclo importar-exportar-gerar produza diff de ruido.

const LAYOUT = Object.fromEntries(w.nodes.map((n) => [n.name, { position: n.position, id: n.id }]));

const POSICAO_NOVA = {
  'AI Agent Basico': [-64, -224],
  'AI Agent Vendas': [-64, 96],
  'Tools Ativas': [-544, -64],
  'Vende?': [-304, -64],
  'Perfil Nao Resolvido': [-64, 320],
};

function restaurarLayout() {
  const novos = [];
  for (const n of w.nodes) {
    const antes = LAYOUT[n.name];
    if (antes) {
      n.position = antes.position;
      if (antes.id) n.id = antes.id;
    } else {
      n.position = POSICAO_NOVA[n.name] ?? n.position;
      novos.push(n.name);
    }
  }
  return novos;
}

// ---------------------------------------------------------------------------
// 1. Perfis
// ---------------------------------------------------------------------------
// `S` e o custo em token dos schemas daquele conjunto de tools, usado pelo
// Estima Tokens. O de vendas foi MEDIDO (622, ~89 por tool); o basico ainda e
// regra de tres e sera medido pelo mesmo metodo assim que houver execucao no
// perfil — com r ja conhecido, uma execucao basta.

const TOOLS_BASICO = [
  'Busca Conhecimento',
  'Transferir para Humano',
  "Call 'Tool - Resolver Conversa (Multi-Tenant)'",
];
const TOOLS_VENDAS = ['Consultar Catalogo', 'Gerenciar Pedido', 'Fechar Pedido', 'Cancelar Pedido'];

const PERFIS = {
  basico: { agente: 'AI Agent Basico', tools: TOOLS_BASICO, S: 266, medido: false, y: -224 },
  vendas: { agente: 'AI Agent Vendas', tools: [...TOOLS_BASICO, ...TOOLS_VENDAS], S: 622, medido: true, y: 96 },
};

// ---------------------------------------------------------------------------
// 2. Os dois wrappers, derivados do system message que esta em producao
// ---------------------------------------------------------------------------
// O de vendas e EXATAMENTE o de hoje — a fatia 3 nao pode mudar comportamento de
// quem ja tem tudo. O basico e o mesmo texto com as secoes de venda removidas.
// Derivar os dois de uma fonte so e o que garante que continuem iguais no que
// deve ser igual.

const agenteAtual = no('AI Agent') ?? no('AI Agent Vendas');
if (!agenteAtual) throw new Error('nenhum AI Agent encontrado — o workflow nao tem a forma esperada');

const smAtual = agenteAtual.parameters.options.systemMessage;
const corte = smAtual.indexOf('{{');
if (corte < 0) throw new Error('systemMessage sem a expressao do prompt do tenant');
const CAUDA = smAtual.slice(corte); // a expressao que injeta o system_prompt do tenant
const fixoAtual = smAtual.slice(1, corte);

const RE_SECOES_VENDAS = /## Ferramenta: consultar_catalogo[\s\S]*?(?=## Regras gerais)/;
const casamento = fixoAtual.match(RE_SECOES_VENDAS);
if (!casamento) throw new Error('secoes de venda nao encontradas no systemMessage — nao sei separar os perfis');

const WRAPPERS = {
  vendas: fixoAtual,
  basico: fixoAtual.replace(RE_SECOES_VENDAS, ''),
};

if (WRAPPERS.basico === WRAPPERS.vendas) throw new Error('os dois wrappers sairam iguais — a remocao nao funcionou');
if (WRAPPERS.basico.includes('consultar_catalogo')) throw new Error('wrapper basico ainda menciona tool de venda');

// ---------------------------------------------------------------------------
// 2b. Regras que remover secao nao cria
// ---------------------------------------------------------------------------
// Em 12/08/2026, com vendas descontratada, o agente basico recebeu "quero uma
// porcao de arroz" e RESPONDEU ao cliente que tinha adicionado o item, com
// preco e total — incluindo um bloco "[Used tools: Tool: Gerenciar_Pedido ...]"
// que ele mesmo escreveu. Nenhuma tool foi chamada e nenhum pedido existe.
//
// O `ACO-01` que ele citou nao veio do nada: esta na BASE DE CONHECIMENTO do
// tenant, um PDF com cardapio codificado e 34 chunks com preco. Com o cardapio
// em maos e sem ferramenta de pedido, o modelo imitou o formato.
//
// A causa e o vacuo: o wrapper basico e o de vendas MENOS as secoes. Remover
// instrucao nao cria proibicao, e modelo preenche vazio. Daqui em diante as
// proibicoes sao explicitas.

const REGRAS_TODOS = [
  '- NUNCA afirme que executou uma acao — registrar, adicionar, remover, transferir,',
  '  encerrar, consultar — sem ter recebido o retorno da ferramenta correspondente',
  '  nesta mesma conversa. Sem a ferramenta, diga que nao consegue fazer isso.',
  '- Nunca escreva no texto da resposta blocos que imitem chamada de ferramenta',
  '  (por exemplo "[Used tools: ...]"), nem invente identificadores, codigos de item,',
  '  precos ou resultados de ferramenta.',
];

const REGRAS_BASICO = [
  '- Voce NAO tem como registrar pedidos, reservar itens nem fechar compras. Se o',
  '  cliente pedir isso, diga com clareza que por aqui nao e possivel e ofereca',
  '  transferir para um atendente.',
  '- A base de conhecimento pode conter cardapio, tabela de precos e codigos de item.',
  '  Use isso para INFORMAR. Informar nao e vender: voce nao pode adicionar ao',
  '  pedido, reservar nem garantir que o preco da base esta valendo.',
];

function acrescentarRegras(wrapper, linhas) {
  const ini = wrapper.indexOf('## Regras gerais');
  if (ini < 0) throw new Error('secao "## Regras gerais" nao encontrada — nao sei onde por as regras novas');
  const resto = wrapper.slice(ini);
  const m = resto.match(/\n\s*(---|# )/);
  const fim = m ? ini + m.index : wrapper.length;
  return wrapper.slice(0, fim) + '\n' + linhas.join('\n') + wrapper.slice(fim);
}

WRAPPERS.vendas = acrescentarRegras(WRAPPERS.vendas, REGRAS_TODOS);
WRAPPERS.basico = acrescentarRegras(WRAPPERS.basico, [...REGRAS_TODOS, ...REGRAS_BASICO]);

// ---------------------------------------------------------------------------
// 3. Os dois AI Agents
// ---------------------------------------------------------------------------
// Renomear o no antigo em vez de criar do zero preserva credenciais e opcoes.

const base = JSON.parse(JSON.stringify(agenteAtual));
for (const nome of ['AI Agent', 'AI Agent Basico', 'AI Agent Vendas']) {
  w.nodes = w.nodes.filter((n) => n.name !== nome);
  delete w.connections[nome];
}

for (const [chave, p] of Object.entries(PERFIS)) {
  const n = JSON.parse(JSON.stringify(base));
  n.name = p.agente;
  n.id = `agente-${chave}`.padEnd(36, '0').slice(0, 36);
  n.position = [-64, p.y];
  n.parameters.options = {
    ...n.parameters.options,
    systemMessage: '=' + WRAPPERS[chave] + CAUDA,
    // Sem isto o Estima Tokens nao sabe quantas vezes o modelo foi chamado e
    // volta a contar uma so — o erro de 10x que a medicao de 11/08 achou.
    returnIntermediateSteps: true,
  };
  n.notes = `GERADO por scripts/gerar-principal.mjs (perfil "${chave}"). Editar aqui pela UI se perde na proxima geracao — a fonte e o repo. Os dois agents precisam continuar identicos no que nao e tool: modelo, memoria e regras gerais.`;
  n.notesInFlow = true;
  w.nodes.push(n);
}

// ---------------------------------------------------------------------------
// 4. Tools Ativas + Vende? + a falha visivel
// ---------------------------------------------------------------------------
// POSICAO: depois do `Limpa Acumulo`, e nao logo apos o `Resolve Tenant`. Assim
// roda uma vez por invocacao real do agent; antes do debounce rodaria em toda
// mensagem, inclusive nas que o `Ultima Mensagem?` descarta.
//
// JANELA CONHECIDA: entre a mensagem chegar e o perfil ser resolvido passa o
// Wait Debounce. Se alguem desligar vendas nesse intervalo, a rota usa o estado
// NOVO. Nao e grave — a trava `tool_ativa` do sub-workflow recusa a acao de
// qualquer forma —, mas o agente pode ter carregado tools que ja nao valem.

for (const nome of ['Tools Ativas', 'Vende?', 'Perfil Nao Resolvido']) {
  w.nodes = w.nodes.filter((n) => n.name !== nome);
  delete w.connections[nome];
}

w.nodes.push({
  parameters: {
    operation: 'executeQuery',
    query:
      "SELECT case when exists (\n" +
      "         select 1 from public.api_n8n_tools_ativas($1::uuid)\n" +
      "         where tool_nome = 'vendas'\n" +
      "       ) then 'vendas' else 'basico' end AS perfil;",
    options: { queryReplacement: "={{ [ $('Resolve Tenant').first().json.tenant_id ] }}" },
  },
  // `.first()` e nao `.item`: o acessor por linhagem para de resolver depois da
  // cadeia do LPOP (Split Out -> pop -> Limit), e o `Resolve Tenant` emite uma
  // linha so, entao os dois sao equivalentes quando o linking funciona.
  type: 'n8n-nodes-base.postgres',
  typeVersion: 2.6,
  position: [-544, -64],
  name: 'Tools Ativas',
  id: 'perfil-tools-ativas'.padEnd(36, '0').slice(0, 36),
  credentials: CRED_PG,
});

w.nodes.push({
  parameters: {
    rules: {
      values: Object.keys(PERFIS).map((chave) => ({
        conditions: {
          options: { caseSensitive: true, typeValidation: 'strict', version: 2 },
          conditions: [{
            id: `p-${chave}`,
            leftValue: "={{ $json.perfil }}",
            rightValue: chave,
            operator: { type: 'string', operation: 'equals' },
          }],
          combinator: 'and',
        },
        outputKey: chave,
      })),
    },
    // SEM cair no basico. Roteamento nao e medicao: o fallback do Estima Tokens
    // e `basico` porque errar cobrando a menos e melhor que a mais. Aqui o sinal
    // e oposto — cair no basico por engano faz um cliente que CONTRATOU vendas
    // perder as tools em silencio, e o sintoma chega como "o agente nao entendeu
    // meu pedido". Perfil nao resolvido e bug, e bug tem que aparecer.
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'nao_resolvido' },
  },
  type: 'n8n-nodes-base.switch',
  typeVersion: 3.2,
  position: [-304, -64],
  name: 'Vende?',
  id: 'perfil-switch'.padEnd(36, '0').slice(0, 36),
});

w.nodes.push({
  parameters: {
    errorMessage:
      "=Perfil de tools nao resolvido para o tenant {{ $('Resolve Tenant').first().json.tenant_id }}. " +
      'O no "Tools Ativas" deveria devolver "vendas" ou "basico" e nao devolveu. ' +
      'A execucao para aqui de proposito: seguir no perfil basico faria um cliente que ' +
      'contratou vendas perder as tools em silencio.',
  },
  type: 'n8n-nodes-base.stopAndError',
  typeVersion: 1,
  position: [-64, 320],
  name: 'Perfil Nao Resolvido',
  id: 'perfil-erro'.padEnd(36, '0').slice(0, 36),
});

// ---------------------------------------------------------------------------
// 5. Ligacoes
// ---------------------------------------------------------------------------
// O trecho do debounce e mantido como esta no arquivo — o gerador NAO o
// reescreve. Ele mudou depois da fatia 3 (guarda de lista vazia, ramo de
// corrida visivel, e o DEL virou LPOP), e cravar a ligacao aqui ressuscitava o
// `Limpa Acumulo`, que nao existe mais. O gerador cuida do roteamento por
// perfil; quem entrega o item ao `Tools Ativas` e o debounce, e ele se governa.

const entradaTools = Object.entries(w.connections).find(([, v]) =>
  (v.main ?? []).some((s) => (s ?? []).some((d) => d.node === 'Tools Ativas'))
);
if (!entradaTools) {
  console.error('ERRO: ninguem alimenta o "Tools Ativas". O debounce foi desligado do roteamento.');
  process.exit(1);
}
w.connections['Tools Ativas'] = { main: [[{ node: 'Vende?', type: 'main', index: 0 }]] };
w.connections['Vende?'] = {
  main: [
    ...Object.values(PERFIS).map((p) => [{ node: p.agente, type: 'main', index: 0 }]),
    [{ node: 'Perfil Nao Resolvido', type: 'main', index: 0 }],
  ],
};
// Os dois agents convergem no Estima Tokens. Nao duplica: o Switch entrega o
// item a uma saida so, entao apenas um ramo carrega dado.
for (const p of Object.values(PERFIS)) {
  w.connections[p.agente] = { main: [[{ node: 'Estima Tokens', type: 'main', index: 0 }]] };
}

// Sub-nos: modelo e memoria vao para os DOIS; cada tool so para os perfis que a
// tem. E aqui que a economia acontece.
const ligarSub = (nomeNo, tipo, agentes) => {
  const n = no(nomeNo);
  if (!n) throw new Error(`sub-no ausente: ${nomeNo}`);
  w.connections[nomeNo] = { [tipo]: [agentes.map((a) => ({ node: a, type: tipo, index: 0 }))] };
};

const TODOS = Object.values(PERFIS).map((p) => p.agente);
ligarSub('OpenAI Chat Model', 'ai_languageModel', TODOS);
ligarSub('Redis Chat Memory', 'ai_memory', TODOS);

for (const tool of [...TOOLS_BASICO, ...TOOLS_VENDAS]) {
  const agentes = Object.values(PERFIS).filter((p) => p.tools.includes(tool)).map((p) => p.agente);
  ligarSub(tool, 'ai_tool', agentes);
}

// ---------------------------------------------------------------------------
// 6. Referencias por NOME ao agent — as tres que quebrariam
// ---------------------------------------------------------------------------
// `$('AI Agent')` aparecia em tres nos, e a pior nao era a obvia: o
// `Envia Mensagem Chatwoot` tambem referenciava. Com dois agents, UM DOS PERFIS
// PARARIA DE RESPONDER AO CLIENTE. Todos passam a ler do `Estima Tokens`, que e
// no unico e sempre esta no caminho, e ja devolve `output`.

let trocas = 0;
for (const n of w.nodes) {
  if (n.name === 'Estima Tokens') continue;
  const antes = JSON.stringify(n.parameters ?? {});
  const depois = antes.split("$('AI Agent').item.json.output").join("$('Estima Tokens').item.json.output");
  if (antes !== depois) {
    n.parameters = JSON.parse(depois);
    trocas++;
  }
}

// ---------------------------------------------------------------------------
// 7. Estima Tokens: corpo do arquivo, com os wrappers e os S por perfil
// ---------------------------------------------------------------------------
const est = no('Estima Tokens');
const corpo = fs.readFileSync(path.join(RAIZ, 'n8n', 'estima-tokens.js'), 'utf8');
for (const marca of ['__WRAPPERS__', '__PERFIS_S__']) {
  if (!corpo.includes(marca)) throw new Error(`n8n/estima-tokens.js sem o marcador ${marca}`);
}

const paraLiteral = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const mapaWrappers =
  '{\n' + Object.entries(WRAPPERS).map(([k, v]) => `  ${k}: \`${paraLiteral(v)}\``).join(',\n') + ',\n}';
const mapaS =
  '{ ' + Object.entries(PERFIS).map(([k, p]) => `${k}: ${p.S}`).join(', ') + ' }';

est.parameters.jsCode = corpo.replace('__WRAPPERS__', mapaWrappers).replace('__PERFIS_S__', mapaS);

// Guarda contra a classe de bug que a fatia 3 quase repetiu: referencia ao agent
// por NOME quebra no perfil cujo nome nao casar, e so em runtime. Olha o CODIGO,
// nao os comentarios — o cabecalho do arquivo cita "AI Agent" varias vezes de
// proposito, explicando justamente por que nao se deve referencia-lo.
const semComentarios = est.parameters.jsCode
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');
if (semComentarios.includes("$('AI Agent")) {
  throw new Error("Estima Tokens ainda referencia $('AI Agent...') em codigo — com dois agents isso quebra num dos perfis");
}

// ---------------------------------------------------------------------------
// 8. Janela de memoria
// ---------------------------------------------------------------------------
no('Redis Chat Memory').parameters.contextWindowLength = 20;

const novosNoCanvas = restaurarLayout();

fs.writeFileSync(ARQ, JSON.stringify(w, null, 2) + '\n');

console.log('agente-principal.json gerado:');
console.log(`  ${Object.keys(PERFIS).length} AI Agents, um por perfil`);
for (const [k, p] of Object.entries(PERFIS)) {
  console.log(`    ${p.agente.padEnd(18)} ${p.tools.length} tools, S=${p.S}${p.medido ? ' (medido)' : ' (a medir)'}`);
}
console.log('  + Tools Ativas -> Vende? -> [perfil] , com Perfil Nao Resolvido no fallback');
console.log(`  = ${trocas} referencia(s) a $('AI Agent') redirecionadas para o Estima Tokens`);
console.log(`  = ${w.nodes.length} nos no total`);
console.log(
  novosNoCanvas.length
    ? `  = layout preservado; ${novosNoCanvas.length} no(s) novo(s) posicionado(s): ${novosNoCanvas.join(', ')}`
    : '  = layout do canvas preservado, nenhum no reposicionado'
);
