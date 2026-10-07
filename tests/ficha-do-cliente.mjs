/**
 * A ficha do cliente (`/admin/tenants/[id]`) — as propriedades que a
 * reorganização de 06/10 tem de preservar.
 *
 * A tela passou de duas abas (Operação · Cadastro) para cinco por assunto
 * (Prompt · Conexão · Módulos · Pessoas · Avançado), 408 palavras de ajuda
 * saíram do caminho para dentro de `<Ajuda>`, e a lista de 30 conversas virou
 * contagem + as pausadas.
 *
 * Mexer em 460 linhas de JSX tem UM risco que revisão não pega: **um
 * formulário deixar de ser renderizado**. Ele não quebra o build (import não
 * usado não é erro aqui — não há `noUnusedLocals`), não quebra tipo, não
 * quebra teste nenhum. A tela só perde a capacidade, calada, e isso se
 * descobre no dia em que alguém for conectar um Chatwoot.
 *
 * Então a asserção central não é sobre aparência: é que **todo componente que
 * `componentes.tsx` exporta continua aparecendo na página**. A lista sai do
 * arquivo exportador, não daqui — componente novo entra sozinho, e sumir com
 * um fica vermelho.
 *
 * Varredura com `split(/\r?\n/)`: 174 arquivos deste repo estão em CRLF, e
 * `split('\n')` deixa um `\r` que faz `$` de regex não ancorar (PENDENCIA-
 * AUTOCASAMENTO-CRLF.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'src', 'app', '(app)', 'admin', 'tenants', '[id]');
const PAGINA = fs.readFileSync(path.join(DIR, 'page.tsx'), 'utf8');
const COMPONENTES = fs.readFileSync(path.join(DIR, 'componentes.tsx'), 'utf8');

let ok = 0;
const falhas = [];
const chk = (nome, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${extra ? ' — ' + extra : ''}`); }
};

console.log('\n=== 1. Nav e conteúdo saem da MESMA lista ===\n');

// As abas, lidas da fonte. `['prompt', 'Prompt'],`
const ABAS = [...PAGINA.matchAll(/^\s*\['([a-z]+)', '([^']+)'\],$/gm)].map((m) => m[1]);
chk('a varredura ACHOU as abas (lista vazia reprova antes de comparar)', ABAS.length > 0, `vieram ${ABAS.length}`);
chk('são 5 abas por assunto', ABAS.length === 5, ABAS.join(','));

// As chaves do objeto `paineis`: `  prompt: (`
const corpoPaineis = PAGINA.slice(PAGINA.indexOf('const paineis'));
const PAINEIS = [...corpoPaineis.matchAll(/^\s{4}([a-z]+): \(/gm)].map((m) => m[1]);
chk('a varredura ACHOU os painéis', PAINEIS.length > 0, `vieram ${PAINEIS.length}`);

const semPainel = ABAS.filter((a) => !PAINEIS.includes(a));
const semAba = PAINEIS.filter((p) => !ABAS.includes(p));
chk('toda aba declarada tem painel — aba que abre vazia é a divergência cara', semPainel.length === 0, semPainel.join(','));
chk('todo painel pertence a uma aba — painel órfão é código que ninguém alcança', semAba.length === 0, semAba.join(','));

console.log('\n=== 2. Nenhuma capacidade sumiu no caminho ===\n');

// Todo componente exportado por componentes.tsx (não os tipos).
const EXPORTADOS = [...COMPONENTES.matchAll(/^export function ([A-Z]\w+)/gm)].map((m) => m[1]);
chk('a varredura ACHOU componentes exportados', EXPORTADOS.length > 0, `vieram ${EXPORTADOS.length}`);
// NÃO afirme o NÚMERO. A versão de 06/10 dizia "são os 11 de hoje" e ficou
// vermelha no mesmo dia, quando `LimiteAgentes` nasceu — vermelha porque o
// sistema cresceu, que é a forma mais rápida de todo mundo parar de olhar a
// suíte (CLAUDE.md, "Afirme PROPRIEDADE, não estado do mundo"). É a terceira
// vez que este defeito exato aparece neste repositório, e a segunda numa
// entrega cujo texto já citava a regra.
//
// O piso continua porque mede OUTRA coisa: um regex quebrado devolveria um
// punhado em vez da lista inteira, e o `length > 0` acima não pegaria isso.
chk('a varredura achou a lista inteira, não um punhado (regex viva)', EXPORTADOS.length >= 8,
  `${EXPORTADOS.length}: ${EXPORTADOS.join(',')}`);

// Usado = aparece como tag JSX `<Nome`. Import sozinho não conta: importar e
// não renderizar é exatamente o defeito que este bloco existe para pegar.
const naoRenderizados = EXPORTADOS.filter((nome) => !new RegExp(`<${nome}\\b`).test(PAGINA));
chk('TODO componente exportado é renderizado na página', naoRenderizados.length === 0,
  'não aparecem no JSX: ' + naoRenderizados.join(', '));

// 06/10: `max_agentes` nasce na migração 81, e painel e banco são deploys
// independentes. Se alguém "simplificar" juntando a coluna ao `select` do
// tenant, um painel novo contra um banco sem a 81 derruba a ficha INTEIRA de
// todo cliente — não só a aba Pessoas. A separação é a proteção, então ela é
// medida.
const selectDoTenant = PAGINA.slice(PAGINA.indexOf(".from('tenants')"), PAGINA.indexOf('if (!tenant) notFound()'));
chk('o `select` principal do tenant NÃO pede max_agentes (a coluna pode não existir ainda)',
  !/max_agentes/.test(selectDoTenant));
chk('...e max_agentes vem numa consulta própria, que tolera o erro',
  /max_agentes/.test(PAGINA) && /erroLimite/.test(PAGINA));

console.log('\n=== 3. Link antigo não morre calado ===\n');

chk('`?aba=operacao` e `?aba=cadastro` ainda resolvem para uma aba viva',
  /APELIDOS[\s\S]{0,160}operacao:\s*'(\w+)'/.test(PAGINA) && /APELIDOS[\s\S]{0,160}cadastro:\s*'(\w+)'/.test(PAGINA));
const apelidos = [...(PAGINA.match(/const APELIDOS[^;]+;/)?.[0] ?? '').matchAll(/(\w+):\s*'(\w+)'/g)].map((m) => m[2]);
chk('os apelidos apontam para abas que EXISTEM', apelidos.length > 0 && apelidos.every((a) => ABAS.includes(a)),
  apelidos.join(',') + ' vs ' + ABAS.join(','));

console.log('\n=== 4. A prosa saiu do caminho, sem ser perdida ===\n');

/** Palavras de texto corrido IMPRESSAS sempre (fora de `<Ajuda>`). */
function palavrasFixas(fonte) {
  // tira o conteúdo de <Ajuda>…</Ajuda>: ele existe, mas só quando pedido
  const semAjuda = fonte.replace(/<Ajuda[\s\S]*?<\/Ajuda>/g, ' ');
  let n = 0;
  for (const m of semAjuda.matchAll(/<(p|CardDescription)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const t = m[2].replace(/<[^>]*>/g, ' ').replace(/\{[^}]*\}/g, ' ');
    n += t.split(/\s+/).filter((w) => /[a-zA-ZÀ-ú]/.test(w)).length;
  }
  return n;
}
const fixas = palavrasFixas(PAGINA);
// 408 era o número de 05/10, medido antes de mexer. O teto não é estética: é o
// que separa "a tela diz o essencial" de "a tela é o manual". Se subir de novo,
// a pergunta a fazer é se aquilo cabia num `<Ajuda>`.
chk(`a tela imprime no máximo 150 palavras fixas (eram 408 em 05/10) — hoje: ${fixas}`, fixas <= 150, String(fixas));

const ajudas = [...PAGINA.matchAll(/<Ajuda titulo="([^"]+)"/g)].map((m) => m[1]);
chk('a varredura ACHOU blocos de ajuda', ajudas.length > 0, `vieram ${ajudas.length}`);
chk('o texto não foi apagado: há ajuda em pelo menos 5 lugares', ajudas.length >= 5, ajudas.join(' | '));

// O que custou caro continua escrito em algum lugar — estes três avisos nasceram
// de erros reais e some-los seria perder a lição, não limpar a tela.
const DEVEM_SOBREVIVER = [
  ['a caixa errada falha calada', /para de responder nessa caixa, calado/],
  ['descontratar não apaga dado', /nunca apaga dado/],
  ['o prompt não é lugar de preço e horário', /base de conhecimento/],
];
for (const [nome, re] of DEVEM_SOBREVIVER) chk(`o aviso sobrevive: ${nome}`, re.test(PAGINA));

console.log('\n=== 5. O componente de ajuda ===\n');

// 06/10, SEGUNDA correcao do mesmo componente: ele deixou de flutuar e passou a
// EMPURRAR o conteudo ("tem muito texto sobrepondo um o outro", Felipe). Com
// isso, Escape e clique-fora deixaram de fazer sentido — eram muletas de
// popover; um bloco em flow fecha no proprio `?`, e `aria-expanded` e o que o
// leitor de tela precisa.
//
// As assercoes de COMPORTAMENTO do componente moram em `teste:ajuda-empurra`,
// que e dele. Aqui fica so o que esta tela precisa: que o `?` exista e carregue
// o texto que custou caro.
const AJUDA = fs.readFileSync(path.join(RAIZ, 'src', 'components', 'ui', 'ajuda.tsx'), 'utf8');
chk('o botao tem rotulo acessivel (e so um icone)', /aria-label=\{`Ajuda:/.test(AJUDA));
chk('e anuncia aberto/fechado', /aria-expanded=/.test(AJUDA));

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
