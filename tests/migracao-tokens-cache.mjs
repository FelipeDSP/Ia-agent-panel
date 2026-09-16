/**
 * Migração 68 — tokens em cache: a aba de consumo passa a cobrar a parte
 * cacheada pela metade, e a fonte (real × estimada) fica visível.
 *
 * Rollback-first, 68 duas vezes; ACL das DUAS funções por diff (registrar:
 * mesma assinatura; billing: drop + create, o bloco de grants tem de
 * restaurar `authenticated` + `service_role` e NADA mais); o custo calculado
 * pela RPC bate com a conta feita à mão; sem preço de cache, cache é cobrado
 * como entrada normal; `entrada_cache` chega pelo jsonb de
 * `api_n8n_registrar_mensagem`. Três tenants. Sabotagens: formula sem o
 * desconto; grants do billing esquecidos.
 *
 *   npm run teste:migracao-tokens-cache
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M68 = leia('20260916235000_68_tokens_em_cache.sql');
const R68 = leia('20260916235000_68_tokens_em_cache_rollback.sql');
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
const tudo = async (sql, p = []) => (await c.query(sql, p)).rows;
const aclFn = async (nome) => (await um(
  `select coalesce(string_agg(coalesce(p.proacl::text,'(NULO)'), ' | ' order by p.oid), '(AUSENTE)') acl
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [nome])).acl;
const temCol = async (t, col) => (await um(`select count(*)::int n from information_schema.columns where table_name=$1 and column_name=$2`, [t, col])).n === 1;

try {
  console.log('\n== 0. Rollback primeiro, 68 duas vezes, ACL por diff ==\n');
  const aclRegistrarAntes = await aclFn('api_n8n_registrar_mensagem');
  const aclBillingAntes = await aclFn('billing_consumo_mensal');
  await c.query(semTx(R68));
  chk('pré-68: sem as colunas', !(await temCol('mensagens_log', 'tokens_entrada_cache')) && !(await temCol('precos_modelo', 'usd_entrada_cache_por_1m')));
  await c.query(semTx(M68)); await c.query(semTx(M68));
  chk('a 68 aplica duas vezes; colunas existem; preço de cache do 4.1-mini = 0,10', (await temCol('mensagens_log', 'tokens_entrada_cache')) && Number((await um(`select usd_entrada_cache_por_1m p from public.precos_modelo where modelo='gpt-4.1-mini' order by vigente_desde desc limit 1`)).p) === 0.1);
  chk('registrar_mensagem: ACL idêntico (mesma assinatura)', (await aclFn('api_n8n_registrar_mensagem')) === aclRegistrarAntes, await aclFn('api_n8n_registrar_mensagem'));
  chk('billing_consumo_mensal: ACL idêntico depois do drop+create (authenticated + service_role, nada mais)', (await aclFn('billing_consumo_mensal')) === aclBillingAntes && /authenticated=X/.test(aclBillingAntes) && !/anon=/.test(aclBillingAntes), await aclFn('billing_consumo_mensal'));

  console.log('\n== 1. Três tenants: o custo com cache bate com a conta à mão ==\n');
  const T = {};
  for (const s of ['a', 'b', 'c']) T[s] = (await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-68-${s}`, `Teste 68 ${s}`])).id;
  // A: real, com cache (via registrar_mensagem, como o serviço faz)
  await c.query(`select public.api_n8n_registrar_mensagem($1, 1, 'saida', 'x', 5000, 100, 'gpt-4.1-mini', null, 't1', $2::jsonb)`, [T.a, JSON.stringify({ fonte: 'openai_usage', chamadas: 1, entrada_cache: 4000 })]);
  // B: estimativa do n8n (sem cache)
  await c.query(`select public.api_n8n_registrar_mensagem($1, 1, 'saida', 'x', 5000, 100, 'gpt-4.1-mini', null, '123', $2::jsonb)`, [T.b, JSON.stringify({ fonte: 'estimativa_nossa_com_multiplicidade', chamadas: 1 })]);
  // C: modelo sem preço de cache cadastrado -> cache cobrado como entrada normal
  await c.query(`insert into public.precos_modelo (modelo, vigente_desde, usd_entrada_por_1m, usd_saida_por_1m) values ('modelo-teste-68', '2025-01-01', 1.0, 2.0)`);
  await c.query(`select public.api_n8n_registrar_mensagem($1, 1, 'saida', 'x', 1000, 0, 'modelo-teste-68', null, 't3', $2::jsonb)`, [T.c, JSON.stringify({ fonte: 'openai_usage', chamadas: 1, entrada_cache: 1000 })]);
  chk('registrar gravou tokens_entrada_cache = 4000 para A (chave `entrada_cache` do jsonb)', (await um(`select tokens_entrada_cache c from public.mensagens_log where tenant_id=$1`, [T.a])).c === 4000);
  chk('e NULO para B (estimativa não sabe de cache)', (await um(`select tokens_entrada_cache c from public.mensagens_log where tenant_id=$1`, [T.b])).c === null);

  await c.query(`select set_config('request.jwt.claims', '{"app_metadata":{"papel":"super_admin"}}', true)`);
  const linhas = await tudo(`select * from public.billing_consumo_mensal() where tenant_id = any($1::uuid[])`, [[T.a, T.b, T.c]]);
  const la = linhas.find((l) => l.tenant_id === T.a); const lb = linhas.find((l) => l.tenant_id === T.b); const lc = linhas.find((l) => l.tenant_id === T.c);
  // A: (5000-4000)/1e6*0.40 + 4000/1e6*0.10 + 100/1e6*1.60 = 0.0004 + 0.0004 + 0.00016 = 0.00096
  chk('A (real, 4000 em cache): custo 0,0010 (arredondado de 0,00096), cache 4000, 1 real / 0 estimadas', la && Number(la.custo_usd) === 0.001 && Number(la.tokens_entrada_cache) === 4000 && Number(la.mensagens_reais) === 1 && Number(la.mensagens_estimadas) === 0, JSON.stringify(la));
  // B: 5000/1e6*0.40 + 100/1e6*1.60 = 0.002 + 0.00016 = 0.00216
  chk('B (estimativa, sem cache): custo 0,0022 (preço cheio), 0 reais / 1 estimada', lb && Number(lb.custo_usd) === 0.0022 && Number(lb.tokens_entrada_cache) === 0 && Number(lb.mensagens_estimadas) === 1, JSON.stringify(lb));
  // C: sem preço de cache -> 1000/1e6*1.0 = 0.001
  chk('C (modelo sem preço de cache): cache cobrado como entrada normal, 0,0010', lc && Number(lc.custo_usd) === 0.001, JSON.stringify(lc));
  chk('contraprova: A e B têm os MESMOS tokens e custos DIFERENTES — o cache é o único motivo', Number(la.tokens_entrada) === Number(lb.tokens_entrada) && Number(la.custo_usd) < Number(lb.custo_usd));

  console.log('\n== 2. SABOTAGEM ==\n');
  {
    await c.query('savepoint sp_s1');
    const mut = M68.replace("sum((c.te - c.tc) / 1e6 * coalesce(c.pe, 0) + c.tc / 1e6 * coalesce(c.pc, 0) + c.ts / 1e6 * coalesce(c.ps, 0)) as custo", "sum(c.te / 1e6 * coalesce(c.pe, 0) + c.ts / 1e6 * coalesce(c.ps, 0)) as custo");
    chk('S1 mutou (md5)', md5(mut) !== md5(M68));
    await c.query(semTx(mut));
    const l2 = await um(`select custo_usd from public.billing_consumo_mensal() where tenant_id=$1`, [T.a]);
    chk('S1: sem o desconto, A custa como B (a asserção 1 pegaria)', Number(l2.custo_usd) === 0.0022, String(l2.custo_usd));
    await c.query('rollback to savepoint sp_s1');
    await c.query('savepoint sp_s2');
    // Tirar o GRANT não muda nada: as default privileges deste projeto já dão EXECUTE a
    // PUBLIC/anon/authenticated no `create` (a nota das 40/41 no CLAUDE.md, medida na 54).
    // O que segura é o REVOKE — então a sabotagem que a asserção 0 tem de pegar é essa.
    const mut2 = M68.replace("    execute format('revoke all on function %s from public', f);\n    execute format('revoke all on function %s from anon', f);", '-- SABOTAGEM');
    chk('S2 mutou (md5)', md5(mut2) !== md5(M68));
    await c.query(semTx(mut2));
    const aclS2 = await aclFn('billing_consumo_mensal');
    chk('S2: sem os REVOKEs depois do drop, a função nasce aberta a PUBLIC/anon e o ACL diverge (a asserção 0 pegaria)', aclS2 !== aclBillingAntes && /anon=X/.test(aclS2), aclS2);
    await c.query('rollback to savepoint sp_s2');
  }
} catch (e) {
  falhas.push(`EXCEÇÃO: ${e.message}`); console.log(`  EXCEÇÃO ${e.message}`);
} finally {
  await c.query('rollback'); await c.end();
}
console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
