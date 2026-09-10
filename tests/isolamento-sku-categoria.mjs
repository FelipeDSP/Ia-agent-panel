#!/usr/bin/env node
/**
 * Isolamento de sku e categoria entre tenants.
 *
 * TRÊS tenants, não um nem dois: um esconde todo bug de isolamento, dois
 * escondem vazamento unidirecional (CLAUDE.md). E são EFÊMEROS, criados pelo
 * próprio teste — resolver seed por slug é o que deixou cinco testes cegos por
 * quatro dias em 13/08.
 *
 * ASSERÇÃO NEGATIVA PRECISA DE CONTRAPROVA. "O tenant A não vê a categoria de B"
 * é verdadeira por vacuidade quando B não tem categoria nenhuma — passaria com a
 * RLS ligada e com ela desligada. Cada seção aqui SEMEIA o conteúdo, confirma
 * que entrou, e só então afirma que o outro não o alcança.
 *
 * Tudo em UMA transação abortada: é o padrão mais forte quando não há
 * autenticação por HTTP no meio.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const MIGRACAO = fs.readFileSync(path.join(DIR, '20260910140000_57_sku_e_categoria.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(DIR, '20260910140000_57_sku_e_categoria_rollback.sql'), 'utf8');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

const url = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).replace(/^["']|["']$/g, '');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');

/** Roda como `authenticated` com o JWT de um tenant — é assim que o painel lê. */
async function comoTenant(tenantId, fn) {
  await c.query('savepoint sp_papel');
  await c.query(`set local role authenticated`);
  await c.query(`select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ app_metadata: { tenant_id: tenantId, papel: 'tenant_admin' } })]);
  try { return await fn(); } finally { await c.query('rollback to savepoint sp_papel'); }
}

try {
  console.log('\n== Isolamento de sku e categoria ==\n');

  // A migração precisa estar aplicada para haver o que medir. Rollback primeiro,
  // pelo mesmo motivo de sempre: não afirmar o calendário.
  await c.query(semTx(ROLLBACK));
  await c.query(semTx(MIGRACAO));

  // -----------------------------------------------------------------------
  console.log('-- 1. Três tenants efêmeros, com catálogo próprio --\n');
  const suf = Math.random().toString(16).slice(2, 8);
  const tenants = {};
  for (const nome of ['a', 'b', 'c']) {
    const r = await c.query(
      `insert into public.tenants (nome, slug) values ($1, $2) returning id`,
      [`Isolamento ${nome} ${suf}`, `iso-${nome}-${suf}`]);
    tenants[nome] = r.rows[0].id;
  }
  chk('três tenants criados', Object.keys(tenants).length === 3);

  // categoria + produto em cada um, com nomes IGUAIS entre tenants: se o
  // isolamento falhar, a colisão aparece.
  const cats = {};
  const prods = {};
  for (const [nome, tid] of Object.entries(tenants)) {
    const cat = await c.query(
      `insert into public.categorias (tenant_id, nome) values ($1,'Queijos') returning id`, [tid]);
    cats[nome] = cat.rows[0].id;
    const p = await c.query(
      `insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel, categoria_id)
       values ($1,'Queijo Nozinho',1000,'un',true,$2) returning id, sku`, [tid, cat.rows[0].id]);
    prods[nome] = p.rows[0];
  }

  // CONTRAPROVA: o conteúdo existe mesmo. Sem isto as negativas abaixo seriam vácuas.
  chk('cada tenant TEM uma categoria "Queijos" (contraprova)',
    Object.keys(cats).length === 3);
  chk('cada tenant TEM um produto com sku (contraprova)',
    Object.values(prods).every((p) => /^[0-9]+$/.test(p.sku)),
    Object.values(prods).map((p) => p.sku).join(','));

  // -----------------------------------------------------------------------
  console.log('\n-- 2. A sequência de sku é POR TENANT, não global --\n');
  const skus = Object.values(prods).map((p) => p.sku);
  chk('os três primeiros produtos receberam o MESMO número (cada um começa em 1)',
    new Set(skus).size === 1 && skus[0] === '1', skus.join(','));
  // sequência global faria o cliente ver "produto 1.847" e vazaria o tamanho da
  // base dos outros — é o motivo de a sequência ser por tenant.
  const segundo = await c.query(
    `insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel, categoria_id)
     values ($1,'Queijo Coalho',1000,'un',true,$2) returning sku`, [tenants.a, cats.a]);
  chk('o segundo produto do tenant A é o 2 (não continua de outro tenant)',
    segundo.rows[0].sku === '2', segundo.rows[0].sku);

  // -----------------------------------------------------------------------
  console.log('\n-- 3. Categoria de um tenant é invisível para o outro --\n');
  for (const [eu, outro] of [['a', 'b'], ['b', 'c'], ['c', 'a']]) {
    const vistas = await comoTenant(tenants[eu], async () => {
      const r = await c.query(`select id, tenant_id from public.categorias`);
      return r.rows;
    });
    chk(`[${eu}] enxerga só as próprias categorias`,
      vistas.length === 1 && vistas[0].tenant_id === tenants[eu],
      `viu ${vistas.length}`);
    chk(`[${eu}] NÃO enxerga a categoria de ${outro}`,
      !vistas.some((v) => v.id === cats[outro]));
  }

  // -----------------------------------------------------------------------
  console.log('\n-- 4. Produto e sku de um tenant são invisíveis para o outro --\n');
  for (const [eu, outro] of [['a', 'b'], ['b', 'c'], ['c', 'a']]) {
    const vistos = await comoTenant(tenants[eu], async () => {
      const r = await c.query(`select id, sku, tenant_id from public.produtos`);
      return r.rows;
    });
    chk(`[${eu}] NÃO enxerga o produto de ${outro}`,
      !vistos.some((v) => v.id === prods[outro].id),
      `viu ${vistos.length} produtos`);
  }

  // -----------------------------------------------------------------------
  console.log('\n-- 5. Categoria de outro tenant não é SELECIONÁVEL --\n');
  // A RLS não pega este caso: a categoria alheia nunca é lida, ela só aparece
  // como valor na FK. Quem recusa é a FK composta (tenant_id, categoria_id).
  await c.query('savepoint sp_fk');
  let codigo = null;
  try {
    await c.query(
      `insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel, categoria_id)
       values ($1,'Sonda',100,'un',true,$2)`, [tenants.a, cats.b]);
  } catch (e) { codigo = e.code; }
  await c.query('rollback to savepoint sp_fk');
  chk('INSERT com categoria de outro tenant é recusado (23503)', codigo === '23503', `codigo=${codigo}`);

  await c.query('savepoint sp_fk2');
  codigo = null;
  try {
    await c.query(`update public.produtos set categoria_id = $1 where id = $2`,
      [cats.b, prods.a.id]);
  } catch (e) { codigo = e.code; }
  await c.query('rollback to savepoint sp_fk2');
  chk('UPDATE apontando para categoria de outro tenant é recusado (23503)',
    codigo === '23503', `codigo=${codigo}`);

  // -----------------------------------------------------------------------
  console.log('\n-- 6. Um tenant não renomeia nem remove categoria do outro --\n');
  const tentouRenomear = await comoTenant(tenants.a, async () => {
    const r = await c.query(
      `update public.categorias set nome='Sequestrada' where id=$1 returning id`, [cats.b]);
    return r.rowCount;
  });
  chk('[a] renomear categoria de b atinge ZERO linhas', tentouRenomear === 0, `${tentouRenomear}`);

  const tentouRemover = await comoTenant(tenants.a, async () => {
    const r = await c.query(`delete from public.categorias where id=$1 returning id`, [cats.b]);
    return r.rowCount;
  });
  chk('[a] remover categoria de b atinge ZERO linhas', tentouRemover === 0, `${tentouRemover}`);

  // CONTRAPROVA da negativa acima: b ainda está lá, com o nome original.
  const bIntacta = await c.query(`select nome from public.categorias where id=$1`, [cats.b]);
  chk('e a categoria de b continua intacta (contraprova)',
    bIntacta.rows[0]?.nome === 'Queijos', bIntacta.rows[0]?.nome);

  // -----------------------------------------------------------------------
  console.log('\n-- 7. O contador de sku não é legível pelo cliente --\n');
  const contador = await comoTenant(tenants.a, async () => {
    try {
      const r = await c.query(`select * from public.produto_sku_seq`);
      return { linhas: r.rows.length, erro: null };
    } catch (e) { return { linhas: null, erro: e.code }; }
  });
  chk('`produto_sku_seq` devolve ZERO linhas para authenticated (RLS sem policy)',
    contador.linhas === 0 || contador.erro === '42501',
    JSON.stringify(contador));

  // -----------------------------------------------------------------------
  console.log('\n-- 8. SABOTAGEM: sem a FK composta, a categoria alheia entra --\n');
  await c.query('savepoint sp_sab');
  const antes = await c.query(
    `select count(*)::int n from pg_constraint where conname='produtos_categoria_fk'`);
  await c.query(`alter table public.produtos drop constraint produtos_categoria_fk`);
  const depois = await c.query(
    `select count(*)::int n from pg_constraint where conname='produtos_categoria_fk'`);
  chk('a sabotagem ENTROU (a FK sumiu)', antes.rows[0].n === 1 && depois.rows[0].n === 0,
    `antes=${antes.rows[0].n} depois=${depois.rows[0].n}`);
  let passou = false;
  try {
    await c.query(
      `insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel, categoria_id)
       values ($1,'Sonda sabotagem',100,'un',true,$2)`, [tenants.a, cats.b]);
    passou = true;
  } catch { passou = false; }
  await c.query('rollback to savepoint sp_sab');
  chk('SABOTAGEM sem a FK composta -> produto ACEITA categoria de outro tenant',
    passou === true, 'deveria ter passado, provando que é a FK que segura');
} catch (err) {
  falhas.push('exceção');
  console.log(`\n  EXCEÇÃO: ${err.code ?? ''} ${err.message}`);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
