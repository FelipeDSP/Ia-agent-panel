#!/usr/bin/env node
/**
 * Confere que o workflow principal continua coerente com o que o gerador
 * deveria ter produzido. Falha com saida nao-zero em qualquer divergencia.
 *
 * POR QUE ISTO EXISTE. A fatia 3 troca um fluxo simples com custo por um fluxo
 * duplicado com gerador: dois AI Agents, dois system messages, dois wrappers no
 * Estima Tokens. O gerador vira peca critica — se ele quebrar, ou se alguem
 * editar um agent pela UI e nao o outro, os dois derivam EM SILENCIO. Nada para
 * de funcionar; so o rateio passa a mentir e o comportamento entre perfis passa
 * a divergir.
 *
 * Ja aconteceu duas vezes neste repo com uma copia so: o WRAPPER sem a secao de
 * `resolver_conversa`, e o `$('Webhook1')` orfao que o n8n/README.md conta.
 *
 * Uso: node scripts/conferir-sincronia-wrapper.mjs   (npm run n8n:sincronia)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const w = JSON.parse(fs.readFileSync(path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json'), 'utf8'));
const no = (nome) => w.nodes.find((n) => n.name === nome);

const falhas = [];
let ok = 0;
const checar = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ` — ${det}` : ''}`); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

console.log('\n== Sincronia do workflow principal ==\n');

const est = no('Estima Tokens');
if (!est) {
  console.error('\n  ERRO: no "Estima Tokens" ausente.\n');
  process.exit(1);
}
const code = est.parameters.jsCode ?? '';

// Extrai os wrappers do mapa gerado. Cada entrada e `nome: \`texto\``.
const wrappers = {};
{
  const ini = code.indexOf('const WRAPPERS = {');
  const fim = code.indexOf('};', ini);
  const bloco = ini >= 0 ? code.slice(ini, fim) : '';
  const re = /(\w+):\s*`([\s\S]*?)`(?=,\s*(?:\w+:|\}|$))/g;
  let m;
  while ((m = re.exec(bloco)) !== null) {
    wrappers[m[1]] = m[2].replace(/\\`/g, '`').replace(/\\\$\{/g, '${').replace(/\\\\/g, '\\');
  }
}

// Os S por perfil.
const esses = {};
{
  const m = code.match(/const S_POR_PERFIL = \{([^}]*)\}/);
  if (m) for (const par of m[1].split(',')) {
    const [k, v] = par.split(':').map((x) => (x || '').trim());
    if (k) esses[k] = Number(v);
  }
}

const agents = w.nodes.filter((n) => (n.type || '').includes('langchain.agent'));
const perfis = Object.keys(wrappers);

console.log('  -- 1. um wrapper por perfil, nenhum sobrando --');
checar('ha wrappers no Estima Tokens', perfis.length > 0, `${perfis.length}`);
checar('numero de agents = numero de perfis', agents.length === perfis.length,
  `${agents.length} agent(s) para ${perfis.length} perfil(is)`);
checar('todo perfil tem S definido',
  perfis.every((p) => Number.isFinite(esses[p])), JSON.stringify(esses));

console.log('\n  -- 2. cada agent bate com o wrapper do seu perfil --');
for (const p of perfis) {
  const esperado = `AI Agent ${p.charAt(0).toUpperCase()}${p.slice(1)}`;
  const ag = no(esperado);
  if (!ag) { checar(`agent do perfil "${p}" existe`, false, `esperava "${esperado}"`); continue; }
  const sm = ag.parameters?.options?.systemMessage ?? '';
  const fixo = sm.slice(1, sm.indexOf('{{'));
  const bate = fixo === wrappers[p];
  checar(`systemMessage de ${esperado} == wrapper "${p}"`, bate,
    bate ? '' : `${fixo.length} vs ${wrappers[p].length} chars`);
  if (!bate) {
    let i = 0;
    while (i < Math.min(fixo.length, wrappers[p].length) && fixo[i] === wrappers[p][i]) i++;
    console.log(`        divergem no char ${i}:`);
    console.log(`          agent  : ${JSON.stringify(fixo.slice(i, i + 70))}`);
    console.log(`          wrapper: ${JSON.stringify(wrappers[p].slice(i, i + 70))}`);
  }
}

console.log('\n  -- 3. cada agent tem exatamente as tools do seu perfil --');
const TOOLS_BASICO = ['Busca Conhecimento', 'Transferir para Humano', "Call 'Tool - Resolver Conversa (Multi-Tenant)'"];
const TOOLS_VENDAS = ['Consultar Catalogo', 'Gerenciar Pedido', 'Fechar Pedido', 'Cancelar Pedido'];
const ESPERADO = { basico: TOOLS_BASICO, vendas: [...TOOLS_BASICO, ...TOOLS_VENDAS] };

for (const p of perfis) {
  const agente = `AI Agent ${p.charAt(0).toUpperCase()}${p.slice(1)}`;
  const ligadas = Object.entries(w.connections)
    .filter(([, v]) => (v.ai_tool ?? []).some((saida) => (saida ?? []).some((d) => d.node === agente)))
    .map(([k]) => k).sort();
  const esperadas = [...(ESPERADO[p] ?? [])].sort();
  checar(`${agente}: ${esperadas.length} tools`,
    JSON.stringify(ligadas) === JSON.stringify(esperadas),
    `tem ${ligadas.length}: ${ligadas.join(', ')}`);
}

console.log('\n  -- 4. Tools Ativas resolve o perfil antes do Switch --');
checar('no "Tools Ativas" existe', Boolean(no('Tools Ativas')));
checar('no "Vende?" existe', Boolean(no('Vende?')));
checar('Volta a Um Item -> Tools Ativas',
  (w.connections['Volta a Um Item']?.main?.[0] ?? []).some((d) => d.node === 'Tools Ativas'));
checar('Tools Ativas -> Vende?',
  (w.connections['Tools Ativas']?.main?.[0] ?? []).some((d) => d.node === 'Vende?'));
// Roteamento nao cai em perfil nenhum por engano: perfil nao resolvido e bug.
checar('Vende? tem ramo de falha visivel',
  (w.connections['Vende?']?.main ?? []).flat().some((d) => d.node === 'Perfil Nao Resolvido'),
  'sem ele um cliente que contratou vendas perderia as tools em silencio');
checar('o ramo de falha para a execucao',
  (no('Perfil Nao Resolvido')?.type ?? '').includes('stopAndError'));

console.log('\n  -- 5. nenhuma referencia ao agent por NOME fora dos agents --');
// Foi o que quase quebrou a fatia 3: `$('AI Agent')` aparecia em tres nos,
// inclusive no Envia Mensagem Chatwoot — um dos perfis pararia de responder.
const nomesAgents = agents.map((a) => a.name);
let refs = 0;
for (const n of w.nodes) {
  if (nomesAgents.includes(n.name)) continue;
  const txt = n.name === 'Estima Tokens'
    ? (n.parameters.jsCode ?? '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    : JSON.stringify(n.parameters ?? {});
  for (const alvo of ['AI Agent', ...nomesAgents]) {
    if (txt.includes(`$('${alvo}')`)) { refs++; console.log(`        [${n.name}] referencia $('${alvo}')`); }
  }
}
checar('nenhum no referencia agent por nome', refs === 0, `${refs} referencia(s)`);

console.log('\n  -- 6. o debounce nao chama o agent com lista vazia --');
// A condicao "antes == depois" sozinha aprova o caso 0 == 0, que acontece
// quando outra execucao da mesma conversa ja limpou a chave do Redis. O agent
// era chamado sem prompt (execucao 3951004) e o Limpa Acumulo ainda rodava,
// apagando mensagem que tivesse chegado no meio.
{
  const ult = no('Ultima Mensagem?');
  const conds = ult?.parameters?.conditions?.conditions ?? [];
  const naoVazia = conds.some(
    (c) =>
      /lista_depois/.test(String(c.leftValue)) &&
      c.operator?.operation === 'gt' &&
      Number(c.rightValue) === 0
  );
  checar('Ultima Mensagem? exige lista_depois nao vazia', naoVazia,
    'sem isso 0 == 0 aprova e o agent e chamado sem prompt');
  checar('o ramo true entra no Separa Lidos',
    (w.connections['Ultima Mensagem?']?.main?.[0] ?? []).some((d) => d.node === 'Separa Lidos'),
    'a guarda precisa ficar ANTES de remover do acumulo, nao depois');

  // O DEL apagava a chave inteira, levando junto mensagem que chegou durante a
  // espera. O LPOP remove so as lidas. Se alguem trocar de volta por delete, a
  // perda silenciosa volta.
  const rem = no('Remove Lidos do Acumulo');
  checar('o acumulo e limpo por LPOP, nao por DELETE',
    rem?.parameters?.operation === 'pop' && rem?.parameters?.tail === false,
    `operation=${rem?.parameters?.operation} tail=${rem?.parameters?.tail} — delete apaga o que chegou durante a espera`);
  // `Limpa Redis Debounce` tambem apaga a chave do acumulo, e esta CERTO: ele
  // fica no ramo de pausa (Pausa Conversa -> ...). Quando um humano assume a
  // conversa, descartar o que estava acumulado e o comportamento desejado — o
  // agente nao deve responder aquelas mensagens. So o caminho do agente e que
  // nao pode apagar a chave inteira.
  const deletesIndevidos = w.nodes.filter(
    (n) =>
      n.parameters?.operation === 'delete' &&
      /_acumulo/.test(String(n.parameters?.key)) &&
      n.name !== 'Limpa Redis Debounce'
  );
  checar('nenhum delete no acumulo fora do ramo de pausa', deletesIndevidos.length === 0,
    deletesIndevidos.map((n) => n.name).join(', '));

  // O Split Out multiplica os itens de proposito, para o LPOP rodar N vezes. Sem
  // voltar a UM item o agent roda uma vez por mensagem e o cliente recebe N
  // respostas — falha visivel para o cliente final, que e a pior que existe.
  const lim = no('Volta a Um Item');
  checar('volta a um item antes do agent',
    (lim?.type ?? '').includes('limit') && Number(lim?.parameters?.maxItems) === 1,
    'sem isso o Split Out faz o agent rodar N vezes e o cliente recebe N respostas');
  checar('o Split Out separa lista_depois',
    no('Separa Lidos')?.parameters?.fieldToSplitOut === 'lista_depois');

  // O ramo false junta dois casos: "a lista cresceu, outra execucao responde"
  // (normal, silencioso) e "a chave foi apagada" (corrida, mensagem perdida).
  // Sem separar, o segundo termina em silencio — e silencio que ninguem ve ja
  // custou caro duas vezes neste projeto.
  checar('o ramo false vai para o Acumulo Sumiu?',
    (w.connections['Ultima Mensagem?']?.main?.[1] ?? []).some((d) => d.node === 'Acumulo Sumiu?'),
    'sem isso a corrida termina em silencio');
  checar('a anomalia para a execucao com erro',
    (no('Acumulo Sumiu (corrida)')?.type ?? '').includes('stopAndError'));
  checar('o caso normal segue silencioso',
    (w.connections['Acumulo Sumiu?']?.main?.[1] ?? []).length === 0,
    '"outra execucao responde" nao pode virar erro — acontece o tempo todo');
}

console.log('\n  -- extras --');
checar('contextWindowLength = 20', no('Redis Chat Memory')?.parameters?.contextWindowLength === 20);
for (const a of agents) {
  checar(`${a.name}: returnIntermediateSteps ligado`, a.parameters?.options?.returnIntermediateSteps === true,
    'sem isso o Estima Tokens volta a contar uma chamada so');
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) {
  console.log('\n  FALHAS:');
  for (const f of falhas) console.log(`    - ${f}`);
  console.log('\n  Rode `node scripts/gerar-principal.mjs` para regenerar a partir do repo.\n');
  process.exit(1);
}
console.log('\n  Workflow coerente com o gerador.\n');
