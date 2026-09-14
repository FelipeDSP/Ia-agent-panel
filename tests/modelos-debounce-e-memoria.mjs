#!/usr/bin/env node
/**
 * teste:modelos — os dois modelos executáveis da fatia 0: debounce (o grafo
 * do n8n como simulação) e memória (Redis do LangChain × `mensagens_log`).
 *
 * O que ele mede:
 *   1. as condições que o modelo do debounce reproduz são as que estão no
 *      `agente-principal.json` (lidas, não lembradas): comparação por
 *      COMPRIMENTO, `depois.length > 0`, LPOP (`tail:false`), `Limit 1`;
 *   2. cada cenário de `CENARIOS` bate com o esperado no modelo n8n — e o
 *      esperado descreve o comportamento atual, brechas inclusive;
 *   3. memória: nos casos sem portão barrado, o que o código monta do log é
 *      EXATAMENTE o que o n8n teria na chave — inclusive silêncio de 41 min
 *      (some) × 39 (fica), a janela de 20 pares, e o corte × DEL;
 *   4. a divergência ESPERADA: no turno barrado o n8n tem o bruto e o código
 *      tem a substituta — nomeada, para ninguém "consertar";
 *   5. a armadilha do "agora − 40 min": a regra ingênua traz o contexto velho
 *      de volta na mensagem que acabou de chegar; a regra por INTERVALO não;
 *   6. sabotagens com md5 nos dois modelos.
 *
 * Uso: npm run teste:modelos
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CENARIOS, conferir, simularN8n } from './lib/debounce-modelo.mjs';
import { JANELA_PARES, SILENCIO_MIN, memoriaCodigo, memoriaN8n } from './lib/memoria-modelo.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = JSON.parse(fs.readFileSync(path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json'), 'utf8'));
const no = (n) => W.nodes.find((x) => x.name === n);
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 12);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

// ===========================================================================
console.log('\n== 1. O modelo reproduz o que está no JSON ==\n');
// ===========================================================================
{
  const um = no('Ultima Mensagem?').parameters.conditions;
  const c = um.conditions.map((x) => `${x.leftValue} ${x.operator.operation} ${x.rightValue}`);
  chk('Ultima Mensagem? compara COMPRIMENTO de antes e depois (não conteúdo)',
    /lista_antes \|\| \[\]\)\.length \}\} equals .*lista_depois \|\| \[\]\)\.length/.test(c[0]), c[0]);
  chk('  ...E exige depois.length > 0 (a guarda d2), combinador and',
    /lista_depois \|\| \[\]\)\.length \}\} gt 0/.test(c[1]) && um.combinator === 'and', c[1]);
  chk('Acumulo Sumiu? é depois.length == 0', /lista_depois \|\| \[\]\)\.length \}\} equals 0/.test(no('Acumulo Sumiu?').parameters.conditions.conditions.map((x) => `${x.leftValue} ${x.operator.operation} ${x.rightValue}`)[0]));
  chk('Remove Lidos é LPOP (tail:false) e Acumula é RPUSH (tail:true)',
    no('Remove Lidos do Acumulo').parameters.tail === false && no('Acumula Mensagem').parameters.tail === true);
  chk('Volta a Um Item é Limit maxItems=1', no('Volta a Um Item').parameters.maxItems === 1);
  chk('a memória é Redis Chat Memory com sessionTTL 2400 e contextWindowLength 20',
    no('Redis Chat Memory').parameters.sessionTTL === SILENCIO_MIN * 60 && no('Redis Chat Memory').parameters.contextWindowLength === JANELA_PARES);
}

// ===========================================================================
console.log('\n== 2. Cenários do debounce, no modelo n8n ==\n');
// ===========================================================================
for (const cn of CENARIOS) {
  const saida = simularN8n(cn);
  const difs = conferir(saida, cn.esperado);
  chk(cn.nome + (cn.nota ? `  [${cn.nota.split(':')[0]}]` : ''), difs.length === 0, difs.join(' | '));
}

// ===========================================================================
console.log('\n== 3. Memória: n8n × código, sem portão barrado ==\n');
// ===========================================================================
const T0 = Date.UTC(2026, 8, 14, 12, 0, 0);
const min = (n) => n * 60 * 1000;
const turno = (t, cliente, agente, bruto) => [
  { direcao: 'entrada', criado_em: T0 + t, conteudo: cliente },
  { direcao: 'saida', criado_em: T0 + t, conteudo: agente, ...(bruto ? { bruto } : {}) },
];
const iguais = (log, opts) => JSON.stringify(memoriaN8n(log, opts)) === JSON.stringify(memoriaCodigo(log, opts));
{
  const simples = [...turno(0, 'oi', 'Oi! Como posso ajudar?'), ...turno(min(1), 'tem bolo?', 'Temos bolo de cenoura.')];
  chk('conversa simples: as duas memórias são idênticas (4 mensagens, human/ai)',
    iguais(simples, { agora: T0 + min(2) }) && memoriaCodigo(simples, { agora: T0 + min(2) }).length === 4);

  const silencio41 = [...turno(0, 'oi', 'Oi!'), ...turno(min(41), 'voltei', 'Bem-vindo de volta')];
  const n41 = memoriaN8n(silencio41, { agora: T0 + min(42) });
  const c41 = memoriaCodigo(silencio41, { agora: T0 + min(42) });
  chk('silêncio de 41 min: as duas ESQUECEM o que veio antes (só o turno novo)',
    JSON.stringify(n41) === JSON.stringify(c41) && c41.length === 2 && c41[0].texto === 'voltei', JSON.stringify({ n41, c41 }));

  const silencio39 = [...turno(0, 'oi', 'Oi!'), ...turno(min(39), 'voltei', 'Bem-vindo de volta')];
  chk('silêncio de 39 min: as duas LEMBRAM (4 mensagens)', iguais(silencio39, { agora: T0 + min(40) }) && memoriaCodigo(silencio39, { agora: T0 + min(40) }).length === 4);

  chk('40 min depois do último turno, sem mensagem nova: as duas estão VAZIAS', iguais(simples, { agora: T0 + min(1) + min(41) }) && memoriaCodigo(simples, { agora: T0 + min(1) + min(41) }).length === 0);

  const longa = [];
  for (let i = 0; i < 25; i++) longa.push(...turno(min(i), `pergunta ${i}`, `resposta ${i}`));
  const cl = memoriaCodigo(longa, { agora: T0 + min(25) });
  chk(`25 pares -> as duas devolvem os últimos ${JANELA_PARES} pares (${JANELA_PARES * 2} mensagens), começando na pergunta 5`,
    iguais(longa, { agora: T0 + min(25) }) && cl.length === JANELA_PARES * 2 && cl[0].texto === 'pergunta 5');

  // "Limpar memória" pelo painel: DEL no n8n, corte no código — mesmo efeito.
  const antesLimpar = [...turno(0, 'oi', 'Oi!'), ...turno(min(1), 'quero x', 'Anotado x')];
  const depoisLimpar = [...antesLimpar, ...turno(min(3), 'e agora?', 'Oi de novo')];
  const n = memoriaN8n(depoisLimpar, { agora: T0 + min(4), limpezas: [T0 + min(2)] });
  const c = memoriaCodigo(depoisLimpar, { agora: T0 + min(4), corteEm: T0 + min(2) });
  chk('Limpar memória (DEL × corte): as duas ficam só com o turno posterior', JSON.stringify(n) === JSON.stringify(c) && c.length === 2 && c[0].texto === 'e agora?');
}

// ===========================================================================
console.log('\n== 4. A DIVERGÊNCIA ESPERADA: portão barrou ==\n');
// ===========================================================================
{
  const barrado = [
    ...turno(0, 'quero 2 bolos', 'Anotei 2 bolos.'),
    ...turno(min(1), 'pode fechar', 'Ainda não tenho nenhum item anotado — vamos montar o pedido?', 'Pedido fechado! Total R$ 80,00. ✅'),
  ];
  const n = memoriaN8n(barrado, { agora: T0 + min(2) });
  const c = memoriaCodigo(barrado, { agora: T0 + min(2) });
  chk('n8n: a memória carrega o BRUTO fabricado ("Pedido fechado! Total R$ 80,00")', n[3].texto === 'Pedido fechado! Total R$ 80,00. ✅');
  chk('código: a memória carrega a SUBSTITUTA do portão', /nenhum item anotado/.test(c[3].texto));
  chk('DIVERGÊNCIA ESPERADA (decisão da §3b): os dois diferem SÓ na saída barrada',
    JSON.stringify(n.slice(0, 3)) === JSON.stringify(c.slice(0, 3)) && n[3].texto !== c[3].texto && n.length === c.length);
  // A contraprova de que a divergência é essa e não outra: com o mesmo turno
  // SEM barrar (sem bruto), voltam a ser idênticas.
  const semBruto = barrado.map((l) => { const { bruto, ...r } = l; return r; });
  chk('  ...e sem o barrado (mesmo log sem `bruto`) as duas voltam a ser idênticas', iguais(semBruto, { agora: T0 + min(2) }));
}

// ===========================================================================
console.log('\n== 5. A armadilha do "agora − 40 min" ==\n');
// ===========================================================================
{
  // Cliente volta depois de 2 h. A mensagem nova acabou de chegar (está no
  // log). Regra ingênua "tudo desde agora−40min" pegaria só a nova — parece
  // certo — MAS se a implementação renovar o prazo pela escrita e olhar
  // "última escrita < 40 min", ela traz TUDO de volta. A regra por intervalo
  // entre turnos consecutivos não.
  const volta = [...turno(0, 'oi', 'Oi!'), ...turno(min(1), 'quero x', 'Anotado x'), ...turno(min(121), 'voltei', 'Oi de novo')];
  const c = memoriaCodigo(volta, { agora: T0 + min(121) });
  chk('cliente volta após 2 h: o código traz SÓ o turno novo (o intervalo de 120 min corta)', c.length === 2 && c[0].texto === 'voltei', JSON.stringify(c));
  chk('  ...igual ao n8n (a chave venceu no silêncio)', iguais(volta, { agora: T0 + min(121) }));
  // A regra ingênua, escrita aqui de propósito para provar que erraria:
  const ingenua = (log, agora) => log.filter((l) => l.criado_em > agora - min(SILENCIO_MIN) || agora - Math.max(...log.map((x) => x.criado_em)) < min(SILENCIO_MIN)).length;
  chk('  ...e a regra "última escrita < 40 min" traria as 6 mensagens de volta (por isso é por INTERVALO)', ingenua(volta, T0 + min(121)) === 6);
}

// ===========================================================================
console.log('\n== 6. SABOTAGEM ==\n');
// ===========================================================================
{
  const ARQ = path.join(RAIZ, 'tests', 'lib', 'debounce-modelo.mjs');
  const original = fs.readFileSync(ARQ, 'utf8');
  const alvo = 'if (antes === depois.length && depois.length > 0) {';
  if (original.split(alvo).length - 1 !== 1) chk('S1 localizou o alvo', false);
  else {
    const mutado = original.split(alvo).join('if (antes === depois.length && depois.length > -1) {');
    fs.writeFileSync(ARQ, mutado);
    console.log(`     [mutou "sem a guarda d2": md5 ${md5(original)} -> ${md5(fs.readFileSync(ARQ, 'utf8'))}]`);
    try {
      const url = new URL('./lib/debounce-modelo.mjs', import.meta.url); url.searchParams.set('v', String(Date.now()));
      const m = await import(url.href);
      const cn = m.CENARIOS.find((x) => /CORRIDA DO README/.test(x.nome));
      const s = m.simularN8n(cn);
      chk('S1: sem a guarda d2, a corrida do README vira RESPOSTA VAZIA (agente sem prompt) em vez de erro — o cenário acusa', s.respostas.length === 1 && s.respostas[0].mensagens.length === 0 && s.erros.length === 0, JSON.stringify(s));
    } finally {
      fs.writeFileSync(ARQ, original);
      chk('  ...arquivo restaurado byte a byte', fs.readFileSync(ARQ, 'utf8') === original);
    }
  }
  const ARQ2 = path.join(RAIZ, 'tests', 'lib', 'memoria-modelo.mjs');
  const original2 = fs.readFileSync(ARQ2, 'utf8');
  const alvo2 = "if (t.saida) msgs.push({ papel: 'ai', texto: t.saida.conteudo });";
  if (original2.split(alvo2).length - 1 !== 1) chk('S2 localizou o alvo', false);
  else {
    // O "conserto" errado: ler o bruto no código. Mesmo comprimento não importa; md5 prova.
    const mutado = original2.split(alvo2).join("if (t.saida) msgs.push({ papel: 'ai', texto: t.saida.bruto ?? t.saida.conteudo });");
    fs.writeFileSync(ARQ2, mutado);
    console.log(`     [mutou "código lendo o bruto": md5 ${md5(original2)} -> ${md5(fs.readFileSync(ARQ2, 'utf8'))}]`);
    try {
      const url = new URL('./lib/memoria-modelo.mjs', import.meta.url); url.searchParams.set('v', String(Date.now()));
      const m = await import(url.href);
      const barrado = [...turno(0, 'a', 'b'), ...turno(min(1), 'c', 'substituta', 'bruto fabricado')];
      const c = m.memoriaCodigo(barrado, { agora: T0 + min(2) });
      chk('S2: lendo o bruto, a divergência esperada SOME — o teste da §4 ficaria vermelho, que é o objetivo', c[3].texto === 'bruto fabricado');
    } finally {
      fs.writeFileSync(ARQ2, original2);
      chk('  ...arquivo restaurado byte a byte', fs.readFileSync(ARQ2, 'utf8') === original2);
    }
  }
}

console.log(`\n${'-'.repeat(62)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
