/**
 * Migração 45 — `api_n8n_times` só devolve time VERIFICADO.
 *
 * Escrita em 19/08 e nunca aplicada: descoberto em 21/09, quando a atribuição
 * a time entrou no serviço e o teste do serviço viu um time sem selo chegar ao
 * prompt. Rollback-first (o rollback recria a função SEM o filtro), 45 duas
 * vezes, ACL por diff (é `create or replace` de mesma assinatura: o ACL tem de
 * ficar idêntico), e a propriedade com tenants criados aqui: sem selo ou com
 * `falhou_em` não sai; com selo sai; o do outro tenant nunca.
 *
 *   npm run teste:migracao-times-verificados
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M45 = leia('20260819150000_45_times_verificados.sql');
const R45 = leia('20260819150000_45_times_verificados_rollback.sql');
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
const tudo = async (sql, p = []) => (await c.query(sql, p)).rows;
const aclFn = async (nome) => (await um(
  `select coalesce(string_agg(coalesce(p.proacl::text,'(NULO)'), ' | ' order by p.oid), '(AUSENTE)') acl
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [nome])).acl;
const nomes = async (t) => (await tudo(`select nome from public.api_n8n_times($1)`, [t])).map((r) => r.nome).sort();

try {
  console.log('\n== 0. Arranjo e rollback primeiro ==\n');
  const T = {};
  for (const s of ['a', 'b']) T[s] = (await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-45-${s}`, `Teste 45 ${s}`])).id;
  await c.query(`insert into public.tenant_times (tenant_id, team_id, nome, descricao, padrao, verificado_em, falhou_em) values
    ($1, 20, 'Selado', 'ok', true, now(), null),
    ($1, 21, 'SemSelo', 'nunca verificado', false, null, null),
    ($1, 22, 'Sumiu', 'verificado e depois falhou', false, now() - interval '1 day', now()),
    ($2, 30, 'DoB', 'selado, de B', true, now(), null)`, [T.a, T.b]);
  const aclAntes = await aclFn('api_n8n_times');
  await c.query(semTx(R45));
  chk('contraprova (pré-45): a função devolve os TRÊS de A, selo ou não', JSON.stringify(await nomes(T.a)) === JSON.stringify(['Selado', 'SemSelo', 'Sumiu']), JSON.stringify(await nomes(T.a)));

  console.log('\n== 1. A 45, duas vezes ==\n');
  await c.query(semTx(M45)); await c.query(semTx(M45));
  chk('só o selado sai: SemSelo (sem verificado_em) e Sumiu (falhou_em) ficam de fora', JSON.stringify(await nomes(T.a)) === JSON.stringify(['Selado']), JSON.stringify(await nomes(T.a)));
  chk('o de B não aparece para A; para B aparece o dele', !(await nomes(T.a)).includes('DoB') && JSON.stringify(await nomes(T.b)) === JSON.stringify(['DoB']));
  chk('ACL idêntico ao de antes (mesma assinatura, revoke+grant explícitos)', (await aclFn('api_n8n_times')) === aclAntes && /n8n_agent=X/.test(aclAntes) && !/anon=/.test(aclAntes), await aclFn('api_n8n_times'));
  await c.query('savepoint agente'); await c.query('set local role n8n_agent');
  let comoAgente = null; try { comoAgente = await nomes(T.a); } catch (e) { comoAgente = e.code; }
  await c.query('rollback to savepoint agente');
  chk('n8n_agent chama de verdade e recebe só o selado', JSON.stringify(comoAgente) === JSON.stringify(['Selado']), JSON.stringify(comoAgente));
  await c.query(`update public.tenant_times set verificado_em = now() where tenant_id = $1 and team_id = 21`, [T.a]);
  chk('verificar depois faz o time entrar (o selo é o contrato, não o nome)', JSON.stringify(await nomes(T.a)) === JSON.stringify(['Selado', 'SemSelo']));
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
