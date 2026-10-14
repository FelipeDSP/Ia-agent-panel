#!/usr/bin/env node
/**
 * A DIFERENÇA do prompt proposto (14/10) — a peça que torna "o cliente aprova"
 * verdadeiro em vez de retórica.
 *
 * O método 2 é "o assistente propõe, o cliente aprova", e a proposta devolve o
 * prompt INTEIRO reescrito. Sem ver o que saiu e o que entrou, aprovar 12 KB de
 * texto é assinar em branco — e o cliente é justamente quem não sabe ler prompt.
 *
 * Puro, sem banco e sem rede: dá para sabotar uma linha e ver reprovar.
 *
 *   npm run teste:assistente-diferenca
 */
import {
  CONTEXTO_LINHAS, contagem, diferenca, MAX_LINHAS, resumir,
} from '../src/lib/assistente/diferenca.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ' - ' + det : ''}`); }
};

/** O texto reconstruído de um lado da diferença — é como se prova cobertura. */
const ladoAntes = (p) => p.filter((x) => x.tipo !== 'dentro').flatMap((x) => x.linhas).join('\n');
const ladoDepois = (p) => p.filter((x) => x.tipo !== 'fora').flatMap((x) => x.linhas).join('\n');

console.log('\n=== 1. A diferença COBRE os dois textos (nada se perde) ===\n');

/*
 * Esta é a propriedade que importa mais, e não é "o diff está bonito": é que
 * juntando os pedaços de volta se obtém exatamente os textos originais. Um
 * diff que perde uma linha mostra ao cliente uma mudança que não é a que vai
 * ser aplicada — e ele aprova confiando no que leu.
 */
const casos = [
  ['idênticos', 'a\nb\nc', 'a\nb\nc'],
  ['uma linha trocada no meio', 'a\nb\nc', 'a\nB\nc'],
  ['linha removida', 'a\nb\nc', 'a\nc'],
  ['linha acrescentada', 'a\nc', 'a\nb\nc'],
  ['tudo diferente', 'a\nb', 'x\ny'],
  ['vazio para algo', '', 'a\nb'],
  ['algo para vazio', 'a\nb', ''],
  ['prefixo comum longo', 'a\nb\nc\nd\ne\nf', 'a\nb\nc\nd\ne\nZ'],
  ['bloco inteiro no meio', 'a\nf', 'a\nb\nc\nd\nf'],
];
for (const [nome, antes, depois] of casos) {
  const p = diferenca(antes, depois);
  chk(`${nome}: reconstrói o texto ANTES`, ladoAntes(p) === antes, JSON.stringify(ladoAntes(p)));
  chk(`${nome}: reconstrói o texto DEPOIS`, ladoDepois(p) === depois, JSON.stringify(ladoDepois(p)));
}

console.log('\n=== 2. E marca a mudança no lugar certo ===\n');

const d1 = diferenca('a\nb\nc', 'a\nB\nc');
chk('linha igual não é marcada como mudança',
  d1.filter((p) => p.tipo === 'igual').flatMap((p) => p.linhas).join(',') === 'a,c',
  JSON.stringify(d1));
chk('a linha que saiu é `fora`', d1.some((p) => p.tipo === 'fora' && p.linhas.includes('b')), JSON.stringify(d1));
chk('a linha que entrou é `dentro`', d1.some((p) => p.tipo === 'dentro' && p.linhas.includes('B')), JSON.stringify(d1));

// CONTRAPROVA: textos iguais não produzem mudança nenhuma. Sem ela, um diff que
// marcasse tudo como alterado passaria em todas as asserções de cobertura.
const iguais = diferenca('a\nb\nc', 'a\nb\nc');
chk('CONTRAPROVA: textos iguais não têm `fora` nem `dentro`',
  iguais.every((p) => p.tipo === 'igual'), JSON.stringify(iguais));
chk('...e a contagem é zero a zero',
  contagem(iguais).fora === 0 && contagem(iguais).dentro === 0, JSON.stringify(contagem(iguais)));

const c2 = contagem(diferenca('a\nb\nc\nd', 'a\nX\nY\nd'));
chk('a contagem conta as linhas, não os pedaços', c2.fora === 2 && c2.dentro === 2, JSON.stringify(c2));

console.log('\n=== 3. O caso real: um marcador tirado de um prompt grande ===\n');

/*
 * O defeito nº 1 das contas reais. O CEEJAAR tem 7 marcadores num prompt de
 * 12,5 KB; a tela tem de mostrar as linhas dos marcadores e não as 300 iguais.
 */
const base = Array.from({ length: 300 }, (_, i) => `linha ${i}`);
const antesG = [...base];
antesG[150] = 'Peça o documento e informe {{GRATUITO? HÁ TAXA?}} ao cliente.';
const depoisG = [...base];
depoisG[150] = 'Peça o documento. Se não souber se há taxa, ofereça falar com um atendente.';
const pg = diferenca(antesG.join('\n'), depoisG.join('\n'));
chk('o prompt grande reconstrói dos dois lados',
  ladoAntes(pg) === antesG.join('\n') && ladoDepois(pg) === depoisG.join('\n'));
chk('só UMA linha sai e UMA entra', contagem(pg).fora === 1 && contagem(pg).dentro === 1, JSON.stringify(contagem(pg)));

const r = resumir(pg);
const visiveis = r.filter((p) => p.tipo !== 'pulo').reduce((n, p) => n + p.linhas.length, 0);
chk(`o resumo mostra poucas linhas (${visiveis}), não as 300`, visiveis <= 2 + 2 * CONTEXTO_LINHAS, String(visiveis));
chk('e diz quantas foram escondidas', r.some((p) => p.tipo === 'pulo' && p.linhas > 100), JSON.stringify(r.filter((p) => p.tipo === 'pulo')));
chk('a linha do marcador aparece no resumo',
  r.some((p) => p.tipo === 'fora' && p.linhas.some((l) => l.includes('{{GRATUITO'))), JSON.stringify(r.slice(0, 4)));
chk('a linha nova também', r.some((p) => p.tipo === 'dentro' && p.linhas.some((l) => l.includes('atendente'))));

console.log('\n=== 4. O resumo não some com mudança nenhuma ===\n');

/*
 * Esconder trecho igual é o objetivo; esconder MUDANÇA seria mostrar ao cliente
 * menos do que vai ser aplicado — o mesmo defeito do diff que perde linha, por
 * outra porta.
 */
for (const [nome, antes, depois] of casos) {
  const p = diferenca(antes, depois);
  const r2 = resumir(p);
  const mudouNoDiff = contagem(p);
  const mudouNoResumo = contagem(r2.filter((x) => x.tipo !== 'pulo'));
  chk(`${nome}: o resumo preserva TODA mudança`,
    mudouNoDiff.fora === mudouNoResumo.fora && mudouNoDiff.dentro === mudouNoResumo.dentro,
    `${JSON.stringify(mudouNoDiff)} vs ${JSON.stringify(mudouNoResumo)}`);
}

// Contexto zero some com as linhas iguais e mantém as mudanças.
const semContexto = resumir(diferenca('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne'), 0);
chk('com contexto 0, nenhuma linha igual sobra',
  semContexto.every((p) => p.tipo !== 'igual'), JSON.stringify(semContexto));
chk('...e a mudança continua lá',
  contagem(semContexto.filter((p) => p.tipo !== 'pulo')).dentro === 1, JSON.stringify(semContexto));

console.log('\n=== 5. O teto: texto enorme não trava a tela ===\n');

const enorme = Array.from({ length: MAX_LINHAS + 1 }, (_, i) => `l${i}`).join('\n');
const t0 = Date.now();
const pe = diferenca(enorme, enorme + '\nmais');
const ms = Date.now() - t0;
chk(`acima de ${MAX_LINHAS} linhas devolve "trocou tudo" em vez de calcular`,
  pe.length === 2 && pe[0].tipo === 'fora' && pe[1].tipo === 'dentro', JSON.stringify(pe.map((p) => p.tipo)));
chk('...e devolve rápido', ms < 500, `${ms} ms`);
chk('e os dois lados continuam íntegros no caso do teto',
  ladoAntes(pe) === enorme && ladoDepois(pe) === enorme + '\nmais');

// 300x300 é o tamanho real de um prompt de cliente: tem de ser instantâneo.
const t1 = Date.now();
diferenca(antesG.join('\n'), depoisG.join('\n'));
const ms2 = Date.now() - t1;
chk(`300 linhas contra 300 é instantâneo (${ms2} ms)`, ms2 < 500, `${ms2} ms`);

console.log('\n=== 6. CRLF não vira mudança ===\n');

// 174 arquivos deste repo estão em CRLF, e prompt colado de Word vem com \r\n.
// Se o fim de linha virasse diferença, TODA linha apareceria como alterada e a
// tela ficaria inútil justamente para quem colou o texto de algum lugar.
const pc = diferenca('a\r\nb\r\nc', 'a\nb\nc');
chk('o mesmo texto em CRLF e LF não tem mudança',
  pc.every((p) => p.tipo === 'igual'), JSON.stringify(pc));

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
