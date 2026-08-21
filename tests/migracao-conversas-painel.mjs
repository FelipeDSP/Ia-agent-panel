#!/usr/bin/env node
/**
 * Migração 51 (view `conversas_painel`) numa TRANSAÇÃO ABORTADA contra
 * produção. Nada é gravado: o rollback no fim é incondicional.
 *
 * O QUE ELE PROVA, e ler o SQL não prova:
 *
 *   - ISOLAMENTO, que é a razão de o teste existir. Três tenants efêmeros, cada
 *     um com conversa própria, e cada um lendo a view sob as PRÓPRIAS claims:
 *     nenhum alcança a linha do outro. Não é "A não vê B" por vacuidade — os
 *     três são semeados e a presença do dado é conferida antes;
 *   - que a view resolve a LÁPIDE: conversa com `status_bruto = 'pausado'` e
 *     pausa vencida aparece como `status_efetivo = 'ativo'`;
 *   - que a pausa MANUAL não caduca por mais velha que seja, e que
 *     `pausa_expira_em` é NULO nela — não há volta programada a mostrar;
 *   - que a view NÃO tem coluna `status`: quem tentar lê-la estoura em vez de
 *     receber a resposta errada. É a escolha de nome, testada;
 *   - que `anon` não alcança a view.
 *
 * A SABOTAGEM (seção 6) tira o `security_invoker` e exige que o teste FIQUE
 * VERMELHO. Se ela não derrubar, este arquivo não está medindo isolamento —
 * está medindo que uma consulta roda.
 *
 * Uso: npm run teste:conversas-painel
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DIR = RAIZ + 'supabase/migrations/';
function acharMigracao(sufixo) {
  const a = fs.readdirSync(DIR).filter((f) => f.endsWith(sufixo));
  if (a.length !== 1) throw new Error(`esperava 1 arquivo em "${sufixo}", achei ${a.length}`);
  return fs.readFileSync(DIR + a[0], 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
}
const M51 = acharMigracao('_51_conversas_painel.sql');
const R51 = acharMigracao('_51_conversas_painel_rollback.sql');

if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

let ok = 0, okSus = 0;
const falhas = [];
const chk = (n, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${n}`); }
  else { falhas.push(`${n}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${n}${det ? ' — ' + det : ''}`); }
};
const sus = (n, cond, det = '') => {
  if (cond) { okSus++; console.log(`  OK  ~ ${n}`); }
  else { falhas.push(`[sustentação] ${n}${det ? ' — ' + det : ''}`); console.log(`  FALHA ~ ${n}${det ? ' — ' + det : ''}`); }
};

async function tentar(sql, p = []) {
  await c.query('savepoint sp');
  try { const r = await c.query(sql, p); await c.query('release savepoint sp'); return { erro: null, rows: r.rows }; }
  catch (e) { await c.query('rollback to savepoint sp'); return { erro: e.message, codigo: e.code, rows: [] }; }
}

/**
 * Lê a view COMO `authenticated`, com as claims daquele tenant. É o caminho
 * exato do painel: PostgREST autentica e a RLS decide. Rodar como `postgres`
 * passaria por cima de tudo e o teste diria verde sem medir nada — `postgres`
 * tem BYPASSRLS (medido antes de escrever esta migração).
 */
async function comoTenant(tenantId, sql, params = []) {
  const claims = JSON.stringify({ role: 'authenticated', app_metadata: { tenant_id: tenantId, papel: 'tenant_admin' } });
  await c.query('savepoint st');
  try {
    await c.query('set local role authenticated');
    await c.query(`set local request.jwt.claims = '${claims}'`);
    const r = await c.query(sql, params);
    await c.query('reset role'); await c.query('reset request.jwt.claims');
    await c.query('release savepoint st');
    return { erro: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint st');
    await c.query('reset role'); await c.query('reset request.jwt.claims');
    return { erro: e.message, codigo: e.code, rows: [] };
  }
}

const CLAIM_SUPER = `'{"app_metadata":{"papel":"super_admin"}}'`;
async function comoSuper(sql, p = []) {
  await c.query(`set local request.jwt.claims = ${CLAIM_SUPER}`);
  try { return await c.query(sql, p); } finally { await c.query('reset request.jwt.claims'); }
}

const existeView = async () => (await c.query(
  `select count(*)::int n from pg_class cl join pg_namespace n on n.oid=cl.relnamespace
    where n.nspname='public' and cl.relname='conversas_painel' and cl.relkind='v'`)).rows[0].n;

await c.connect();
const viewAntesDeTudo = await existeView();
await c.query('begin');

try {
  console.log('\n== Migração 51: view conversas_painel ==\n');
  console.log('-- 1. Arranja o estado de ANTES --\n');

  await c.query(R51);
  sus('o rollback deixou o banco no estado pré-51 (view ausente)', (await existeView()) === 0);

  // Três tenants, não um: um esconde todo bug de isolamento, dois escondem
  // vazamento unidirecional.
  const sufixo = Math.random().toString(16).slice(2, 10);
  const T = [];
  for (let i = 0; i < 3; i++) {
    T.push((await c.query(`insert into public.tenants (slug, nome, ativo) values ($1,$2,true) returning id`,
      [`zz-efem-painel51-${sufixo}-${i}`, `efêmero painel 51 ${sufixo} #${i}`])).rows[0].id);
  }
  const [A, B, C] = T;

  // ARRANJO: cada tenant com conversas em estados diferentes, e o MESMO
  // conversation_id em A e B — `conversation_id` não é único entre clientes.
  const CONV = 9_510_000 + Math.floor(Math.random() * 1000);
  const inserir = (t, conv, status, min, motivo) => c.query(
    `insert into public.conversas (tenant_id, conversation_id, contact_name, status, pausado_em, motivo_pausa)
     values ($1,$2,$3,$4, case when $5::int is null then null else now() - make_interval(mins => $5::int) end, $6)`,
    [t, conv, `contato de ${t.slice(0, 8)}`, status, min, motivo]);

  await inserir(A, CONV, 'pausado', 90, 'mensagem_humana');   // vencida -> lápide
  await inserir(A, CONV + 1, 'pausado', 10, 'mensagem_humana'); // vigente
  await inserir(A, CONV + 2, 'pausado', 7200, 'manual');        // manual, não caduca
  await inserir(A, CONV + 3, 'ativo', null, null);
  await inserir(B, CONV, 'pausado', 10, 'mensagem_humana');     // MESMO id de A
  await inserir(C, CONV + 9, 'ativo', null, null);

  for (const [nome, t, n] of [['A', A, 4], ['B', B, 1], ['C', C, 1]]) {
    const q = (await c.query(`select count(*)::int n from public.conversas where tenant_id=$1`, [t])).rows[0].n;
    sus(`tenant ${nome} tem as ${n} conversa(s) semeadas (anti-vacuidade)`, q === n, `${q}`);
  }

  console.log('\n-- 2. Aplica a migração --\n');
  const ap = await tentar(M51);
  chk('a migração aplica', ap.erro === null, ap.erro ?? '');
  chk('a view existe', (await existeView()) === 1);
  chk('a view tem `security_invoker = true`',
    (await c.query(`select reloptions from pg_class where relname='conversas_painel'`)).rows[0].reloptions
      ?.includes('security_invoker=true') === true,
    JSON.stringify((await c.query(`select reloptions from pg_class where relname='conversas_painel'`)).rows[0].reloptions));

  const cols = (await c.query(`select column_name from information_schema.columns
     where table_schema='public' and table_name='conversas_painel' order by ordinal_position`)).rows.map((r) => r.column_name);
  chk('a view NÃO expõe uma coluna chamada `status` (ler o errado estoura)',
    !cols.includes('status'), cols.join(','));
  chk('e expõe `status_bruto`, `status_efetivo`, `pausa_vigente`, `pausa_expira_em`',
    ['status_bruto', 'status_efetivo', 'pausa_vigente', 'pausa_expira_em'].every((x) => cols.includes(x)), cols.join(','));

  console.log('\n-- 3. ISOLAMENTO: cada tenant sob as próprias claims --\n');

  for (const [nome, t, esperado] of [['A', A, 4], ['B', B, 1], ['C', C, 1]]) {
    const r = await comoTenant(t, `select count(*)::int n, count(distinct tenant_id)::int d from public.conversas_painel`);
    chk(`tenant ${nome} vê ${esperado} linha(s) e 1 tenant só`,
      r.erro === null && r.rows[0]?.n === esperado && r.rows[0]?.d === 1,
      r.erro ?? `n=${r.rows[0]?.n} tenants=${r.rows[0]?.d}`);
  }

  // A asserção negativa, com contraprova: B TEM dado, e A não o alcança.
  const aVeB = await comoTenant(A, `select count(*)::int n from public.conversas_painel where tenant_id=$1`, [B]);
  chk('A não alcança NENHUMA linha de B (e B tem dado — conferido acima)',
    aVeB.erro === null && aVeB.rows[0]?.n === 0, aVeB.erro ?? `viu ${aVeB.rows[0]?.n}`);
  const bVeA = await comoTenant(B, `select count(*)::int n from public.conversas_painel where tenant_id=$1`, [A]);
  chk('e B não alcança nenhuma de A (vazamento unidirecional também é vazamento)',
    bVeA.erro === null && bVeA.rows[0]?.n === 0, bVeA.erro ?? `viu ${bVeA.rows[0]?.n}`);

  // Colisão de conversation_id entre tenants.
  const colisao = await comoTenant(A, `select count(*)::int n from public.conversas_painel where conversation_id=$1`, [CONV]);
  chk('mesmo `conversation_id` em A e B: A vê 1, não 2',
    colisao.rows[0]?.n === 1, `viu ${colisao.rows[0]?.n}`);

  /*
   * `anon` NÃO PODE NEM CHEGAR À VIEW, e esta asserção pegou um defeito real: a
   * primeira versão da migração só fazia `grant select to authenticated`, e
   * `anon` leu assim mesmo. O projeto tem `ALTER DEFAULT PRIVILEGES` que dá
   * `arwdDxtm` a anon/authenticated/service_role em toda view nova em `public` —
   * então o `grant` sem `revoke` antes é decorativo.
   *
   * A RLS segurava (anon sem JWT vê zero linhas), mas isso é a segunda camada
   * fazendo o trabalho da primeira. A asserção exige o `42501`.
   */
  const anonLe = await tentar(`set local role anon`);
  if (!anonLe.erro) {
    const r = await tentar(`select count(*) from public.conversas_painel`);
    await c.query('reset role');
    chk('`anon` é RECUSADO na view (42501), não apenas vê zero linhas',
      r.erro !== null && r.codigo === '42501', r.erro ?? '(leu!)');
  }
  /*
   * A escrita é recusada por DOIS motivos independentes, e o teste mede os dois
   * porque cada um pode ser perdido sozinho:
   *
   *   1. estrutural — a view tem `join`, então não é auto-atualizável e o
   *      Postgres recusa ANTES de olhar privilégio (por isso o código não é
   *      42501; a primeira versão desta asserção exigia 42501 e falhou por
   *      medir a razão errada);
   *   2. de privilégio — o `revoke all` da migração deixou `authenticated` com
   *      `r` e nada mais. Se alguém acrescentar um `instead of` trigger um dia,
   *      o motivo 1 some e só este segura.
   */
  const escrita = await comoTenant(A, `delete from public.conversas_painel`);
  chk('`authenticated` não ESCREVE pela view (recusada, seja qual for o motivo)',
    escrita.erro !== null, escrita.erro ?? '(apagou!)');
  const aclView = (await c.query(`select relacl::text a from pg_class where relname='conversas_painel'`)).rows[0].a;
  chk('e o ACL dá a `authenticated` SOMENTE leitura (`r`), sem a/w/d',
    /authenticated=r\//.test(aclView), aclView);
  chk('e `anon` não aparece no ACL da view',
    !/anon=/.test(aclView), aclView);

  console.log('\n-- 4. A LÁPIDE resolvida, e os três estados --\n');
  const linhas = await comoTenant(A, `select conversation_id, status_bruto, status_efetivo, pausa_vigente,
      (pausa_expira_em is null) sem_volta, motivo_pausa
     from public.conversas_painel order by conversation_id`);
  linhas.rows.forEach((r) => console.log(
    `    conv ${r.conversation_id}  bruto=${String(r.status_bruto).padEnd(8)} efetivo=${String(r.status_efetivo).padEnd(8)}` +
    ` vigente=${String(r.pausa_vigente).padEnd(5)} motivo=${String(r.motivo_pausa).padEnd(16)} sem_volta=${r.sem_volta}`));
  const porConv = Object.fromEntries(linhas.rows.map((r) => [Number(r.conversation_id), r]));

  chk('pausa VENCIDA: bruto=pausado mas efetivo=ativo (a lápide resolvida)',
    porConv[CONV].status_bruto === 'pausado' && porConv[CONV].status_efetivo === 'ativo' && porConv[CONV].pausa_vigente === false);
  chk('pausa VIGENTE (10 min): efetivo=pausado, e tem hora de volta',
    porConv[CONV + 1].status_efetivo === 'pausado' && porConv[CONV + 1].sem_volta === false);
  chk('pausa MANUAL de 5 dias: efetivo=pausado, e SEM hora de volta (não caduca)',
    porConv[CONV + 2].status_efetivo === 'pausado' && porConv[CONV + 2].sem_volta === true);
  chk('conversa ATIVA: efetivo=ativo e sem hora de volta',
    porConv[CONV + 3].status_efetivo === 'ativo' && porConv[CONV + 3].sem_volta === true);

  // A propriedade que faz a migração valer: a view discorda do cru.
  const disc = await comoTenant(A, `select count(*)::int n from public.conversas_painel
     where status_bruto = 'pausado' and status_efetivo = 'ativo'`);
  chk('a view DISCORDA do cru onde deve (é a mentira que ela conserta)',
    disc.rows[0]?.n === 1, `${disc.rows[0]?.n}`);

  console.log('\n-- 5. Reexecutável e rollback --\n');
  const r2 = await tentar(M51);
  chk('aplicar duas vezes não quebra', r2.erro === null, r2.erro ?? '');
  await c.query(R51);
  chk('o rollback derruba a view', (await existeView()) === 0);
  chk('e NÃO leva os predicados da 47 junto',
    (await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
       where ns.nspname='public' and p.proname in ('pausa_vigente','conversa_status_efetivo')`)).rows[0].n === 2);
  await c.query(M51);

  console.log('\n-- 6. Sabotagem: sem `security_invoker` --\n');
  {
    const DE = 'with (security_invoker = true)';
    const sab = M51.replace(DE, '');
    sus('S1 mutação entrou (o security_invoker saiu do SQL)', sab !== M51 && !sab.includes(DE));
    const r = await tentar(sab);
    sus('S1 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    sus('S1 e a view realmente ficou sem a opção',
      (await c.query(`select reloptions from pg_class where relname='conversas_painel'`)).rows[0].reloptions === null);

    const vazou = await comoTenant(A, `select count(*)::int n, count(distinct tenant_id)::int d from public.conversas_painel`);
    chk('S1 SEM security_invoker, A passa a ver conversas de outros tenants (o teste reprova)',
      vazou.rows[0]?.d > 1, `viu ${vazou.rows[0]?.n} linhas de ${vazou.rows[0]?.d} tenant(s) — se for 1, o teste NÃO mede isolamento`);
    console.log(`        (A viu ${vazou.rows[0]?.n} linhas de ${vazou.rows[0]?.d} tenants; sob a view correta são 4 de 1)`);
    await c.query(M51);
  }
} catch (e) {
  falhas.push(`exceção não prevista: ${e.message}`);
  console.log(`  FALHA exceção não prevista — ${e.message}`);
} finally {
  await c.query('rollback');
  const depois = await existeView();
  console.log(`\n  (transação revertida; view em produção: ${depois ? 'existe' : 'não existe'}` +
    ` — igual a antes: ${viewAntesDeTudo === depois ? 'sim' : 'NÃO'})`);
  if (viewAntesDeTudo !== depois) falhas.push('o teste mudou o schema de produção');
  const sobra = (await c.query(`select count(*)::int n from public.tenants where slug like 'zz-efem-painel51-%'`)).rows[0].n;
  console.log(`  (tenants efêmeros sobrando: ${sobra})`);
  if (sobra > 0) falhas.push(`${sobra} tenant(s) efêmero(s) sobraram`);
  await c.end();
}

console.log('\n----------------------------------------------------------');
console.log(`  ${ok + okSus} passaram, ${falhas.length} falharam`);
console.log(`    ${ok} por motivo próprio (propriedade da migração)`);
console.log(`    ${okSus} de sustentação (~) — provam que o TESTE faz o que diz`);
falhas.forEach((f) => console.log(`  ! ${f}`));
console.log();
process.exit(falhas.length === 0 ? 0 : 1);
