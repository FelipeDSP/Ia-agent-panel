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

console.log('\n  -- 7. nenhuma leitura por item linking (.item) --');
// `$('X').item` resolve rastreando a linhagem do item corrente ate o no X. A
// cadeia do LPOP (Split Out -> pop -> Limit -> Postgres) quebra essa linhagem, e
// dali em diante `.item` para de resolver. O estrago apareceu em tres formas
// diferentes, todas na mesma causa:
//
//   AI Agent Vendas         prompt vazio  -> "No prompt specified"  (3951563)
//   Credencial (resposta)   parametro undefined -> query invalida    (3952035)
//   Estima Tokens           system_prompt '' e memoria 0, EM SILENCIO
//
// O terceiro e o pior: nao quebra nada visivel, so encolhe o rateio.
//
// Todo no citado neste workflow emite exatamente UM item por execucao, entao
// `.first()` e equivalente quando o linking funciona e continua funcionando
// quando nao.
{
  const bruto = JSON.stringify(w.nodes);
  const usos = [...bruto.matchAll(/\$\('([^']+)'\)\.item\./g)].map((m) => m[1]);
  checar('nenhum no usa .item', usos.length === 0,
    `${usos.length} uso(s): ${[...new Set(usos)].join(', ')} — troque por .first()`);
}

console.log('\n  -- 8. proibicoes explicitas no wrapper --');
// Remover as secoes de venda do wrapper basico NAO proibe vender: em 12/08/2026
// o agente basico afirmou ao cliente que tinha registrado um pedido, com um
// bloco "[Used tools: ...]" escrito por ele. Nenhuma tool foi chamada.
{
  for (const p of perfis) {
    checar(`wrapper "${p}" proibe afirmar acao sem retorno de ferramenta`,
      /So afirme que registrou, transferiu, consultou ou encerrou/.test(wrappers[p] ?? ''),
      'sem isso o modelo narra ferramenta que nao chamou');
  }

  // Os DOIS momentos. Na conversa de 12/08 o agente basico ofereceu antes de
  // prometer: "Quer fazer um pedido para entrega?" veio primeiro, e so depois
  // "e so me informar os itens que eu registro". Proibir so a promessa deixa a
  // oferta de pe, e e a oferta que puxa o cliente para o passo seguinte.
  checar('wrapper "basico" proibe PROMETER que registra',
    /Voce nao registra pedidos/.test(wrappers.basico ?? ''),
    'remover a secao de venda nao cria proibicao — o modelo preenche o vazio');
  checar('wrapper "basico" proibe OFERECER pedido',
    /Nao ofereca fazer pedido/.test(wrappers.basico ?? ''),
    'a promessa vem depois da oferta; barrar so a promessa chega tarde');
  checar('wrapper "basico" separa informar de vender',
    /Informar nao e vender/.test(wrappers.basico ?? ''),
    'a base tem cardapio com preco; sem isso ele trata como catalogo');
  checar('wrapper "vendas" NAO recebe a proibicao de vender',
    !/Voce nao registra pedidos/.test(wrappers.vendas ?? ''),
    'quem contratou tem que continuar vendendo');

  // A checagem 2 compara so o PREFIXO ate o `{{`, entao texto acrescentado
  // DEPOIS da expressao do prompt do tenant passava batido — foi o que uma
  // sabotagem mostrou. A cauda (`{{ ... system_prompt }}` e o que vier junto) e
  // a mesma para os dois agents por construcao; se divergir, alguem editou um
  // deles pela UI.
  const caudas = perfis.map((p) => {
    const ag = no(`AI Agent ${p.charAt(0).toUpperCase()}${p.slice(1)}`);
    const sm = ag?.parameters?.options?.systemMessage ?? '';
    return sm.slice(1 + (wrappers[p] ?? '').length);
  });
  checar('a cauda do systemMessage e identica nos dois agents',
    new Set(caudas).size === 1,
    caudas.map((c, i) => `${perfis[i]}:${c.length}ch`).join(' vs '));
}

console.log('\n  -- 9. filtro de texto identico em todo no que filtra --');
// Hoje so o `Extrair e Filtrar` usa. A fatia de audio acrescenta o
// `Filtra Transcricao`, e e AI que a checagem paga por si: transcricao e texto
// do cliente entrando depois do filtro original. Duas copias da blocklist
// divergem — uma ganha padrao novo, a outra nao, e o buraco fica no caminho que
// ninguem olhou. A checagem entra ANTES do segundo consumidor existir, de
// proposito: depois dele ja seria tarde para descobrir que divergiram.
{
  const fonte = fs.readFileSync(path.join(RAIZ, 'n8n', 'filtro-texto.js'), 'utf8').trim();
  const usam = w.nodes.filter((n) => (n.parameters?.jsCode ?? '').includes('function contemInjection'));

  checar('ao menos um no usa o filtro compartilhado', usam.length > 0, `${usam.length} no(s)`);
  for (const n of usam) {
    checar(`${n.name}: bloco de filtro identico a n8n/filtro-texto.js`,
      n.parameters.jsCode.includes(fonte),
      'divergiu da fonte — regenere com node scripts/gerar-principal.mjs');
  }
  // Nenhum no pode filtrar por conta propria: uma blocklist escrita a mao em
  // outro no e exatamente a divergencia que isto existe para impedir.
  const artesanais = w.nodes.filter(
    (n) => /jailbreak|dan mode|ignore suas/i.test(n.parameters?.jsCode ?? '') &&
           !(n.parameters?.jsCode ?? '').includes(fonte)
  );
  checar('nenhuma blocklist artesanal fora da fonte', artesanais.length === 0,
    artesanais.map((n) => n.name).join(', '));
}

console.log('\n  -- 10. modulo de audio: convergencia e travas --');
// O `Mensagem Pronta` e PONTO UNICO DE FALHA NOVO no caminho de TODO cliente: o
// `Acumula Mensagem` passou a depender dele. Se ele emitir vazio, o acumulo
// grava vazio, o agente e chamado sem prompt e a execucao morre — a falha da
// execucao 3951563 por outra porta.
{
  const acumula = no('Acumula Mensagem');
  checar('Acumula Mensagem le do ponto de convergencia',
    /\$\('Mensagem Pronta'\)/.test(String(acumula?.parameters?.messageData)),
    `le de: ${acumula?.parameters?.messageData}`);

  const mp = no('Mensagem Pronta');
  checar('Mensagem Pronta FALHA ALTO sem mensagem',
    /throw new Error/.test(mp?.parameters?.jsCode ?? ''),
    'sem o throw ele emitiria vazio e o acumulo gravaria vazio — em silencio');

  // Os dois caminhos precisam chegar la; se um deles perder a ligacao, aquele
  // tipo de mensagem some do fluxo sem erro.
  const chegam = Object.entries(w.connections)
    .filter(([, v]) => (v.main ?? []).some((s) => (s ?? []).some((d) => d.node === 'Mensagem Pronta')))
    .map(([k]) => k);
  checar('texto e transcricao convergem no Mensagem Pronta',
    chegam.includes('Roteia Acao') && chegam.includes('Roteia Transcricao'),
    `chegam: ${chegam.join(', ')}`);

  checar('Mensagem Pronta entrega ao Sync Conversa',
    (w.connections['Mensagem Pronta']?.main?.[0] ?? []).some((d) => d.node === 'Sync Conversa'));

  // Injection falada e injection: mesmo ataque, mesmo tratamento.
  checar('transcricao bloqueada reusa o caminho de bloqueio do texto',
    (w.connections['Roteia Transcricao']?.main?.[1] ?? []).some((d) => d.node === 'Credencial (bloqueio)'));

  // Sem isto o `duration` nao vem e `audio_segundos` viraria estimativa — o
  // oposto do motivo de a coluna existir.
  const tr = no('Transcreve');
  const params = tr?.parameters?.bodyParameters?.parameters ?? [];
  checar('Transcreve pede verbose_json (traz a duracao exata)',
    params.some((p) => p.name === 'response_format' && p.value === 'verbose_json'));
  checar('Transcreve usa a credencial do n8n, sem chave no JSON',
    tr?.parameters?.authentication === 'predefinedCredentialType' &&
    !/sk-[A-Za-z0-9]/.test(JSON.stringify(tr?.parameters ?? {})));

  // Quem nao contratou tem que cair no aviso de sempre, sem passar por nada novo.
  checar('quem nao contratou vai direto ao aviso de midia',
    (w.connections['Audio Contratado?']?.main?.[1] ?? []).some((d) => d.node === 'Avisa Midia Nao Suportada'));

  // Ramo falso vazio de PROPOSITO: humano esta atendendo, quem responde e ele.
  checar('conversa pausada nao transcreve e nao responde',
    (w.connections['Conversa Ativa?']?.main?.[1] ?? []).length === 0);
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
