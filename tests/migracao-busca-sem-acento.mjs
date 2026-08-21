#!/usr/bin/env node
/**
 * Migração 50 (busca sem acento + sugestão por proximidade) numa TRANSAÇÃO
 * ABORTADA contra produção. Nada é gravado: o rollback no fim é incondicional —
 * inclusive as duas EXTENSÕES, que a migração instala e esta transação desfaz.
 *
 * O QUE ELE PROVA, e ler o SQL não prova:
 *
 *   - que os DOIS casos reais passam a achar, contra o catálogo REAL do
 *     `emporio` (41 itens). Não é fixture: se alguém renomear o produto no
 *     painel, o teste avisa em vez de mentir;
 *   - que os termos fora de catálogo continuam dando ZERO, e — o que importa
 *     mais — que **nem sugestão** aparece para eles;
 *   - que `total_encontrado` continua 0 quando só há sugestões. É a propriedade
 *     central: o sinal numérico que o prompt lê não pode ser contaminado pelo
 *     texto;
 *   - que o ACL de `api_n8n_buscar_produtos` atravessa intacto (diff contra si
 *     mesmo, não contra lista escrita à mão — foi assim que a 41 passou verde
 *     sem `n8n_agent`);
 *   - que `n8n_agent` CHAMA depois da migração;
 *   - que `idx_produtos_busca` continua existindo e com a MESMA definição — a
 *     camada 1 ficou fora do ramo FTS justamente para não invalidá-lo.
 *
 * AS SABOTAGENS (seção 6) tiram o `unaccent` e baixam o limiar para 0.2, e
 * exigem que o teste reprove nas duas. Sem elas isto seria uma lista de coisas
 * que passaram.
 *
 * Uso: npm run teste:busca-sem-acento
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DIR = RAIZ + 'supabase/migrations/';

/** Acha o arquivo pelo sufixo, para sobreviver ao rename do ledger. */
function acharMigracao(sufixo) {
  const achados = fs.readdirSync(DIR).filter((f) => f.endsWith(sufixo));
  if (achados.length !== 1) throw new Error(`esperava 1 arquivo em "${sufixo}", achei ${achados.length}`);
  return fs.readFileSync(DIR + achados[0], 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
}
const M50 = acharMigracao('_50_busca_sem_acento.sql');
const R50 = acharMigracao('_50_busca_sem_acento_rollback.sql');

if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

let ok = 0, okSus = 0;
const falhas = [], avisos = [];
const chk = (n, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${n}`); }
  else { falhas.push(`${n}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${n}${det ? ' — ' + det : ''}`); }
};
const sus = (n, cond, det = '') => {
  if (cond) { okSus++; console.log(`  OK  ~ ${n}`); }
  else { falhas.push(`[sustentação] ${n}${det ? ' — ' + det : ''}`); console.log(`  FALHA ~ ${n}${det ? ' — ' + det : ''}`); }
};
const aviso = (t) => { avisos.push(t); console.log(`  AVISO ${t}`); };

async function tentar(sql, p = []) {
  await c.query('savepoint sp');
  try { const r = await c.query(sql, p); await c.query('release savepoint sp'); return { erro: null, rows: r.rows }; }
  catch (e) { await c.query('rollback to savepoint sp'); return { erro: e.message, codigo: e.code, rows: [] }; }
}
async function comoRole(role, sql, p = []) {
  await c.query('savepoint sr');
  try {
    await c.query(`set local role ${role}`);
    const r = await c.query(sql, p);
    await c.query('reset role'); await c.query('release savepoint sr');
    return { erro: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sr'); await c.query('reset role');
    return { erro: e.message, codigo: e.code, rows: [] };
  }
}

const acl = async () => (await c.query(
  `select coalesce(p.proacl::text,'(default)') a from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='api_n8n_buscar_produtos'`)).rows[0].a;

const buscar = async (t, termo) => (await c.query(
  `select total_encontrado, total_catalogo, mostrando, houve_busca, texto
     from public.api_n8n_buscar_produtos($1::uuid,$2::text)`, [t, termo])).rows[0];

const defIdx = async () => (await c.query(
  `select indexdef from pg_indexes where schemaname='public' and indexname='idx_produtos_busca'`)).rows[0]?.indexdef ?? null;

/** Termos fora de catálogo: nem resultado, nem sugestão. */
const FORA = ['guarda-chuva', 'cimento', 'pneu', 'notebook', 'cadeira', 'gasolina', 'camiseta', 'bicicleta'];

await c.connect();

const extAntesDeTudo = (await c.query(
  `select count(*)::int n from pg_extension where extname in ('unaccent','pg_trgm')`)).rows[0].n;

await c.query('begin');
try {
  console.log('\n== Migração 50: busca sem acento + sugestão ==\n');
  console.log('-- 1. Arranja o estado de ANTES --\n');

  await c.query(R50);
  sus('o rollback deixou a função na forma pré-50 (sem unaccent no corpo)',
    !(await c.query(`select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='api_n8n_buscar_produtos'`)).rows[0].prosrc.includes('extensions.unaccent'));

  const T = (await c.query(`select id from public.tenants where slug='emporio'`)).rows[0]?.id;
  if (!T) throw new Error('tenant `emporio` não existe — este teste mede o catálogo REAL dele');

  const cat = (await c.query(`select count(*)::int n from public.produtos
     where tenant_id=$1 and deletado_em is null and disponivel and (estoque is null or estoque>0)`, [T])).rows[0].n;
  sus('o catálogo do emporio não está vazio (anti-vacuidade)', cat > 0, `${cat} itens`);
  console.log(`  (catálogo do emporio: ${cat} itens disponíveis)`);

  /*
   * OS ALVOS SÃO RESOLVIDOS DO BANCO, não fixados no teste. Se alguém renomear
   * "Pão de queijo tradicional" pelo painel — operação legítima — o teste emite
   * AVISO em vez de vermelho: ele mede a MIGRAÇÃO, e o nome do produto é estado
   * do mundo que uma pessoa pode mudar.
   */
  const CASOS = [
    { termo: 'pao de queijo', like: '%de queijo tradicional%' },
    { termo: 'queijo nózinho', like: '%Nozinho%' },
  ];
  for (const caso of CASOS) {
    const r = (await c.query(`select nome from public.produtos where tenant_id=$1 and nome ilike $2
       and deletado_em is null and disponivel`, [T, caso.like])).rows[0];
    caso.alvo = r?.nome ?? null;
    if (!caso.alvo) aviso(`o produto de "${caso.termo}" (${caso.like}) não está no catálogo — o caso ficou sem alvo`);
  }

  console.log('\n-- 2. ANTES da 50: os dois casos falham (contraprova) --\n');
  for (const caso of CASOS.filter((x) => x.alvo)) {
    const r = await buscar(T, caso.termo);
    chk(`"${caso.termo}" dá 0 ANTES da migração (o defeito existe)`,
      r.total_encontrado === 0, `veio ${r.total_encontrado}`);
  }

  const aclAntes = await acl();
  const idxAntes = await defIdx();
  sus('`idx_produtos_busca` existe antes', idxAntes !== null);

  console.log('\n-- 3. Aplica a migração --\n');
  const ap = await tentar(M50);
  chk('a migração aplica', ap.erro === null, ap.erro ?? '');
  chk('as duas extensões ficaram instaladas em `extensions`',
    (await c.query(`select count(*)::int n from pg_extension e join pg_namespace ns on ns.oid=e.extnamespace
       where e.extname in ('unaccent','pg_trgm') and ns.nspname='extensions'`)).rows[0].n === 2);
  chk('`idx_produtos_busca` NÃO foi tocado (a camada 1 ficou fora do ramo FTS)',
    (await defIdx()) === idxAntes, `${idxAntes}\n      -> ${await defIdx()}`);
  chk('o ACL é IDÊNTICO ao de antes (sem drop, nada a reconceder)',
    (await acl()) === aclAntes, `antes=${aclAntes} depois=${await acl()}`);
  chk('`n8n_agent` continua no ACL', (await acl()).includes('n8n_agent'));
  const ass = (await c.query(`select p.pronargs::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='public' and p.proname='api_n8n_buscar_produtos'`)).rows;
  chk('existe EXATAMENTE UMA assinatura viva, de 2 argumentos',
    ass.length === 1 && ass[0].n === 2, ass.map((x) => x.n).join(','));

  console.log('\n-- 4. Os dois casos reais passam a achar --\n');
  for (const caso of CASOS.filter((x) => x.alvo)) {
    const r = await buscar(T, caso.termo);
    chk(`"${caso.termo}" acha (>=1) e traz "${caso.alvo.slice(0, 28)}"`,
      r.total_encontrado >= 1 && r.texto.includes(caso.alvo),
      `encontrados=${r.total_encontrado} texto=${r.texto.slice(0, 90)}`);
  }
  const semAcento = await buscar(T, 'pao');
  const comAcento = await buscar(T, 'pão');
  chk('"pao" e "pão" devolvem a MESMA contagem (o acento deixou de importar)',
    semAcento.total_encontrado === comAcento.total_encontrado,
    `${semAcento.total_encontrado} vs ${comAcento.total_encontrado}`);

  console.log('\n-- 5. O ramo de zero, e a sugestão --\n');
  const typo = await buscar(T, 'quejo');
  chk('typo "quejo": total_encontrado continua 0 (o sinal numérico não é contaminado)',
    typo.total_encontrado === 0, `veio ${typo.total_encontrado}`);
  chk('typo "quejo": o texto traz PARECIDOS', /Parecidos/.test(typo.texto), typo.texto.slice(0, 120));
  chk('typo "quejo": e o texto diz SUGESTÃO, não resultado',
    /SUGEST[ÃA]O, não resultado/.test(typo.texto), typo.texto.slice(0, 160));
  chk('typo "quejo": as sugestões são de queijo', /Queijo/i.test(typo.texto.split('Parecidos')[1] ?? ''),
    (typo.texto.split('Parecidos')[1] ?? '').slice(0, 90));
  chk('typo "quejo": `houve_busca` continua true', typo.houve_busca === true);

  console.log('\n  -- termos fora de catálogo: zero E sem sugestão --');
  for (const termo of FORA) {
    const r = await buscar(T, termo);
    chk(`"${termo}": 0 encontrados e NENHUM parecido`,
      r.total_encontrado === 0 && !/Parecidos/.test(r.texto),
      `enc=${r.total_encontrado} ${/Parecidos/.test(r.texto) ? 'COM parecidos: ' + r.texto.split('Parecidos')[1].slice(0, 70) : ''}`);
  }

  console.log('\n-- 6. `n8n_agent` chama de verdade --\n');
  const viaRole = await comoRole('n8n_agent',
    `select total_encontrado, texto from public.api_n8n_buscar_produtos($1::uuid,$2::text)`, [T, 'pao de queijo']);
  chk('`n8n_agent` CHAMA e recebe resultado', viaRole.erro === null && viaRole.rows[0]?.total_encontrado >= 1,
    viaRole.erro ?? JSON.stringify(viaRole.rows[0]).slice(0, 90));

  console.log('\n-- 7. Reexecutável e rollback --\n');
  const r2 = await tentar(M50);
  chk('aplicar duas vezes não quebra', r2.erro === null, r2.erro ?? '');
  chk('e o ACL continua o mesmo', (await acl()) === aclAntes);

  await c.query(R50);
  chk('o rollback devolve a forma antiga (os dois casos voltam a dar 0)',
    (await buscar(T, 'pao de queijo')).total_encontrado === 0);
  chk('e o rollback NÃO dropa as extensões (é deliberado — ver o cabeçalho dele)',
    (await c.query(`select count(*)::int n from pg_extension where extname in ('unaccent','pg_trgm')`)).rows[0].n === 2);
  chk('o ACL atravessa o rollback intacto', (await acl()) === aclAntes);
  await c.query(M50);

  console.log('\n-- 8. Sabotagem --\n');
  {
    // Tira o unaccent do ramo ilike: os dois casos reais têm de voltar a falhar.
    const DE = "or extensions.unaccent(p.nome) ilike '%' || extensions.unaccent(v_termo) || '%'";
    const PARA = "or p.nome ilike '%' || v_termo || '%'";
    const sab = M50.replace(DE, PARA);
    sus('S1 mutação entrou (o unaccent saiu do filtro)', sab !== M50 && !sab.includes(DE));
    const r = await tentar(sab);
    sus('S1 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    const a = await buscar(T, 'pao de queijo');
    const b = await buscar(T, 'queijo nózinho');
    chk('S1 sem o unaccent, os DOIS casos voltam a dar 0 (o teste reprova)',
      a.total_encontrado === 0 && b.total_encontrado === 0,
      `pao de queijo=${a.total_encontrado} queijo nózinho=${b.total_encontrado}`);
    await c.query(M50);
  }
  {
    // Baixa o limiar para 0.2: o lixo tem de aparecer.
    const DE = 'c_prox constant real := 0.4;';
    const PARA = 'c_prox constant real := 0.2;';
    const sab = M50.replace(DE, PARA);
    sus('S2 mutação entrou (limiar 0.4 -> 0.2)', sab !== M50 && sab.includes(PARA));
    const r = await tentar(sab);
    sus('S2 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    const comLixo = [];
    for (const termo of FORA) {
      const x = await buscar(T, termo);
      if (/Parecidos/.test(x.texto)) comLixo.push(termo);
    }
    chk('S2 com 0.2, termos fora de catálogo passam a receber sugestão (o teste reprova)',
      comLixo.length > 0, `nenhum termo trouxe lixo — o limiar 0.4 não estaria segurando nada`);
    console.log(`        (trouxeram lixo a 0.2: ${comLixo.join(', ') || 'nenhum'})`);
    await c.query(M50);
  }
} catch (e) {
  falhas.push(`exceção não prevista: ${e.message}`);
  console.log(`  FALHA exceção não prevista — ${e.message}`);
} finally {
  await c.query('rollback');
  const extDepois = (await c.query(
    `select count(*)::int n from pg_extension where extname in ('unaccent','pg_trgm')`)).rows[0].n;
  console.log(`\n  (transação revertida; extensões em produção: ${extDepois}` +
    ` — igual a antes do teste: ${extAntesDeTudo === extDepois ? 'sim' : 'NÃO'})`);
  if (extAntesDeTudo !== extDepois) {
    falhas.push(`o teste mudou as extensões de produção (antes ${extAntesDeTudo}, depois ${extDepois})`);
  }
  await c.end();
}

console.log('\n----------------------------------------------------------');
console.log(`  ${ok + okSus} passaram, ${falhas.length} falharam, ${avisos.length} aviso(s)`);
console.log(`    ${ok} por motivo próprio (propriedade da migração)`);
console.log(`    ${okSus} de sustentação (~) — provam que o TESTE faz o que diz`);
falhas.forEach((f) => console.log(`  ! ${f}`));
avisos.forEach((a) => console.log(`  ~ ${a}`));
console.log();
process.exit(falhas.length === 0 ? 0 : 1);
