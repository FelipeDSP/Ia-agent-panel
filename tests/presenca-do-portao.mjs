#!/usr/bin/env node
/**
 * O PORTÃO DE PAUSA EXISTE, ESTÁ NO CAMINHO, E NÃO TEM SAÍDA SOLTA.
 *
 * POR QUE EXISTE. Em 2026-08-24, removi do `agente-principal.json` os cinco nós
 * do portão — `Consulta Pausa`, `Nao Pausada?`, `Humano Atende (ignora)`,
 * `Anomalia?`, `Notifica Anomalia WAHA` — e religuei `Tenant Valido?` direto no
 * `Roteia Acao`, que é o workflow de antes da migração 48. As três verificações
 * que existiam passaram:
 *
 *     n8n:sincronia   ->  59 passaram, 0 falharam  "coerente com o gerador"
 *     teste:pausa     ->  "Tudo certo."
 *     n8n-validar     ->  "OK — 55 nos, nenhum problema conhecido"
 *
 * Um workflow sem proteção de pausa nenhuma atravessava toda a verificação do
 * repositório sem uma linha vermelha. As três verificam **o que está lá**;
 * nenhuma sabia **o que precisa estar**.
 *
 * E `teste:pausa` não cobria isto apesar do nome: ele guarda o `Roteia Evento`,
 * que é o GATILHO da pausa (quais eventos pausam). Este arquivo guarda o
 * PORTÃO, que é quem a respeita. Os nomes se parecem e as responsabilidades não
 * — foi essa semelhança que fez o buraco passar despercebido.
 *
 * -------------------------------------------------------------------------
 * POR CAMINHO, E NÃO POR NÓ. Esta é a decisão de desenho.
 *
 * "O nó existe" é fraco demais: o portão pode estar presente e DESCONECTADO, que
 * é exatamente o modo de falha do `E Humano ou Dispositivo?` — nó lá, saída
 * solta, meses em produção sem pausar ninguém. Então a asserção central é uma
 * propriedade de GRAFO:
 *
 *     removendo `Nao Pausada?` do grafo, `Roteia Acao` fica INALCANÇÁVEL
 *     a partir do `Webhook`.
 *
 * Isso é dizer que o portão está em TODO caminho da entrada até o roteamento —
 * não num deles. Nó órfão não satisfaz; desvio paralelo não satisfaz; e a
 * propriedade continua valendo quando alguém acrescentar nós no meio, porque não
 * depende da forma do caminho, só de o portão cortá-lo.
 *
 * As arestas nomeadas (seção 3) são o complemento: dizem para ONDE cada saída
 * vai, e é o que pega saída solta — que o corte sozinho não pega, porque um IF
 * com a saída falsa vazia continua sendo corte.
 *
 * Uso: npm run teste:portao
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const ARQ = `${RAIZ}n8n/workflows/agente-principal.json`;

let ok = 0;
let okSus = 0;
const falhas = [];
const chk = (n, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${n}`); }
  else { falhas.push(`${n}${det ? ` — ${det}` : ''}`); console.log(`  FALHA ${n}${det ? ` — ${det}` : ''}`); }
};
const sus = (n, cond, det = '') => {
  if (cond) { okSus++; console.log(`  OK  ~ ${n}`); }
  else { falhas.push(`[sustentação] ${n}${det ? ` — ${det}` : ''}`); console.log(`  FALHA ~ ${n}${det ? ` — ${det}` : ''}`); }
};

/** Nome do nó onde a mensagem entra. Tudo que protege tem de estar depois dele. */
const ENTRADA = 'Webhook';
/** O roteamento que o portão precisa cortar: é ele que despacha para os ramos. */
const ROTEAMENTO = 'Roteia Acao';

/**
 * ARESTAS NOMEADAS. Cada linha é um invariante com o motivo escrito — e o motivo
 * é sempre da mesma família: se esta aresta sumir, o cliente NÃO percebe e o dano
 * é silencioso. É por isso que a lista é curta e não tenta cobrir os 60 nós:
 * lista completa vira ruído a cada nó novo, e ruído é desligado.
 */
const ARESTAS = [
  {
    de: 'Tenant Valido?', saida: 0, para: 'Consulta Pausa',
    porque: 'o portão vem ANTES do Roteia Acao. Depois dele, protegeria um ramo só — que era o estado até 21/08, com mídia e bloqueado falando por cima do atendimento humano',
  },
  {
    de: 'Consulta Pausa', saida: 0, para: 'Nao Pausada?',
    porque: 'a consulta sem o IF é uma query cujo resultado ninguém lê',
  },
  {
    de: 'Nao Pausada?', saida: 0, para: ROTEAMENTO,
    porque: 'saída verdadeira: conversa livre segue para o roteamento',
  },
  {
    de: 'Nao Pausada?', saida: 1, para: 'Humano Atende (ignora)',
    porque: 'SAÍDA SOLTA é o modo de falha conhecido deste workflow — o "Fala com o Cliente?" passou meses com a falsa solta e por isso nenhuma mensagem digitada no Chatwoot pausava o bot',
  },
  {
    de: 'Humano Atende (ignora)', saida: 0, para: 'Anomalia?',
    porque: 'o aviso de anomalia pendura no ramo que já parava; sem esta aresta a pausa por laço vira silenciosa',
  },
  {
    de: 'Anomalia?', saida: 0, para: 'Notifica Anomalia WAHA',
    porque: 'pausa silenciosa resolve o custo e esconde o problema',
  },
  {
    de: 'Fala com o Cliente?', saida: 1, para: 'Nota Interna (ignora)',
    porque: 'mesmo modo de falha do outro lado, e já aconteceu neste nó',
  },
];

/** A função que o portão TEM de chamar. Nó presente, ligado e consultando outra
 *  coisa passaria em tudo acima. */
const FUNCAO_DO_PORTAO = 'api_n8n_portao_mensagem';

// ---------------------------------------------------------------------------
// Grafo
// ---------------------------------------------------------------------------
const arestasDe = (w, nome) => (w.connections?.[nome]?.main ?? [])
  .flatMap((saida) => (saida ?? []).map((c) => c.node));

/** Alcança `ate` a partir de `de`, opcionalmente com um nó REMOVIDO do grafo. */
function alcanca(w, de, ate, semNo = null) {
  if (de === semNo) return false;
  const vistos = new Set([de]);
  const fila = [de];
  while (fila.length) {
    const atual = fila.shift();
    if (atual === ate) return true;
    for (const prox of arestasDe(w, atual)) {
      if (prox === semNo || vistos.has(prox)) continue;
      vistos.add(prox);
      fila.push(prox);
    }
  }
  return false;
}

const nomes = (w) => new Set(w.nodes.map((n) => n.name));
const carregar = () => JSON.parse(fs.readFileSync(ARQ, 'utf8'));

/**
 * A verificação inteira, isolada numa função porque as SABOTAGENS precisam rodar
 * a MESMA verificação contra um workflow adulterado. Se elas chamassem uma cópia
 * da lógica, provariam que a cópia funciona.
 *
 * Devolve a lista de problemas — vazia é workflow são.
 */
function verificar(w) {
  const p = [];
  const existe = nomes(w);

  for (const a of [...ARESTAS.map((x) => x.de), ...ARESTAS.map((x) => x.para), ENTRADA, ROTEAMENTO]) {
    if (!existe.has(a)) p.push(`nó ausente: ${a}`);
  }

  for (const a of ARESTAS) {
    const saidas = w.connections?.[a.de]?.main ?? [];
    const destinos = (saidas[a.saida] ?? []).map((c) => c.node);
    if (!destinos.includes(a.para)) {
      p.push(`aresta ausente: ${a.de}[${a.saida}] -> ${a.para} (achei: ${JSON.stringify(destinos)})`);
    }
  }

  // O CORTE: sem o portão, o roteamento fica inalcançável.
  if (!alcanca(w, ENTRADA, ROTEAMENTO)) {
    p.push(`${ROTEAMENTO} não é alcançável a partir de ${ENTRADA} — o workflow está quebrado antes do portão`);
  }
  for (const portao of ['Nao Pausada?', 'Consulta Pausa']) {
    if (alcanca(w, ENTRADA, ROTEAMENTO, portao)) {
      p.push(`DESVIO: ${ROTEAMENTO} continua alcançável sem passar por \`${portao}\` — o portão não está em todo caminho`);
    }
  }

  const no = w.nodes.find((n) => n.name === 'Consulta Pausa');
  const q = no?.parameters?.query ?? '';
  if (!q.includes(FUNCAO_DO_PORTAO)) {
    p.push(`\`Consulta Pausa\` não chama \`${FUNCAO_DO_PORTAO}\` (query: ${q.slice(0, 80)})`);
  }
  return p;
}

// ---------------------------------------------------------------------------
console.log('\n== O portão de pausa está no caminho? ==\n');

const w = carregar();
console.log(`  ${w.nodes.length} nós, ${Object.keys(w.connections ?? {}).length} nós com saída\n`);

console.log('-- 1. Anti-vacuidade --\n');
sus('o workflow carregou com nós e conexões',
  w.nodes.length > 30 && Object.keys(w.connections ?? {}).length > 20,
  `${w.nodes.length} nós`);
sus(`\`${ENTRADA}\` e \`${ROTEAMENTO}\` existem (senão tudo abaixo é vácuo)`,
  nomes(w).has(ENTRADA) && nomes(w).has(ROTEAMENTO));

console.log('\n-- 2. O corte: o portão está em TODO caminho --\n');
chk(`\`${ROTEAMENTO}\` é alcançável a partir de \`${ENTRADA}\``,
  alcanca(w, ENTRADA, ROTEAMENTO));
for (const portao of ['Nao Pausada?', 'Consulta Pausa']) {
  chk(`sem \`${portao}\`, \`${ROTEAMENTO}\` fica INALCANÇÁVEL (não há desvio)`,
    !alcanca(w, ENTRADA, ROTEAMENTO, portao));
}

console.log('\n-- 3. As arestas nomeadas --\n');
for (const a of ARESTAS) {
  const destinos = ((w.connections?.[a.de]?.main ?? [])[a.saida] ?? []).map((c) => c.node);
  chk(`${a.de}[${a.saida}] -> ${a.para}`, destinos.includes(a.para),
    `achei ${JSON.stringify(destinos)} — ${a.porque}`);
}

console.log('\n-- 4. O portão consulta a função certa --\n');
const consulta = w.nodes.find((n) => n.name === 'Consulta Pausa')?.parameters?.query ?? '';
chk(`\`Consulta Pausa\` chama \`${FUNCAO_DO_PORTAO}\``, consulta.includes(FUNCAO_DO_PORTAO),
  consulta.slice(0, 90));

console.log('\n-- 5. Sabotagens --\n');
sus('o workflow de verdade passa na verificação (base das sabotagens)',
  verificar(w).length === 0, JSON.stringify(verificar(w)));

{
  // S1 — o experimento que revelou o buraco: remove os cinco nós do portão e
  // religa `Tenant Valido?` direto no roteamento. É o workflow pré-48.
  const s = carregar();
  const tirar = ['Consulta Pausa', 'Nao Pausada?', 'Humano Atende (ignora)', 'Anomalia?', 'Notifica Anomalia WAHA'];
  s.nodes = s.nodes.filter((n) => !tirar.includes(n.name));
  tirar.forEach((n) => delete s.connections[n]);
  s.connections['Tenant Valido?'] = { main: [[{ node: ROTEAMENTO, type: 'main', index: 0 }]] };
  sus('S1 mutação entrou (5 nós a menos)', s.nodes.length === w.nodes.length - 5,
    `${s.nodes.length} vs ${w.nodes.length}`);
  const p = verificar(s);
  chk('S1 portão REMOVIDO reprova', p.length > 0, 'a verificação não acusou nada');
  console.log(`        (acusou ${p.length}: ${p.slice(0, 2).join(' | ')})`);
}
{
  /*
   * S2 — a que o desenho por CAMINHO existe para pegar, e que "o nó existe" não
   * pegaria: o portão continua lá, inteiro, e o fluxo passa AO LADO dele.
   */
  const s = carregar();
  s.connections['Tenant Valido?'] = { main: [[{ node: ROTEAMENTO, type: 'main', index: 0 }], []] };
  sus('S2 mutação entrou (os 5 nós continuam lá)',
    s.nodes.length === w.nodes.length && nomes(s).has('Consulta Pausa'));
  const p = verificar(s);
  chk('S2 portão PRESENTE mas fora do caminho reprova', p.length > 0);
  chk('S2 e a acusação diz DESVIO, não "ausente" (o diagnóstico tem de estar certo)',
    p.some((x) => x.startsWith('DESVIO')), JSON.stringify(p));
  console.log(`        (acusou: ${p.filter((x) => x.startsWith('DESVIO')).join(' | ')})`);
}
{
  // S3 — saída solta: o IF está lá, no caminho, e a saída falsa não vai a lugar
  // nenhum. É literalmente o defeito que rodou meses no `Fala com o Cliente?`.
  const s = carregar();
  s.connections['Nao Pausada?'] = { main: [[{ node: ROTEAMENTO, type: 'main', index: 0 }], []] };
  sus('S3 mutação entrou (a saída falsa ficou vazia)',
    (s.connections['Nao Pausada?'].main[1] ?? []).length === 0);
  const p = verificar(s);
  chk('S3 saída FALSA solta reprova', p.length > 0);
  chk('S3 e o corte continua satisfeito (é por isso que a aresta nomeada existe)',
    !p.some((x) => x.startsWith('DESVIO')) && p.some((x) => x.startsWith('aresta ausente')),
    JSON.stringify(p));
}
{
  // S4 — nó lá, ligado, consultando outra função. Passaria em tudo que é grafo.
  const s = carregar();
  const no = s.nodes.find((n) => n.name === 'Consulta Pausa');
  no.parameters.query = 'SELECT true AS pausada;';
  sus('S4 mutação entrou (a query trocou)', !no.parameters.query.includes(FUNCAO_DO_PORTAO));
  const p = verificar(s);
  chk('S4 portão consultando OUTRA coisa reprova', p.some((x) => x.includes(FUNCAO_DO_PORTAO)),
    JSON.stringify(p));
}

console.log('\n----------------------------------------------------------');
console.log(`  ${ok + okSus} passaram, ${falhas.length} falharam`);
console.log(`    ${ok} por motivo próprio (a propriedade que o teste guarda)`);
console.log(`    ${okSus} de sustentação (~) — provam que o TESTE faz o que diz`);
falhas.forEach((f) => console.log(`  ! ${f}`));
console.log();
process.exit(falhas.length === 0 ? 0 : 1);
