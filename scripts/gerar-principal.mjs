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

// Coordenadas de PRIMEIRA geracao, para no que ainda nao existe. Ficaram em
// escala antiga de proposito: o canvas real do Felipe vive na faixa de x~2000 a
// x~8400, e essas so entram se alguem gerar sobre um workflow que nao tem o no —
// caso em que ele vai ser arrastado na UI mesmo. Depois da primeira vez o canvas
// manda, e o gerador anuncia quando reposicionou algo.
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

// TEXTO CURTO DE PROPOSITO. Cada linha aqui e token em toda mensagem de todo
// tenant, e o perfil basico existe justamente para ser enxuto. Tres bullets no
// total, nao um paragrafo por proibicao.

const REGRAS_TODOS = [
  '- So afirme que registrou, transferiu, consultou ou encerrou algo DEPOIS de receber',
  '  o retorno da ferramenta. Sem retorno, diga que nao consegue — nunca invente',
  '  resultado, codigo de item, nem bloco no formato de chamada de ferramenta.',
];

// DOIS MOMENTOS, nao um. Na conversa de 12/08 o agente basico primeiro OFERECEU
// ("Quer fazer um pedido para entrega?") e so depois PROMETEU ("e so me informar
// os itens que eu registro para voce"). Proibir so a promessa deixa a oferta de
// pe, e a oferta e o que puxa o cliente para o passo em que o modelo fabrica a
// chamada de tool. A base fala de delivery; o modelo le e conclui que vende.
const REGRAS_BASICO = [
  '- Voce nao registra pedidos. Nao ofereca fazer pedido, nao pergunte se o cliente',
  '  quer pedir e nao prometa anotar itens: se ele pedir, diga que por aqui nao da e',
  '  ofereca transferir para um atendente.',
  '- Cardapio e precos da base servem para INFORMAR. Informar nao e vender.',
];

// O gerador deriva o wrapper do JSON ATUAL, que ja contem as regras da geracao
// anterior. Sem remover antes de acrescentar, cada rodada apenda de novo: a
// primeira execucao depois de reescrever o texto deixou as regras v1 E as v2
// juntas no mesmo prompt, cobrando token duplicado de todo tenant.
//
// Marcadores de TODA versao ja injetada ficam aqui para sempre. Tirar um so e
// seguro depois que nenhum workflow em uso o contiver — e como o gerador roda
// sobre o arquivo do repo, na pratica e depois de um ciclo de geracao.
const MARCADORES_REGRAS = [
  '- NUNCA afirme que executou uma acao',            // v1, 12/08/2026
  '- Nunca escreva no texto da resposta blocos',     // v1
  '- Voce NAO tem como registrar pedidos',           // v1
  '- A base de conhecimento pode conter cardapio',   // v1
  '- So afirme que registrou, transferiu',           // v2
  '- Voce nao registra pedidos',                     // v2
  '- Cardapio e precos da base servem para INFORMAR', // v2
];

function removerRegrasGeradas(wrapper) {
  const linhas = wrapper.split('\n');
  const saida = [];
  let pulando = false;
  for (const l of linhas) {
    if (MARCADORES_REGRAS.some((m) => l.startsWith(m))) { pulando = true; continue; }
    // continuacao do bullet: linha indentada logo abaixo
    if (pulando && /^\s{2,}\S/.test(l)) continue;
    pulando = false;
    saida.push(l);
  }
  return saida.join('\n');
}

function acrescentarRegras(wrapper, linhas) {
  const ini = wrapper.indexOf('## Regras gerais');
  if (ini < 0) throw new Error('secao "## Regras gerais" nao encontrada — nao sei onde por as regras novas');
  const resto = wrapper.slice(ini);
  const m = resto.match(/\n\s*(---|# )/);
  const fim = m ? ini + m.index : wrapper.length;
  return wrapper.slice(0, fim) + '\n' + linhas.join('\n') + wrapper.slice(fim);
}

WRAPPERS.vendas = acrescentarRegras(removerRegrasGeradas(WRAPPERS.vendas), REGRAS_TODOS);
WRAPPERS.basico = acrescentarRegras(removerRegrasGeradas(WRAPPERS.basico), [...REGRAS_TODOS, ...REGRAS_BASICO]);

// Idempotencia, verificada e nao presumida: rodar de novo tem que dar o mesmo
// texto. Se a remocao nao casar com o que foi injetado, isto pega na hora em vez
// de acumular silenciosamente prompt duplicado.
for (const [chave, texto] of Object.entries(WRAPPERS)) {
  const esperado = chave === 'basico' ? [...REGRAS_TODOS, ...REGRAS_BASICO] : REGRAS_TODOS;
  const relido = acrescentarRegras(removerRegrasGeradas(texto), esperado);
  if (relido !== texto) {
    console.error(`ERRO: wrapper "${chave}" nao e idempotente — a remocao das regras nao casa com a injecao.`);
    process.exit(1);
  }
  for (const m of MARCADORES_REGRAS) {
    const n = texto.split(m).length - 1;
    if (n > 1) {
      console.error(`ERRO: regra duplicada no wrapper "${chave}": ${m} aparece ${n}x`);
      process.exit(1);
    }
  }
}

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
// 6b. Extrair e Filtrar: corpo do arquivo, com o filtro compartilhado
// ---------------------------------------------------------------------------
// Era o no de MAIOR exposicao do repo ainda como string dentro de JSON: primeiro
// no depois do webhook, no caminho de todo cliente. Se ele quebra, nao ha
// degradacao parcial — o fluxo para antes de resolver o tenant.
//
// O bloco de filtro entra por marcador, da MESMA fonte que a filtragem da
// transcricao de audio vai usar. Blocklist copiada diverge, e o buraco fica no
// caminho que ninguem olhou.

const FILTRO_TEXTO = fs.readFileSync(path.join(RAIZ, 'n8n', 'filtro-texto.js'), 'utf8').trim();

function injetarFiltro(corpoNo, nomeArquivo) {
  if (!corpoNo.includes('// __FILTRO_TEXTO__')) {
    throw new Error(`${nomeArquivo} sem o marcador // __FILTRO_TEXTO__`);
  }
  return corpoNo.replace('// __FILTRO_TEXTO__', FILTRO_TEXTO);
}

{
  const ext = no('Extrair e Filtrar');
  if (!ext) throw new Error('no "Extrair e Filtrar" nao existe — o workflow nao tem a forma esperada');
  const corpoExt = injetarFiltro(
    fs.readFileSync(path.join(RAIZ, 'n8n', 'extrair-e-filtrar.js'), 'utf8'),
    'n8n/extrair-e-filtrar.js'
  );
  // Compila antes de gravar. O n8n-validar tambem checa, mas ele roda depois e
  // por fora; falhar aqui impede o JSON quebrado de existir.
  try {
    // eslint-disable-next-line no-new-func
    new Function('$json', corpoExt);
  } catch (e) {
    throw new Error('Extrair e Filtrar nao compila apos a injecao do filtro: ' + e.message);
  }
  ext.parameters.jsCode = corpoExt;
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

// ---------------------------------------------------------------------------
// 8. Modulo de audio: transcricao antes do fluxo comum
// ---------------------------------------------------------------------------
// DESENHO. O audio entra pelo mesmo `Roteia Acao[1]` que ja trata midia, e o
// texto transcrito reentra no fluxo por um ponto de convergencia unico:
//
//   Roteia Acao[0] processar ────────────────────────────────────────┐
//                                                                     ├→ Mensagem Pronta → Sync Conversa
//   Roteia Acao[1] midia → Config Audio → Audio Contratado?           │
//                            ├ nao → Avisa Midia Nao Suportada        │
//                            └ sim → Conversa Ativa?                  │
//                                     ├ nao → (nada: humano atende)   │
//                                     └ sim → Audio Curto?            │
//                                              ├ nao → Avisa Audio Longo
//                                              └ sim → Baixa Anexo → Transcreve
//                                                       → Filtra Transcricao → Roteia Transcricao
//                                                            ok        ──────┘
//                                                            bloqueado → Credencial (bloqueio)
//                                                            vazio     → Avisa Audio Falhou
//
// TRANSCREVER ANTES DO DEBOUNCE, e nao depois. A premissa de que se pagaria por
// transcricao descartada nao se sustenta: o `Acumula Mensagem` (RPUSH) roda
// ANTES do `Wait Debounce`, entao a mensagem que morre no `Ultima Mensagem?` ja
// esta no acumulador e vai ser respondida pela execucao que sobrevive. Todo
// audio precisa virar texto de qualquer forma. Depois do debounce exigiria
// guardar arquivo no Redis, que hoje guarda texto.
//
// O UNICO desperdicio real e conversa pausada, e por isso o `Conversa Ativa?`
// existe — a resposta vem da mesma query do `Config Audio`, sem round-trip novo.
//
// BLOQUEIO REUSA O CAMINHO DO TEXTO. Injection falada e injection: mesmo ataque,
// mesmo tratamento, dois nos a menos.

const AUDIO_NOS = [
  'Config Audio', 'Audio Contratado?', 'Conversa Ativa?', 'Audio Curto?',
  'Baixa Anexo', 'Transcreve', 'Filtra Transcricao', 'Roteia Transcricao',
  'Avisa Audio Longo', 'Avisa Audio Falhou', 'Mensagem Pronta',
];

// Idempotencia: remove o que a rodada anterior criou, e tambem o no antigo que
// o `Config Audio` substitui.
for (const nome of [...AUDIO_NOS, 'Credencial (midia)']) {
  w.nodes = w.nodes.filter((n) => n.name !== nome);
  delete w.connections[nome];
}

const CRED_REDIS_HTTP = { httpHeaderAuth: undefined }; // os avisos usam token do proprio item
const idDe = (s) => s.padEnd(36, '0').slice(0, 36);

// Aviso ao cliente: mesmo formato dos que ja existem. O token e a url vem do
// item que desceu do `Config Audio` pelos IFs.
const avisoChatwoot = (nome, exprMensagem, pos) => ({
  parameters: {
    method: 'POST',
    url:
      "={{ $('Config Audio').first().json.chatwoot_url }}/api/v1/accounts/" +
      "{{ $('Extrair e Filtrar').first().json.chatwoot_account_id }}/conversations/" +
      "{{ $('Extrair e Filtrar').first().json.conversation_id }}/messages",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'api_access_token', value: "={{ $('Config Audio').first().json.chatwoot_token }}" },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    contentType: 'raw',
    rawContentType: 'application/json',
    body: `={{ JSON.stringify({ content: ${exprMensagem}, message_type: 'outgoing', private: false }) }}`,
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: pos,
  name: nome,
  id: idDe(nome.toLowerCase().replace(/[^a-z]+/g, '-')),
});

w.nodes.push({
  parameters: {
    operation: 'executeQuery',
    query:
      'SELECT tool_ativa, conversa_pausada, chatwoot_url, chatwoot_token,\n' +
      '       limite_bytes, msg_audio_longo, msg_audio_falhou\n' +
      '  FROM public.api_n8n_pode_transcrever($1::uuid, $2::bigint);',
    options: {
      queryReplacement:
        "={{ [ $('Resolve Tenant').first().json.tenant_id, $('Extrair e Filtrar').first().json.conversation_id ] }}",
    },
  },
  type: 'n8n-nodes-base.postgres',
  typeVersion: 2.6,
  position: [-2496, 3744],
  name: 'Config Audio',
  id: idDe('audio-config'),
  credentials: CRED_PG,
  notes:
    'Substitui o "Credencial (midia)". Uma query com as quatro perguntas do ramo: contratou, ' +
    'conversa pausada, credencial do Chatwoot e config do modulo. Quem nao contratou recebe ' +
    'tool_ativa=false e segue para o mesmo aviso de sempre — o caminho nao cresce para ele.',
  notesInFlow: true,
});

const ifNo = (nome, cond, pos, nota) => ({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: cond,
      combinator: 'and',
    },
    options: {},
  },
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: pos,
  name: nome,
  id: idDe(nome.toLowerCase().replace(/[^a-z]+/g, '-')),
  notes: nota,
  notesInFlow: Boolean(nota),
});

w.nodes.push(ifNo('Audio Contratado?', [
  {
    id: 'e-audio',
    leftValue: "={{ $('Extrair e Filtrar').first().json.anexo.file_type }}",
    rightValue: 'audio',
    operator: { type: 'string', operation: 'equals' },
  },
  {
    id: 'contratado',
    leftValue: '={{ $json.tool_ativa }}',
    rightValue: true,
    operator: { type: 'boolean', operation: 'true', singleValue: true },
  },
], [-2288, 3744],
  'Imagem, documento e video seguem para o aviso de sempre — o escopo do modulo e SO audio. ' +
  'file_type "audio" confirmado em webhook real de nota de voz (12/08/2026).'));

w.nodes.push(ifNo('Conversa Ativa?', [
  {
    id: 'nao-pausada',
    leftValue: "={{ $('Config Audio').first().json.conversa_pausada }}",
    rightValue: false,
    operator: { type: 'boolean', operation: 'false', singleValue: true },
  },
], [-2288, 4288],
  'Humano assumiu: nao transcreve. E o UNICO desperdicio real do desenho — sem isto, cada audio ' +
  'que o cliente mandasse durante o atendimento humano seria baixado e transcrito para ser ' +
  'descartado no "Nao Pausado?". Sem saida no ramo falso: quem responde e a pessoa.'));

w.nodes.push(ifNo('Audio Curto?', [
  {
    id: 'curto',
    leftValue: "={{ $('Extrair e Filtrar').first().json.anexo.file_size }}",
    rightValue: "={{ $('Config Audio').first().json.limite_bytes }}",
    operator: { type: 'number', operation: 'lte' },
  },
], [-2064, 4288],
  'Corte por BYTES, que e proxy de duracao — o webhook nao traz duracao. ~270 KB ~= 3 min de nota ' +
  'de voz. A duracao exata so existe depois de transcrever, e vai para mensagens_log justamente ' +
  'para calibrar este corte com dado real.'));

w.nodes.push({
  parameters: {
    url: "={{ $('Extrair e Filtrar').first().json.anexo.data_url }}",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'api_access_token', value: "={{ $('Config Audio').first().json.chatwoot_token }}" },
      ],
    },
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  },
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [-1840, 4288],
  name: 'Baixa Anexo',
  id: idDe('audio-baixa'),
  notes:
    'O data_url e do PROPRIO Chatwoot, que re-hospeda o arquivo (active_storage) — nao e URL do ' +
    'WhatsApp. Por isso precisa do token do tenant para baixar.',
  notesInFlow: true,
});

w.nodes.push({
  parameters: {
    method: 'POST',
    url: 'https://api.openai.com/v1/audio/transcriptions',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'openAiApi',
    sendBody: true,
    contentType: 'multipart-form-data',
    bodyParameters: {
      parameters: [
        { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
        { name: 'model', value: 'whisper-1' },
        // verbose_json e o que devolve `duration` — a duracao EXATA, que vira
        // mensagens_log.audio_segundos. Com `json` simples viria so o texto e o
        // rateio de audio teria de ser estimado, que e o que nao queremos.
        { name: 'response_format', value: 'verbose_json' },
        { name: 'language', value: 'pt' },
      ],
    },
    options: {},
  },
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [-1616, 4288],
  name: 'Transcreve',
  id: idDe('audio-transcreve'),
  credentials: { openAiApi: { id: 'B4TZHIczm0tpk2wS', name: 'OpenAi Chatyou' } },
  notes:
    'Usa a credencial OpenAI que ja existe no n8n, por predefinedCredentialType: a chave nao ' +
    'aparece em lugar nenhum do JSON. O audio do cliente final SAI daqui para a OpenAI — ver ' +
    'docs/LGPD-TRANSCRICAO-AUDIO.md.',
  notesInFlow: true,
});

w.nodes.push({
  parameters: { jsCode: '' }, // preenchido logo abaixo, a partir do arquivo
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-1392, 4288],
  name: 'Filtra Transcricao',
  id: idDe('audio-filtra'),
});

w.nodes.push({
  parameters: {
    rules: {
      values: ['ok', 'bloqueado', 'vazio'].map((chave) => ({
        conditions: {
          options: { caseSensitive: true, typeValidation: 'strict', version: 2 },
          conditions: [{
            id: `t-${chave}`,
            leftValue: '={{ $json.status }}',
            rightValue: chave,
            operator: { type: 'string', operation: 'equals' },
          }],
          combinator: 'and',
        },
        outputKey: chave,
      })),
    },
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'inesperado' },
  },
  type: 'n8n-nodes-base.switch',
  typeVersion: 3.2,
  position: [-1168, 4288],
  name: 'Roteia Transcricao',
  id: idDe('audio-roteia'),
  notes:
    'bloqueado reusa o caminho que o texto ja tem (Credencial (bloqueio) -> Envia Resposta ' +
    'Bloqueada): injection falada e injection. O fallback existe para status inesperado nao ' +
    'virar silencio.',
  notesInFlow: true,
});

w.nodes.push(avisoChatwoot(
  'Avisa Audio Longo',
  "$('Config Audio').first().json.msg_audio_longo",
  [-2064, 4480]
));

w.nodes.push(avisoChatwoot(
  'Avisa Audio Falhou',
  "$('Config Audio').first().json.msg_audio_falhou",
  [-1168, 4480]
));

w.nodes.push({
  parameters: { jsCode: '' }, // preenchido abaixo
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-2640, 3440],
  name: 'Mensagem Pronta',
  id: idDe('mensagem-pronta'),
  notes:
    'Ponto de convergencia: o Acumula Mensagem le daqui, venha o texto do teclado ou da ' +
    'transcricao. FALHA ALTO se nao houver mensagem — emitir vazio gravaria acumulo vazio e ' +
    'chamaria o agente sem prompt.',
  notesInFlow: true,
});

// Corpo dos dois nos Code novos, do arquivo, com o filtro compartilhado.
for (const [nome, arquivo, precisaFiltro] of [
  ['Filtra Transcricao', 'filtra-transcricao.js', true],
  ['Mensagem Pronta', 'mensagem-pronta.js', false],
]) {
  let corpoNo = fs.readFileSync(path.join(RAIZ, 'n8n', arquivo), 'utf8');
  if (precisaFiltro) corpoNo = injetarFiltro(corpoNo, `n8n/${arquivo}`);
  try {
    // eslint-disable-next-line no-new-func
    new Function('$input', '$json', corpoNo);
  } catch (e) {
    throw new Error(`${arquivo} nao compila apos a injecao: ${e.message}`);
  }
  no(nome).parameters.jsCode = corpoNo;
}

// O `Audio Contratado?` entrou entre o `Config Audio` e o aviso, no lugar onde o
// aviso estava. Empurrar e inevitavel — inserir no exige largura. Vai pelo
// LAYOUT e nao por `position` direto porque o `restaurarLayout()` roda depois e
// devolveria a coordenada antiga; e idempotente, porque na proxima geracao o
// snapshot ja le a nova.
if (LAYOUT['Avisa Midia Nao Suportada']) {
  LAYOUT['Avisa Midia Nao Suportada'].position = [-2064, 3744];
}

// Fiacao ---------------------------------------------------------------------
const cx = (destino) => [{ node: destino, type: 'main', index: 0 }];

w.connections['Roteia Acao'] = {
  main: [cx('Mensagem Pronta'), cx('Config Audio'), cx('Credencial (bloqueio)')],
};
w.connections['Config Audio'] = { main: [cx('Audio Contratado?')] };
w.connections['Audio Contratado?'] = { main: [cx('Conversa Ativa?'), cx('Avisa Midia Nao Suportada')] };
// Ramo falso sem saida de proposito: humano esta atendendo.
w.connections['Conversa Ativa?'] = { main: [cx('Audio Curto?'), []] };
w.connections['Audio Curto?'] = { main: [cx('Baixa Anexo'), cx('Avisa Audio Longo')] };
w.connections['Baixa Anexo'] = { main: [cx('Transcreve')] };
w.connections['Transcreve'] = { main: [cx('Filtra Transcricao')] };
w.connections['Filtra Transcricao'] = { main: [cx('Roteia Transcricao')] };
w.connections['Roteia Transcricao'] = {
  main: [cx('Mensagem Pronta'), cx('Credencial (bloqueio)'), cx('Avisa Audio Falhou'), cx('Avisa Audio Falhou')],
};
w.connections['Mensagem Pronta'] = { main: [cx('Sync Conversa')] };

// O `Acumula Mensagem` passa a ler do ponto de convergencia. E a UNICA leitura
// de `mensagem` no workflow — verificado antes de mexer.
{
  const ac = no('Acumula Mensagem');
  ac.parameters.messageData = "={{ $('Mensagem Pronta').first().json.mensagem }}";
}

// `audio_segundos` entra como oitavo parametro do registro da mensagem de
// ENTRADA. Unidade propria: nao se soma a token (migracao 32).
{
  const reg = no('Registra Mensagem');
  reg.parameters.query =
    "SELECT public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, 'entrada', $7::text, 0, 0, $6::text, $8::numeric) AS log_entrada,\n" +
    "       public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, 'saida', $3::text, $4::int, $5::int, $6::text) AS log_saida;";
  reg.parameters.options.queryReplacement =
    "={{ [ $('Resolve Tenant').first().json.tenant_id, $('Extrair e Filtrar').first().json.conversation_id, " +
    "$('Estima Tokens').first().json.output, $('Estima Tokens').first().json.tokens_entrada, " +
    "$('Estima Tokens').first().json.tokens_saida, $('Resolve Tenant').first().json.modelo, " +
    "$('Lista Depois').first().json.lista_depois, $('Mensagem Pronta').first().json.audio_segundos ] }}";
}

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
