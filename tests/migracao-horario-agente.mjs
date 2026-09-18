/**
 * Migração 74 — horário de atendimento do agente.
 *
 * Rollback-first, 74 duas vezes. `horario_agente` é do CLIENTE (tenant_admin
 * grava; as colunas da agência continuam 42501); o CHECK recusa não-objeto;
 * `api_agente_horario` devolve o jsonb; o claim do aviso é um por janela;
 * ACL das funções novas igual ao das irmãs; guard com ACL igual ao de antes.
 * Sabotagem: tirar `horario_agente` da whitelist.
 *
 *   npm run teste:migracao-horario-agente
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M74 = leia('20260918120000_74_horario_do_agente.sql');
const R74 = leia('20260918120000_74_horario_do_agente_rollback.sql');
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
const aclFn = async (nome) => (await um(
  `select coalesce(string_agg(coalesce(p.proacl::text,'(NULO)'), ' | ' order by p.oid), '(AUSENTE)') acl
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [nome])).acl;
const temCol = async (tab, col) => (await um(`select count(*)::int n from information_schema.columns where table_name=$1 and column_name=$2`, [tab, col])).n === 1;
const como = async (claims, sql, p = []) => {
  await c.query('savepoint sp'); await c.query('set local role authenticated');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
  // sucesso: mantém a escrita (release) mas DEVOLVE o role e limpa as claims —
  // `set local role` sobrevive ao release, e o resto do teste roda como postgres
  try { const r = await c.query(sql, p); await c.query('release savepoint sp'); await c.query('reset role'); await c.query(`select set_config('request.jwt.claims', '', true)`); return { ok: true, rows: r.rowCount }; }
  catch (e) { await c.query('rollback to savepoint sp'); return { ok: false, code: e.code }; }
};

try {
  console.log('\n== 0. Rollback primeiro, 74 duas vezes, ACL ==\n');
  await c.query(semTx(R74));
  const aclGuardAntes = await aclFn('tenants_guard_colunas');
  chk('pré-74: sem colunas e sem funções', !(await temCol('tenants', 'horario_agente')) && !(await temCol('conversas', 'aviso_fora_horario_em')) && (await aclFn('api_agente_horario')) === '(AUSENTE)');
  await c.query(semTx(M74)); await c.query(semTx(M74));
  chk('a 74 aplica duas vezes; colunas e funções existem', (await temCol('tenants', 'horario_agente')) && (await temCol('conversas', 'aviso_fora_horario_em')) && (await aclFn('api_agente_horario')) !== '(AUSENTE)');
  chk('guard: ACL igual ao de antes (create or replace)', (await aclFn('tenants_guard_colunas')) === aclGuardAntes);
  const irma = await aclFn('api_agente_config');
  chk('api_agente_horario / aviso_fora_horario: ACL == irmã api_agente_config', (await aclFn('api_agente_horario')) === irma && (await aclFn('api_agente_aviso_fora_horario')) === irma, await aclFn('api_agente_horario'));
  chk('aplicar NÃO configura horário para ninguém (todos NULL)', (await um(`select count(*)::int n from public.tenants where horario_agente is not null`)).n === 0);

  console.log('\n== 1. Do cliente: tenant_admin grava; agência continua protegida ==\n');
  const T = {};
  for (const s of ['a', 'b']) T[s] = (await um(`insert into public.tenants (slug, nome, agente_runtime) values ($1, $2, 'codigo') returning id`, [`z-teste-74-${s}`, `Teste 74 ${s}`])).id;
  const ca = { role: 'authenticated', sub: crypto.randomUUID(), app_metadata: { papel: 'tenant_admin', tenant_id: T.a } };
  const H = { timezone: 'America/Porto_Velho', dias_semana: [2, 3, 4, 5, 6], hora_inicio: 8, hora_fim: 18, fechados: ['2026-12-25'], fora_horario: 'aviso' };
  const r1 = await como(ca, `update public.tenants set horario_agente = $2 where id = $1`, [T.a, JSON.stringify(H)]);
  chk('tenant_admin grava horario_agente no próprio tenant -> 1 linha', r1.ok && r1.rows === 1, JSON.stringify(r1));
  const r2 = await como(ca, `update public.tenants set horario_agente = $2 where id = $1`, [T.b, JSON.stringify(H)]);
  chk('…e no tenant B afeta 0 linhas (RLS)', r2.ok && r2.rows === 0);
  const r3 = await como(ca, `update public.tenants set agente_runtime = 'n8n' where id = $1`, [T.a]);
  chk('agente_runtime continua da agência -> 42501', !r3.ok && r3.code === '42501', JSON.stringify(r3));
  const r4 = await como(ca, `update public.tenants set horario_agente = null where id = $1`, [T.a]);
  chk('tenant_admin desliga (NULL) -> 1 linha', r4.ok && r4.rows === 1);
  const r5 = await como(ca, `update public.tenants set horario_agente = '"texto"'::jsonb where id = $1`, [T.a]);
  chk('CHECK: jsonb que não é objeto -> 23514', !r5.ok && r5.code === '23514', JSON.stringify(r5));
  await c.query(`update public.tenants set horario_agente = $2 where id = $1`, [T.a, JSON.stringify(H)]);
  const h = (await um(`select public.api_agente_horario($1) h`, [T.a])).h;
  chk('api_agente_horario devolve o jsonb gravado; para B (sem horário) devolve NULL', h?.fora_horario === 'aviso' && h.fechados[0] === '2026-12-25' && (await um(`select public.api_agente_horario($1) h`, [T.b])).h === null);

  console.log('\n== 2. O claim do aviso: um por janela ==\n');
  await c.query(`insert into public.conversas (tenant_id, conversation_id, contact_name, phone) values ($1, 900, 'X', '55'), ($2, 900, 'Y', '56')`, [T.a, T.b]);
  chk('1ª chamada: TRUE (avisa) e grava aviso_fora_horario_em', (await um(`select public.api_agente_aviso_fora_horario($1, 900) r`, [T.a])).r === true
    && (await um(`select aviso_fora_horario_em a from public.conversas where tenant_id=$1 and conversation_id=900`, [T.a])).a !== null);
  chk('2ª chamada no mesmo período: FALSE', (await um(`select public.api_agente_aviso_fora_horario($1, 900) r`, [T.a])).r === false);
  chk('a MESMA conversation_id em B é outra conversa: TRUE (isolamento)', (await um(`select public.api_agente_aviso_fora_horario($1, 900) r`, [T.b])).r === true);
  await c.query(`update public.conversas set aviso_fora_horario_em = now() - interval '13 hours' where tenant_id=$1 and conversation_id=900`, [T.a]);
  chk('13 h depois (janela 12): TRUE de novo', (await um(`select public.api_agente_aviso_fora_horario($1, 900, 12) r`, [T.a])).r === true);
  chk('conversa inexistente: FALSE (não inventa linha)', (await um(`select public.api_agente_aviso_fora_horario($1, 901) r`, [T.a])).r === false);
  {
    await c.query('savepoint sp_role'); await c.query('set local role n8n_agent');
    let err = null;
    try { await um(`select public.api_agente_horario($1)`, [T.a]); await um(`select public.api_agente_aviso_fora_horario($1, 900)`, [T.a]); } catch (e) { err = e; }
    await c.query('rollback to savepoint sp_role');
    chk('n8n_agent chama as duas de verdade', err === null, err?.message);
  }

  console.log('\n== 3. SABOTAGEM ==\n');
  {
    await c.query('savepoint sp_s1');
    const mut = M74.split('msg_fora_escopo,horario_agente,atualizado_em').join('msg_fora_escopo,atualizado_em');
    chk('S1 mutou (md5)', md5(mut) !== md5(M74));
    await c.query(semTx(mut));
    const r = await como(ca, `update public.tenants set horario_agente = null where id = $1`, [T.a]);
    chk('S1: sem horario_agente na whitelist, o tenant_admin leva 42501 (a §1 pegaria)', !r.ok && r.code === '42501', JSON.stringify(r));
    await c.query('rollback to savepoint sp_s1');
  }
} catch (e) {
  falhas.push(`EXCEÇÃO: ${e.message}`); console.log(`  EXCEÇÃO ${e.message}`);
} finally {
  await c.query('rollback'); await c.end();
}
console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
