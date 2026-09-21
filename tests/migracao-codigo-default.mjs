/**
 * Migração 75 — `codigo` é o default de `tenants.agente_runtime`.
 *
 * Rollback-first, 75 duas vezes. Propriedades: tenant inserido SEM informar
 * a coluna nasce em `codigo` (era `n8n` na 62); tenant que estava em `n8n`
 * passa a `codigo`; o CHECK continua aceitando `n8n` (arranjo de teste); a
 * coluna continua agência-only (tenant_admin leva 42501); o rollback devolve
 * o default a `n8n` e NÃO mexe nos tenants. Tudo em transação abortada, com
 * tenants criados aqui — nada de seed por slug.
 *
 *   npm run teste:migracao-codigo-default
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M75 = leia('20260921190000_75_codigo_e_o_default.sql');
const R75 = leia('20260921190000_75_codigo_e_o_default_rollback.sql');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
const url = process.env.SUPABASE_DB_URL ?? fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))?.slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');
const um = async (sql, p = []) => (await c.query(sql, p)).rows[0];
const defaultDaColuna = async () => (await um(`select column_default d from information_schema.columns where table_name='tenants' and column_name='agente_runtime'`)).d;
const como = async (claims, sql, p = []) => {
  await c.query('savepoint sp'); await c.query('set local role authenticated');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
  try { const r = await c.query(sql, p); await c.query('release savepoint sp'); await c.query('reset role'); await c.query(`select set_config('request.jwt.claims', '', true)`); return { ok: true, rows: r.rowCount }; }
  catch (e) { await c.query('rollback to savepoint sp'); return { ok: false, code: e.code }; }
};

try {
  console.log('\n== 0. Rollback primeiro: o mundo da 62 ==\n');
  await c.query(semTx(R75));
  chk('pré-75: default é n8n', /'n8n'/.test(await defaultDaColuna()), await defaultDaColuna());
  const T = {};
  // três tenants: um sem a coluna (vai pelo default), um em n8n explícito, um em codigo
  T.def = (await um(`insert into public.tenants (slug, nome) values ('z-teste-75-default', 'Teste 75 default') returning id, agente_runtime`));
  T.n8n = (await um(`insert into public.tenants (slug, nome, agente_runtime) values ('z-teste-75-n8n', 'Teste 75 n8n', 'n8n') returning id, agente_runtime`));
  T.cod = (await um(`insert into public.tenants (slug, nome, agente_runtime) values ('z-teste-75-codigo', 'Teste 75 codigo', 'codigo') returning id, agente_runtime`));
  chk('contraprova: antes da 75, quem nasce sem informar nasce em n8n (mudo para o serviço)', T.def.agente_runtime === 'n8n', T.def.agente_runtime);
  const emN8nAntes = (await um(`select count(*)::int n from public.tenants where agente_runtime = 'n8n'`)).n;
  chk('há pelo menos um tenant em n8n para a migração converter (lista vazia aprovaria qualquer coisa)', emN8nAntes >= 1, String(emN8nAntes));

  console.log('\n== 1. A 75, duas vezes ==\n');
  await c.query(semTx(M75)); await c.query(semTx(M75));
  chk('default agora é codigo', /'codigo'/.test(await defaultDaColuna()), await defaultDaColuna());
  const depois = async (id) => (await um(`select agente_runtime r from public.tenants where id=$1`, [id])).r;
  chk('o tenant que estava em n8n passou a codigo', (await depois(T.n8n.id)) === 'codigo');
  chk('o que nasceu pelo default antigo também', (await depois(T.def.id)) === 'codigo');
  chk('o que já era codigo continua', (await depois(T.cod.id)) === 'codigo');
  chk('ninguém sobrou em n8n', (await um(`select count(*)::int n from public.tenants where agente_runtime = 'n8n'`)).n === 0);
  const novo = await um(`insert into public.tenants (slug, nome) values ('z-teste-75-novo', 'Teste 75 novo') returning id, agente_runtime`);
  chk('tenant novo SEM informar a coluna nasce em codigo', novo.agente_runtime === 'codigo', novo.agente_runtime);
  chk('api_agente_runtime devolve codigo para ele (é o que o serviço consulta)', (await um(`select public.api_agente_runtime($1) r`, [novo.id])).r === 'codigo');

  console.log('\n== 2. O que NÃO mudou ==\n');
  // O guard barra até `postgres` sem claim (é o que a migração contorna
  // desligando o trigger); o arranjo aqui vai como super_admin, que é como o
  // painel da agência escreve.
  const comoSuper = async (sql, p) => {
    await c.query('savepoint sa');
    await c.query(`select set_config('request.jwt.claims', '{"app_metadata":{"papel":"super_admin"}}', true)`);
    try { await c.query(sql, p); await c.query('release savepoint sa'); return { ok: true }; }
    catch (e) { await c.query('rollback to savepoint sa'); return { ok: false, code: e.code }; }
    finally { await c.query(`select set_config('request.jwt.claims', '', true)`); }
  };
  const arranjo = await comoSuper(`update public.tenants set agente_runtime = 'n8n' where id = $1`, [T.cod.id]);
  chk('o CHECK continua aceitando n8n (arranjo de teste para provar o descarte)', arranjo.ok === true, JSON.stringify(arranjo));
  const lua = await comoSuper(`update public.tenants set agente_runtime = 'lua' where id = $1`, [T.cod.id]);
  chk('e continua recusando valor fora de {n8n, codigo}', !lua.ok && lua.code === '23514', JSON.stringify(lua));
  chk('o trigger do guard está LIGADO depois da migração (ela desliga e religa)', (await um(`select tgenabled e from pg_trigger where tgname = 'trg_tenants_guard_colunas'`)).e === 'O');
  const ca = { role: 'authenticated', sub: '00000000-0000-0000-0000-000000000075', app_metadata: { tenant_id: T.def.id, papel: 'tenant_admin' } };
  const r = await como(ca, `update public.tenants set agente_runtime = 'n8n' where id = $1`, [T.def.id]);
  chk('agente_runtime continua da agência: tenant_admin leva 42501', !r.ok && r.code === '42501', JSON.stringify(r));

  console.log('\n== 3. Rollback: devolve o default, não os tenants ==\n');
  await c.query(semTx(R75));
  chk('default volta a n8n', /'n8n'/.test(await defaultDaColuna()), await defaultDaColuna());
  chk('os tenants convertidos FICAM em codigo (rollback não emudece cliente)', (await depois(T.n8n.id)) === 'codigo' && (await depois(T.def.id)) === 'codigo');
  await c.query(semTx(R75));
  chk('rollback é idempotente', /'n8n'/.test(await defaultDaColuna()));
  await c.query(semTx(M75));
  chk('reaplicar depois do rollback funciona', /'codigo'/.test(await defaultDaColuna()));
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
