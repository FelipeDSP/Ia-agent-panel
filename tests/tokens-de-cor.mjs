/**
 * Classe de cor que o tema NÃO declara.
 *
 * 06/10/2026: o popup do `?` saiu transparente, com o texto da página
 * aparecendo através dele. A causa foi `bg-popover` — e este tema não declara
 * `--popover`. O Tailwind não reclama de token inexistente: ele simplesmente
 * não gera a regra, e o elemento fica sem fundo. Não quebra o build, não
 * quebra o tipo, não quebra teste nenhum. Só fica feio, e só se descobre
 * olhando — que foi como se descobriu.
 *
 * A varredura é o par derivado: os tokens vêm de `globals.css` (`--color-*`),
 * as classes vêm do código, e o que o código usa tem de existir no tema.
 *
 * O FILTRO É A PARTE DELICADA, e já errei nessa família hoje: `bg-white` e
 * `bg-red-500` são do Tailwind e não precisam de declaração. Então a regra não
 * é "toda classe de cor"; é "toda classe de cor que PARECE um token deste
 * projeto" — uma palavra só, sem número, fora da paleta embutida.
 *
 *   npm run teste:tokens-de-cor
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

const CSS = fs.readFileSync(path.join(RAIZ, 'src', 'app', 'globals.css'), 'utf8');
const DECLARADOS = new Set([...CSS.matchAll(/--color-([a-z][a-z0-9-]*)/g)].map((m) => m[1]));

console.log('\n=== 1. Os tokens do tema ===\n');
chk('a varredura achou tokens em globals.css (lista vazia reprova antes de comparar)',
  DECLARADOS.size > 0, String(DECLARADOS.size));
chk('os básicos estão lá', ['background', 'foreground', 'card', 'border', 'muted'].every((t) => DECLARADOS.has(t)),
  [...DECLARADOS].join(' '));

/** A paleta embutida do Tailwind e as palavras-chave: não precisam de declaração. */
const EMBUTIDOS = new Set([
  'inherit', 'current', 'transparent', 'black', 'white', 'auto', 'none',
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime',
  'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple',
  'fuchsia', 'pink', 'rose',
]);

/**
 * SÓ OS PREFIXOS QUE SÃO COR DE VERDADE.
 *
 * A primeira versão desta varredura incluía `text-`, `border-`, `ring-` e
 * `divide-`, e acusou `text-sm`, `text-right`, `divide-y` — que são tamanho e
 * direção, não cor. Regra larga demais produz ruído, e ruído treina todo mundo
 * a ignorar vermelho (a nota do CLAUDE.md sobre teste que fica vermelho porque
 * o sistema funcionou).
 *
 * `bg-` é onde o defeito de fato morde: fundo que não pinta deixa o elemento
 * transparente, e foi exatamente isso no popup do `?` e no switch desligado.
 * Os outros prefixos de cor pura entram junto porque não custam nada.
 */
const PREFIXOS = ['bg', 'fill', 'stroke', 'caret', 'placeholder', 'from', 'via', 'to'];

/** `bg-` tem alguns valores que não são cor. Lista curta e fechada. */
const BG_NAO_COR = new Set(['cover', 'contain', 'auto', 'fixed', 'local', 'scroll', 'center', 'top', 'bottom', 'left', 'right', 'repeat', 'blend', 'clip', 'origin', 'gradient', 'size']);

function varrer(dir) {
  const saida = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) saida.push(...varrer(p));
    else if (/\.(tsx|ts)$/.test(e.name)) saida.push(p);
  }
  return saida;
}
const arquivos = varrer(path.join(RAIZ, 'src'));

console.log('\n=== 2. O que o código usa ===\n');
chk('a varredura achou arquivos de código', arquivos.length > 0, String(arquivos.length));

const suspeitas = [];
let classesVistas = 0;
for (const arq of arquivos) {
  const fonte = fs.readFileSync(arq, 'utf8');
  // só dentro de className — fora dele, "to-do" e "text-only" não são classes
  for (const m of fonte.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
    const classes = (m[1] ?? m[2] ?? m[3] ?? '').split(/\s+/);
    for (const bruta of classes) {
      // tira variantes (hover:, dark:, [&_x]:) e o "!" de important
      const c = bruta.replace(/^.*:/, '').replace(/^!/, '');
      const mm = /^(-)?([a-z]+)-([a-z][a-z0-9]*)(?:\/\d+)?$/.exec(c);
      if (!mm) continue;
      const [, , prefixo, nome] = mm;
      if (!PREFIXOS.includes(prefixo)) continue;
      classesVistas++;
      if (EMBUTIDOS.has(nome)) continue;
      if (prefixo === 'bg' && BG_NAO_COR.has(nome)) continue;
      // nome composto do próprio tema (card-foreground) chega como `card` aqui
      // porque o regex exige uma palavra; isso é de propósito: `bg-card-foreground`
      // tem hífen e cai fora, e quem o usa é raro.
      if (DECLARADOS.has(nome)) continue;
      suspeitas.push(`${path.relative(RAIZ, arq)}: ${bruta}`);
    }
  }
}

// O piso mede que a varredura está VIVA: um regex quebrado devolveria zero ou
// meia dúzia e o "nenhuma suspeita" abaixo passaria por vacuidade. 36 é o que
// existe hoje com os prefixos de cor pura — o piso fica abaixo disso, para não
// virar afirmação sobre o estado do mundo (a nota do CLAUDE.md).
chk('a varredura leu classes de cor de verdade (não um punhado)', classesVistas >= 20, String(classesVistas));
chk('TODA classe de cor usada existe no tema', suspeitas.length === 0,
  [...new Set(suspeitas)].slice(0, 12).join(' | '));

console.log('\n=== 3. Sabotagem ===\n');
// Exatamente o defeito de 06/10: `bg-popover` num tema sem `--popover`.
const comoEra = 'className="rounded-md border border-border bg-popover p-3"';
const achadas = [];
for (const m of comoEra.matchAll(/className="([^"]*)"/g)) {
  for (const bruta of m[1].split(/\s+/)) {
    const mm = /^([a-z]+)-([a-z][a-z0-9]*)$/.exec(bruta);
    if (!mm) continue;
    if (!PREFIXOS.includes(mm[1])) continue;
    if (EMBUTIDOS.has(mm[2]) || DECLARADOS.has(mm[2])) continue;
    if (mm[1] === 'bg' && BG_NAO_COR.has(mm[2])) continue;
    achadas.push(bruta);
  }
}
chk('S1: a regra ACUSA `bg-popover` (o defeito real de 06/10)', achadas.includes('bg-popover'), achadas.join(','));
chk('S1: ...e NÃO acusa `bg-card`, que o tema declara', !achadas.includes('bg-card'));
chk('S2: a regra não acusa a paleta do Tailwind (bg-white, text-red-500)',
  EMBUTIDOS.has('white') && !/^[a-z]+-[a-z]+-\d+$/.test('bg-card'));

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
