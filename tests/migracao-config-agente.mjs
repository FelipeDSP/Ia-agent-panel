/**
 * Migração 66 — `memoria_silencio_minutos` e `pagamento_formas` por tenant.
 *
 * Rollback-first, 66 duas vezes; as colunas nascem AGÊNCIA-ONLY (fora da lista
 * branca do guard: tenant_admin leva 42501, super_admin passa); CHECKs
 * recusam o que não vale; `api_agente_config` devolve o que o serviço lê, com
 * ACL igual ao da irmã e chamável por n8n_agent. Três tenants. Sabotagens:
 * grant do n8n_agent; CHECK das formas.
 *
 *   npm run teste:migracao-config-agente
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M66 = leia('20260916220000_66_config_agente_por_tenant.sql');
const R66 = leia('20260916220000_66_config_agente_por_tenant_rollback.sql');
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
const esperaErro = async (fn) => {
  await c.query('savepoint sp_erro');
  try { await fn(); await c.query('release savepoint sp_erro'); return null; }
  catch (e) { await c.query('rollback to savepoint sp_erro'); return e; }
};
const aclFn = async (nome) => (await um(
  `select coalesce(string_agg(coalesce(p.proacl::text,'(NULO)'), ' | ' order by p.oid), '(AUSENTE)') acl
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [nome])).acl;
const temCol = async (col) => (await um(`select count(*)::int n from information_schema.columns where table_name='tenants' and column_name=$1`, [col])).n === 1;

try {
  console.log('\n== 0. Rollback primeiro, 66 duas vezes ==\n');
  await c.query(semTx(R66));
  chk('pré-66: sem colunas e sem função', !(await temCol('memoria_silencio_minutos')) && !(await temCol('pagamento_formas')) && (await aclFn('api_agente_config')) === '(AUSENTE)');
  await c.query(semTx(M66)); await c.query(semTx(M66));
  chk('a 66 aplica duas vezes; colunas e função existem', (await temCol('memoria_silencio_minutos')) && (await temCol('pagamento_formas')) && (await aclFn('api_agente_config')) !== '(AUSENTE)');
  chk('aplicar NÃO muda ninguém: todo tenant fica em 40 min e {PIX}', (await um(`select count(*)::int n from public.tenants where memoria_silencio_minutos <> 40 or pagamento_formas <> '{PIX}'`)).n === 0);

  console.log('\n== 1. Agência-only ==\n');
  const guard = (await um(`select pg_get_functiondef('public.tenants_guard_colunas'::regproc) d`)).d;
  chk('as duas colunas NÃO estão na lista branca do guard', !/memoria_silencio_minutos|pagamento_formas/.test(guard));
  const T = {};
  for (const s of ['a', 'b', 'c']) T[s] = (await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-66-${s}`, `Teste 66 ${s}`])).id;
  const e1 = await esperaErro(() => c.query(`update public.tenants set memoria_silencio_minutos = 120 where id=$1`, [T.a]));
  chk('sem claim (tenant_admin): update -> 42501', e1?.code === '42501', e1?.code ?? '(passou!)');
  await c.query('savepoint sp_super');
  await c.query(`select set_config('request.jwt.claims', '{"app_metadata":{"papel":"super_admin"}}', true)`);
  await c.query(`update public.tenants set memoria_silencio_minutos = 120, pagamento_formas = '{PIX,CREDIT_CARD}' where id=$1`, [T.a]);
  const cfgA = await um(`select * from public.api_agente_config($1)`, [T.a]);
  chk('super_admin grava; api_agente_config devolve 120 / {PIX,CREDIT_CARD} / janela 20', cfgA.memoria_silencio_minutos === 120 && cfgA.pagamento_formas.join(',') === 'PIX,CREDIT_CARD' && cfgA.memoria_janela_pares === 20, JSON.stringify(cfgA));
  const cfgB = await um(`select * from public.api_agente_config($1)`, [T.b]);
  chk('B (não tocado) continua 40 / {PIX} — isolamento', cfgB.memoria_silencio_minutos === 40 && cfgB.pagamento_formas.join(',') === 'PIX');
  const e2 = await esperaErro(() => c.query(`update public.tenants set memoria_silencio_minutos = 0 where id=$1`, [T.c]));
  const e3 = await esperaErro(() => c.query(`update public.tenants set pagamento_formas = '{PIX,DINHEIRO}' where id=$1`, [T.c]));
  const e4 = await esperaErro(() => c.query(`update public.tenants set pagamento_formas = '{}' where id=$1`, [T.c]));
  chk('CHECKs: 0 min, forma desconhecida e lista vazia -> 23514', e2?.code === '23514' && e3?.code === '23514' && e4?.code === '23514', [e2?.code, e3?.code, e4?.code].join(','));
  await c.query('rollback to savepoint sp_super');

  console.log('\n== 2. ACL e n8n_agent ==\n');
  const irma = await aclFn('api_agente_runtime');
  chk('api_agente_config: ACL == irmã (api_agente_runtime)', (await aclFn('api_agente_config')) === irma, await aclFn('api_agente_config'));
  {
    await c.query('savepoint sp_role'); await c.query('set local role n8n_agent');
    let err = null; let r = null;
    try { r = await um(`select * from public.api_agente_config($1)`, [T.b]); } catch (e) { err = e; }
    await c.query('rollback to savepoint sp_role');
    chk('n8n_agent chama de verdade e recebe 40 / {PIX}', err === null && r?.memoria_silencio_minutos === 40, err?.message);
  }

  console.log('\n== 3. SABOTAGEM ==\n');
  {
    await c.query('savepoint sp_s1');
    const mut = M66.replace("execute format('grant execute on function %s to n8n_agent', f);", '-- SABOTAGEM');
    chk('S1 mutou (md5)', md5(mut) !== md5(M66));
    await c.query(semTx(mut));
    chk('S1: sem o grant, ACL diverge da irmã', (await aclFn('api_agente_config')) !== irma);
    await c.query('rollback to savepoint sp_s1');
    await c.query('savepoint sp_s2');
    const mut2 = M66.replace("check (cardinality(pagamento_formas) >= 1 and pagamento_formas <@ array['PIX','CREDIT_CARD','BOLETO']::text[]);", 'check (true);');
    chk('S2 mutou (md5)', md5(mut2) !== md5(M66));
    await c.query(semTx(mut2));
    await c.query(`select set_config('request.jwt.claims', '{"app_metadata":{"papel":"super_admin"}}', true)`);
    const e5 = await esperaErro(() => c.query(`update public.tenants set pagamento_formas = '{DINHEIRO}' where id=$1`, [T.c]));
    chk('S2: sem o CHECK, forma desconhecida ENTRA (a asserção 1 pegaria)', e5 === null);
    await c.query('rollback to savepoint sp_s2');
  }
} catch (e) {
  falhas.push(`EXCEÇÃO: ${e.message}`); console.log(`  EXCEÇÃO ${e.message}`);
} finally {
  await c.query('rollback'); await c.end();
}
console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
