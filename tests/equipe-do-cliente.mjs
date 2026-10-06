/**
 * A tela de Equipe e as permissões do painel do cliente (06/10/2026).
 *
 * O que este arquivo existe para impedir, e é UM defeito com três caras:
 * **o menu mostrar o que a rota nega, ou a rota liberar o que o menu esconde.**
 *
 * `CAPACIDADE_DA_ROTA` (que monta o menu) e o `exigirMembro('...')` de cada
 * página são um PAR DERIVADO. Se divergirem, o agente clica num item e leva
 * 404 — ou, pior, não vê um item que poderia usar e ninguém descobre. É a
 * mesma família do `tem_rascunho` de 09/09: a asserção certa, no lado errado
 * do par. Aqui os dois lados são lidos do disco e comparados.
 *
 * E a terceira porta: Server Action é entrada própria, não passa por página
 * nenhuma. Toda ação do painel tem de ter guarda, e a varredura exige isso de
 * TODA função exportada — ação nova entra sozinha.
 *
 * `split(/\r?\n/)` porque 174 arquivos deste repo estão em CRLF.
 *
 *   npm run teste:equipe-do-cliente
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAINEL = path.join(RAIZ, 'src', 'app', '(app)', 'painel');

// Import relativo com extensão, como `teste:superficie` faz: o `new URL(...)`
// resolve para um href que o Node trata como caminho e aí as importações
// internas do registry (sem extensão, estilo TS) não resolvem.
import { CAPACIDADE_DA_ROTA, ehSomenteAdmin } from '../src/lib/tools/registro.ts';
import { CHAVES_CAPACIDADES, CAPACIDADES } from '../src/lib/usuarios/capacidades.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

/** Todos os arquivos sob /painel, com o caminho de rota de cada page/layout. */
function varrer(dir, rel = '') {
  const saida = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) saida.push(...varrer(p, rel ? `${rel}/${e.name}` : e.name));
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
      saida.push({ arquivo: e.name, rel, caminho: p, fonte: fs.readFileSync(p, 'utf8') });
    }
  }
  return saida;
}
const arquivos = varrer(PAINEL);

console.log('\n=== 1. A varredura achou o painel ===\n');
chk('achou arquivos sob /painel (lista vazia reprova antes de comparar)', arquivos.length > 0, String(arquivos.length));
const paginas = arquivos.filter((a) => a.arquivo === 'page.tsx' || a.arquivo === 'layout.tsx');
chk('achou as páginas e layouts', paginas.length >= 10, String(paginas.length));

console.log('\n=== 2. Toda página tem guarda ===\n');
const semGuarda = paginas.filter((a) => !/exigirMembro\(|exigirTenantAdmin\(|exigirUsuario\(/.test(a.fonte));
chk('nenhuma página do painel fica sem guarda', semGuarda.length === 0,
  semGuarda.map((a) => `${a.rel}/${a.arquivo}`).join(', '));

console.log('\n=== 3. O PAR DERIVADO: menu e rota dizem a mesma coisa ===\n');

// O que a página de cada rota de fato exige.
const exigeNaRota = new Map();
for (const a of paginas) {
  const rota = a.rel ? `/painel/${a.rel}` : '/painel';
  // só a rota "raiz" de cada seção interessa: o menu aponta para ela
  if (a.rel.includes('[')) continue;
  const m = a.fonte.match(/exigirMembro\(\s*'([a-z_]+)'\s*\)/);
  const soAdmin = /exigirTenantAdmin\(/.test(a.fonte);
  if (m) exigeNaRota.set(rota, m[1]);
  else if (soAdmin) exigeNaRota.set(rota, 'ADMIN');
  else exigeNaRota.set(rota, null);
}
chk('a varredura leu o que as rotas exigem', exigeNaRota.size > 0, String(exigeNaRota.size));

const divergentes = [];
for (const [rota, cap] of Object.entries(CAPACIDADE_DA_ROTA)) {
  const real = exigeNaRota.get(rota);
  if (real !== cap) divergentes.push(`${rota}: menu diz ${cap}, rota exige ${real}`);
}
chk('toda rota do mapa do menu exige a MESMA capacidade na página', divergentes.length === 0,
  divergentes.join(' | '));

// E o contrário, só para o que É item de menu: rota de primeiro nível que
// exige capacidade e não está no mapa some do menu de quem poderia usá-la —
// o defeito silencioso, que ninguém relata porque nada aparece.
const nivel = (rota) => rota.split('/').filter(Boolean).length; // /painel = 1
const faltandoNoMapa = [...exigeNaRota.entries()]
  .filter(([rota, cap]) => cap && cap !== 'ADMIN' && nivel(rota) === 2 && !(rota in CAPACIDADE_DA_ROTA))
  .map(([rota, cap]) => `${rota} exige ${cap} e não está no mapa`);
chk('toda rota DE MENU que exige capacidade está no mapa do menu', faltandoNoMapa.length === 0,
  faltandoNoMapa.join(' | '));

// Sub-página não entra no menu — ela é alcançada de DENTRO da seção. Por isso
// ela não pode exigir MAIS do que a seção: o agente entraria em Catálogo e
// bateria num 404 ao clicar em Categorias, sem nada explicando por quê.
const subPaginas = [...exigeNaRota.entries()].filter(([rota]) => nivel(rota) > 2);
chk('a varredura achou sub-páginas', subPaginas.length > 0, String(subPaginas.length));
const subDivergentes = subPaginas
  .filter(([rota, cap]) => {
    const pai = '/' + rota.split('/').filter(Boolean).slice(0, 2).join('/');
    const capPai = exigeNaRota.get(pai) ?? null;
    return cap !== capPai;
  })
  .map(([rota, cap]) => `${rota} exige ${cap}, a seção exige ${exigeNaRota.get('/' + rota.split('/').filter(Boolean).slice(0, 2).join('/'))}`);
chk('nenhuma sub-página exige coisa diferente da seção dela', subDivergentes.length === 0,
  subDivergentes.join(' | '));

console.log('\n=== 4. Equipe e Configurações são só do admin ===\n');
chk('/painel/equipe está declarada como somenteAdmin', ehSomenteAdmin('/painel/equipe'));
chk('/painel/configuracoes está declarada como somenteAdmin', ehSomenteAdmin('/painel/configuracoes'));
chk('a Visão geral NÃO é somenteAdmin (o agente precisa de alguma porta)', !ehSomenteAdmin('/painel'));
chk('a página de Equipe usa exigirTenantAdmin, não exigirMembro', exigeNaRota.get('/painel/equipe') === 'ADMIN',
  String(exigeNaRota.get('/painel/equipe')));

console.log('\n=== 5. A terceira porta: Server Action ===\n');
const acoes = arquivos.filter((a) => a.arquivo.startsWith('acoes'));
chk('a varredura achou os arquivos de ação', acoes.length > 0, String(acoes.length));

const semGuardaNaAcao = [];
for (const a of acoes) {
  const linhas = a.fonte.split(/\r?\n/);
  let atual = null;
  let corpo = [];
  const fecha = () => {
    if (atual && !corpo.some((l) => /exigirMembro\(|exigirTenantAdmin\(|exigirSuperAdmin\(/.test(l))) {
      semGuardaNaAcao.push(`${a.rel}/${a.arquivo}:${atual}`);
    }
  };
  for (const l of linhas) {
    const m = l.match(/^export async function (\w+)/);
    if (m) { fecha(); atual = m[1]; corpo = []; }
    else if (atual) corpo.push(l);
  }
  fecha();
}
chk('TODA Server Action do painel começa por uma guarda', semGuardaNaAcao.length === 0,
  semGuardaNaAcao.join(', '));

const equipeAcoes = acoes.find((a) => a.rel === 'equipe');
chk('as ações de Equipe existem', Boolean(equipeAcoes));
if (equipeAcoes) {
  const exportadas = [...equipeAcoes.fonte.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
  chk('são 5 ações de equipe (convidar, remover, link, função, trocar função)', exportadas.length >= 5,
    exportadas.join(','));
  const semAdmin = exportadas.filter((n) => {
    const i = equipeAcoes.fonte.indexOf(`export async function ${n}`);
    const trecho = equipeAcoes.fonte.slice(i, i + 400);
    return !/exigirTenantAdmin\(/.test(trecho);
  });
  chk('TODA ação de equipe exige admin do tenant (agente não gere colega)', semAdmin.length === 0,
    semAdmin.join(', '));
  chk('nenhuma lê tenant_id do formulário (regra 1 do CLAUDE.md)',
    !/get\('tenant_id'\)/.test(equipeAcoes.fonte));
}

console.log('\n=== 6. As capacidades da tela são as do código ===\n');
chk('o formulário de função oferece TODAS as capacidades', CAPACIDADES.length === CHAVES_CAPACIDADES.length,
  `${CAPACIDADES.length} vs ${CHAVES_CAPACIDADES.length}`);
chk('toda capacidade tem rótulo e resumo para o cliente ler',
  CAPACIDADES.every((c) => c.rotulo && c.resumo),
  CAPACIDADES.filter((c) => !c.rotulo || !c.resumo).map((c) => c.chave).join(','));

console.log('\n=== 7. Sabotagem ===\n');
// S1: divergir o par derivado tem de reprovar
const mapaSabotado = { ...CAPACIDADE_DA_ROTA, '/painel/conversas': 'editar_prompt' };
const divSab = Object.entries(mapaSabotado).filter(([r, c]) => exigeNaRota.get(r) !== c);
chk('S1: menu pedindo capacidade diferente da rota é detectado', divSab.length > 0,
  divSab.map(([r]) => r).join(','));
// S2: página sem guarda tem de reprovar
const fonteSemGuarda = 'export default async function P() { return null; }';
chk('S2: página sem guarda nenhuma é detectada',
  !/exigirMembro\(|exigirTenantAdmin\(|exigirUsuario\(/.test(fonteSemGuarda));
// S3: ação sem guarda tem de reprovar
const acaoSemGuarda = ['export async function x(fd) {', '  return {};', '}'];
chk('S3: Server Action sem guarda é detectada',
  !acaoSemGuarda.some((l) => /exigirMembro\(|exigirTenantAdmin\(|exigirSuperAdmin\(/.test(l)));

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
