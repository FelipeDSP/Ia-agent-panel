/**
 * O `?` EMPURRA o conteúdo, não cobre.
 *
 * Duas correções do mesmo componente no mesmo dia, e vale registrar as duas
 * porque a segunda só apareceu depois da primeira:
 *
 *   1. o painel nascia TRANSPARENTE (`bg-popover`, token que este tema não
 *      declara — classe de token inexistente não falha, só não pinta);
 *   2. com o fundo consertado, o Felipe olhou de novo: "tem muito texto
 *      sobrepondo um o outro". Estava certo. Mesmo opaco, uma caixa flutuante
 *      pousa sobre o conteúdo e o texto de baixo aparece em volta dela.
 *
 * Caixa flutuante tem três problemas que cor nenhuma resolve: cobre o que está
 * atrás, pode sair do card, e some do fluxo de leitura. Em flow ela empurra o
 * resto para baixo e a classe inteira de defeito desaparece — não é ajuste de
 * z-index, é tirar a possibilidade.
 *
 * O PAR QUE ESTE TESTE GUARDA: o painel usa `basis-full` para ocupar a linha
 * inteira, e isso só funciona se o título que o hospeda for `flex-wrap`. Um sem
 * o outro não quebra o build nem o tipo — o painel vira um item espremido ao
 * lado do texto, e ninguém descobre sem olhar. São dois arquivos diferentes, e
 * é por isso que a verificação lê os dois.
 *
 *   npm run teste:ajuda-empurra
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AJUDA_BRUTO = fs.readFileSync(path.join(RAIZ, 'src', 'components', 'ui', 'ajuda.tsx'), 'utf8');

/**
 * SEM OS COMENTARIOS. O cabecalho deste componente EXPLICA que a versao antiga
 * era `absolute` — e a primeira versao deste teste acusou essa palavra, dentro
 * do comentario, como se fosse codigo. E a armadilha que o CLAUDE.md descreve
 * ("um regex casando com o comentario em vez do codigo") e que ja derrubou o
 * `teste:comparacoes-tipo`.
 *
 * `split(/\r?\n/)` porque 174 arquivos deste repo estao em CRLF, e `.` nao casa
 * `\r` — foi assim que a protecao contra auto-casamento morreu em 24/08.
 */
const AJUDA = AJUDA_BRUTO
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

console.log('\n=== 1. O componente está em FLOW ===\n');
// Contraprova do strip: se ele nao tirou nada, as assercoes abaixo estariam
// medindo o arquivo inteiro de novo — e um comentario bastaria para engana-las.
chk('os comentarios foram mesmo removidos antes de medir', AJUDA.length < AJUDA_BRUTO.length * 0.8,
  AJUDA.length + ' de ' + AJUDA_BRUTO.length);
chk('o painel NÃO é absoluto (flutuar é o que cobre)', !/absolute/.test(AJUDA), 'achou `absolute`');
chk('não precisa de z-index (nada flutua sobre nada)', !/z-\d/.test(AJUDA));
chk('ocupa a linha inteira com `basis-full`', /basis-full/.test(AJUDA));
chk('tem fundo declarado no tema', /bg-(card|muted)/.test(AJUDA));
chk('o botão tem rótulo acessível (é só um ícone)', /aria-label=\{`Ajuda:/.test(AJUDA));
chk('e diz o que controla, para leitor de tela', /aria-controls=/.test(AJUDA) && /aria-expanded=/.test(AJUDA));

console.log('\n=== 2. Todo título que hospeda um `?` deixa quebrar linha ===\n');

function varrer(dir) {
  const saida = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) saida.push(...varrer(p));
    else if (e.name.endsWith('.tsx')) saida.push(p);
  }
  return saida;
}
const arquivos = varrer(path.join(RAIZ, 'src'))
  .filter((p) => !p.endsWith(`ui${path.sep}ajuda.tsx`));

const comAjuda = arquivos.filter((p) => /<Ajuda\b/.test(fs.readFileSync(p, 'utf8')));
chk('a varredura achou telas que usam o `?` (lista vazia reprova antes de comparar)',
  comAjuda.length > 0, String(comAjuda.length));

/**
 * O elemento que ABRE imediatamente antes de um `<Ajuda` é o hospedeiro. Se ele
 * for `flex` sem `flex-wrap`, o painel não vai para a linha de baixo.
 */
const quebrados = [];
let hospedeiros = 0;
for (const arq of comAjuda) {
  const linhas = fs.readFileSync(arq, 'utf8').split(/\r?\n/);
  for (let i = 0; i < linhas.length; i++) {
    if (!/<Ajuda\b/.test(linhas[i])) continue;
    // sobe até a abertura de tag mais próxima que tenha className
    for (let j = i - 1; j >= 0 && j > i - 8; j--) {
      const m = /className="([^"]*)"/.exec(linhas[j]);
      if (!m) continue;
      hospedeiros++;
      const cls = m[1];
      if (/\bflex\b/.test(cls) && !/flex-wrap/.test(cls) && !/flex-col/.test(cls)) {
        quebrados.push(`${path.relative(RAIZ, arq)}:${j + 1} -> ${cls.slice(0, 60)}`);
      }
      break;
    }
  }
}
chk('a varredura achou os hospedeiros', hospedeiros > 0, String(hospedeiros));
chk('nenhum título `flex` hospeda o `?` sem `flex-wrap`', quebrados.length === 0, quebrados.join(' | '));

console.log('\n=== 3. Sabotagem ===\n');
// S1: a forma antiga (absoluta) tem de ser acusada
const comoEra = `className="absolute left-0 top-6 z-30 rounded-md border bg-card p-3"`;
chk('S1: a regra ACUSA o painel flutuante de antes', /absolute/.test(comoEra) && /z-\d/.test(comoEra));
// S2: título flex sem wrap tem de ser acusado
const tituloRuim = 'className="flex items-center gap-1.5"';
chk('S2: a regra ACUSA título flex sem flex-wrap',
  /\bflex\b/.test(tituloRuim) && !/flex-wrap/.test(tituloRuim) && !/flex-col/.test(tituloRuim));
chk('S2: ...e NÃO acusa o título corrigido',
  /flex-wrap/.test('className="flex flex-wrap items-center gap-1.5"'));

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
