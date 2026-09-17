/**
 * Migração 73 — guarda de colunas em usuarios_painel.
 *
 * Rollback-first, 73 duas vezes. Propriedades, com claims reais de um
 * tenant_admin criado na transação: NÃO muda papel (nem com tenant_id nulo,
 * que satisfaria o CHECK), NÃO muda tenant_id, email, ativo; MUDA o próprio
 * nome; super_admin muda tudo; usuário não edita a linha de OUTRO (a policy,
 * não a guarda). Sabotagem: a guarda sem o `raise`.
 *
 *   npm run teste:migracao-guard-usuarios
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M73 = leia('20260917230000_73_guard_usuarios_painel.sql');
const R73 = leia('20260917230000_73_guard_usuarios_painel_rollback.sql');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 12);

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
const temTrigger = async () => (await um(`select count(*)::int n from pg_trigger where tgname='trg_usuarios_painel_guard_colunas'`)).n === 1;
// roda `sql` como authenticated com claims, num savepoint; devolve {ok, code, rows}
const como = async (claims, sql, p = []) => {
  await c.query('savepoint sp'); await c.query('set local role authenticated');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
  try { const r = await c.query(sql, p); await c.query('rollback to savepoint sp'); return { ok: true, rows: r.rowCount }; }
  catch (e) { await c.query('rollback to savepoint sp'); return { ok: false, code: e.code, msg: e.message }; }
};

try {
  console.log('\n== 0. Rollback primeiro, 73 duas vezes ==\n');
  await c.query(semTx(R73));
  chk('pré-73: sem trigger', !(await temTrigger()));
  await c.query(semTx(M73)); await c.query(semTx(M73));
  chk('a 73 aplica duas vezes; trigger existe', await temTrigger());

  console.log('\n== 1. Arranjo: dois tenants, um tenant_admin em cada, via auth.users ==\n');
  const T = {}; const U = {};
  for (const s of ['a', 'b']) {
    T[s] = (await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-73-${s}`, `Teste 73 ${s}`])).id;
    U[s] = crypto.randomUUID();
    await c.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
                   values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', $3, '{}', now(), now())`,
      [U[s], `z-teste-73-${s}@teste.local`, JSON.stringify({ provider: 'email', providers: ['email'], papel: 'tenant_admin', tenant_id: T[s] })]);
  }
  const linha = await um(`select papel, tenant_id from public.usuarios_painel where id=$1`, [U.a]);
  chk('o trigger do auth criou a projeção em usuarios_painel (tenant_admin de A)', linha?.papel === 'tenant_admin' && linha.tenant_id === T.a, JSON.stringify(linha));
  const ca = { role: 'authenticated', sub: U.a, app_metadata: { papel: 'tenant_admin', tenant_id: T.a } };
  const cs = { role: 'authenticated', sub: crypto.randomUUID(), app_metadata: { papel: 'super_admin' } };

  console.log('\n== 2. O que o tenant_admin NÃO faz na própria linha ==\n');
  for (const [rot, sql] of [
    ['papel=super_admin + tenant_id=null (passa no CHECK, cai na guarda)', `update public.usuarios_painel set papel='super_admin', tenant_id=null where id=$1`],
    ['tenant_id de outro tenant', `update public.usuarios_painel set tenant_id='${T.b}' where id=$1`],
    ['email', `update public.usuarios_painel set email='x@y.z' where id=$1`],
    ['ativo=false', `update public.usuarios_painel set ativo=false where id=$1`],
  ]) {
    const r = await como(ca, sql, [U.a]);
    chk(`${rot} -> 42501`, !r.ok && r.code === '42501', r.ok ? `PASSOU (${r.rows} linhas)` : r.code);
  }

  console.log('\n== 3. O que ele FAZ, e o que a policy já segurava ==\n');
  const rn = await como(ca, `update public.usuarios_painel set nome='Meu Nome' where id=$1`, [U.a]);
  chk('nome próprio -> 1 linha', rn.ok && rn.rows === 1, JSON.stringify(rn));
  const ro = await como(ca, `update public.usuarios_painel set nome='hack' where id=$1`, [U.b]);
  chk('nome de OUTRO usuário -> 0 linhas (policy)', ro.ok && ro.rows === 0, JSON.stringify(ro));
  const rs = await como(cs, `update public.usuarios_painel set papel='tenant_admin', tenant_id='${T.b}', nome='Movido' where id=$1`, [U.a]);
  chk('super_admin move o usuário de tenant e muda nome -> 1 linha', rs.ok && rs.rows === 1, JSON.stringify(rs));

  console.log('\n== 4. SABOTAGEM ==\n');
  {
    await c.query('savepoint sp_s1');
    const alvo = M73.slice(M73.indexOf('    raise exception'), M73.indexOf("using errcode = '42501';") + "using errcode = '42501';".length);
    const mut = M73.replace(alvo, '    null;');
    chk('S1 mutou (md5)', alvo.length > 40 && md5(mut) !== md5(M73));
    await c.query(semTx(mut));
    const r = await como(ca, `update public.usuarios_painel set papel='super_admin', tenant_id=null where id=$1`, [U.a]);
    chk('S1: sem o raise, o tenant_admin volta a virar super_admin na tabela (a §2 pegaria)', r.ok && r.rows === 1, JSON.stringify(r));
    await c.query('rollback to savepoint sp_s1');
  }
} catch (e) {
  falhas.push(`EXCEÇÃO: ${e.message}`); console.log(`  EXCEÇÃO ${e.message}`);
} finally {
  await c.query('rollback'); await c.end();
}
console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
