/**
 * Migração 65 — `resolvido` passa a existir: o sync reabre conversa resolvida.
 *
 * Rollback-first, 65 duas vezes, ACL por diff (mesma assinatura: nada pode
 * mudar), e o comportamento com três tenants: resolvida + mensagem nova ->
 * ativa; ativa fica ativa; pausada fica pausada (a pausa é do `pausa_vigente`,
 * não daqui). Sabotagem: sem a linha do status, a resolvida NÃO reabre.
 *
 *   npm run teste:migracao-conversa-resolvida
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M65 = leia('20260916210000_65_conversa_resolvida_reabre.sql');
const R65 = leia('20260916210000_65_conversa_resolvida_reabre_rollback.sql');
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

try {
  console.log('\n== 0. Rollback primeiro, 65 duas vezes, ACL por diff ==\n');
  const aclAntes = await aclFn('api_n8n_conversa_sync');
  await c.query(semTx(R65));
  chk('pós-rollback: o corpo NÃO reabre (não contém a linha do status)', !/c\.status = 'resolvido' then 'ativo'/.test((await um(`select pg_get_functiondef('public.api_n8n_conversa_sync'::regproc) d`)).d));
  await c.query(semTx(M65)); await c.query(semTx(M65));
  chk('a 65 aplica duas vezes; o corpo reabre', /c\.status = 'resolvido' then 'ativo'/.test((await um(`select pg_get_functiondef('public.api_n8n_conversa_sync'::regproc) d`)).d));
  chk('ACL idêntico ao de antes (mesma assinatura, sem drop)', (await aclFn('api_n8n_conversa_sync')) === aclAntes && /n8n_agent=X/.test(aclAntes), await aclFn('api_n8n_conversa_sync'));

  console.log('\n== 1. Três tenants, três estados ==\n');
  const T = {};
  for (const s of ['a', 'b', 'c']) T[s] = (await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-65-${s}`, `Teste 65 ${s}`])).id;
  await c.query(`insert into public.conversas (tenant_id, conversation_id, status) values ($1, 65, 'resolvido'), ($2, 65, 'ativo')`, [T.a, T.b]);
  // pausa com motivo E carimbo no mesmo insert (CHECK conversas_pausa_tem_motivo)
  await c.query(`insert into public.conversas (tenant_id, conversation_id, status, pausado_em, motivo_pausa) values ($1, 65, 'pausado', now(), 'manual')`, [T.c]);
  chk('arranjo: A resolvida, B ativa, C pausada (contraprova do que vem abaixo)',
    (await um(`select string_agg(status, ',' order by tenant_id::text) s from public.conversas where conversation_id=65 and tenant_id = any($1::uuid[])`, [[T.a, T.b, T.c]])).s.split(',').sort().join(',') === 'ativo,pausado,resolvido');
  const ra = await um(`select * from public.api_n8n_conversa_sync($1, 65, 'Fulano', null)`, [T.a]);
  chk('A: sync em conversa RESOLVIDA -> status ativo no banco e no retorno', ra.status === 'ativo' && (await um(`select status from public.conversas where tenant_id=$1 and conversation_id=65`, [T.a])).status === 'ativo', JSON.stringify(ra));
  const rb = await um(`select * from public.api_n8n_conversa_sync($1, 65)`, [T.b]);
  chk('B: ativa continua ativa', rb.status === 'ativo');
  const rc = await um(`select * from public.api_n8n_conversa_sync($1, 65)`, [T.c]);
  chk('C: pausada continua pausada (a pausa não é daqui)', rc.status === 'pausado' && (await um(`select status from public.conversas where tenant_id=$1 and conversation_id=65`, [T.c])).status === 'pausado', JSON.stringify(rc));
  chk('e o sync de A NÃO tocou em B nem em C (isolamento por tenant)', (await um(`select count(*)::int n from public.conversas where conversation_id=65 and tenant_id = any($1::uuid[]) and status <> 'ativo'`, [[T.b, T.c]])).n === 1);
  chk('definir_status_conversa aceita resolvido (o que a tool chama)', (await um(`select public.api_n8n_definir_status_conversa($1, 65, 'resolvido') r`, [T.b])).r === 'resolvido');

  console.log('\n== 2. SABOTAGEM ==\n');
  {
    await c.query('savepoint sp');
    const mut = M65.replace("status        = case when c.status = 'resolvido' then 'ativo' else c.status end,\n", '');
    chk('a mutação entrou (md5 muda)', md5(mut) !== md5(M65));
    await c.query(semTx(mut));
    await c.query(`update public.conversas set status='resolvido' where tenant_id=$1 and conversation_id=65`, [T.a]);
    const r = await um(`select * from public.api_n8n_conversa_sync($1, 65)`, [T.a]);
    chk('sem a linha, a resolvida NÃO reabre (a asserção 1 pegaria)', r.status === 'resolvido', r.status);
    await c.query('rollback to savepoint sp');
  }
} catch (e) {
  falhas.push(`EXCEÇÃO: ${e.message}`); console.log(`  EXCEÇÃO ${e.message}`);
} finally {
  await c.query('rollback'); await c.end();
}
console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
