#!/usr/bin/env node
/**
 * Migração 44 (times do Chatwoot) numa TRANSAÇÃO ABORTADA contra produção.
 *
 * O QUE PROVA, e nenhuma dessas se lê no SQL:
 *
 *  - o TETO DA SOMA barra o caso que o teto por linha deixa passar: quinze
 *    times de 80 caracteres. É a razão de o limite estar em trigger e não só na
 *    Server Action;
 *  - UM padrão por tenant, e o índice parcial deixa `padrao = false` repetir;
 *  - nome duplicado é recusado — o modelo escolhe PELO NOME, e dois iguais
 *    fariam o servidor resolver para um dos dois sem critério;
 *  - `api_n8n_times` filtra pelo ARGUMENTO: pedir os times de A não devolve os
 *    de B (com contraprova de que o dado do B existe). NÃO é prova de RLS — a
 *    função é SECURITY DEFINER e a policy não é consultada ali. A RLS de
 *    `tenant_times` continua sem teste próprio; ver o comentário do caso;
 *  - `api_n8n_times` responde a `n8n_agent` e é RECUSADA para `anon`;
 *  - o `tenant_admin` NÃO lê a própria credencial do Chatwoot — o fato que
 *    obriga a Server Action a usar `service_role`, com controle positivo para a
 *    asserção não passar vazia.
 *
 * Uso: npm run teste:times
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const lim = (f) =>
  fs.readFileSync(RAIZ + 'supabase/migrations/' + f, 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

const M44 = lim('20260818210000_44_times_do_chatwoot.sql');
const R44 = lim('20260818210000_44_times_do_chatwoot_rollback.sql');

if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

async function tentar(sql, params = []) {
  await c.query('savepoint sp');
  try {
    const r = await c.query(sql, params);
    await c.query('release savepoint sp');
    return { erro: null, codigo: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sp');
    return { erro: e.message, codigo: e.code, rows: [] };
  }
}

async function comoRole(role, sql, params) {
  await c.query('savepoint sp_role');
  try {
    await c.query(`set local role ${role}`);
    await c.query(sql, params);
    await c.query('reset role');
    await c.query('release savepoint sp_role');
    return { barrado: false, codigo: null };
  } catch (e) {
    await c.query('rollback to savepoint sp_role');
    await c.query('reset role');
    return { barrado: e.code === '42501', codigo: e.code };
  }
}

await c.connect();
await c.query('begin');

try {
  console.log('\n== Migração 44: times do Chatwoot ==\n');

  await c.query(`set local request.jwt.claims = '{"app_metadata":{"papel":"super_admin"}}'`);
  const sufixo = Math.random().toString(16).slice(2, 10);
  const A = (await c.query(
    `insert into public.tenants (slug, nome, ativo) values ($1, 'efêmero A', true) returning id`,
    [`zz-efem-times-a-${sufixo}`])).rows[0].id;
  const B = (await c.query(
    `insert into public.tenants (slug, nome, ativo) values ($1, 'efêmero B', true) returning id`,
    [`zz-efem-times-b-${sufixo}`])).rows[0].id;

  // -------------------------------------------------------------------------
  console.log('-- 1. Aplicar --\n');

  const aplicou = await tentar(M44);
  chk('migração 44 aplica', aplicou.erro === null, `veio ${aplicou.erro}`);
  if (aplicou.erro) throw new Error('migração 44 não aplica');

  const rls = (await c.query(
    `select relrowsecurity r, (select count(*)::int from pg_policies where tablename='tenant_times') p
       from pg_class where relname='tenant_times'`)).rows[0];
  chk('RLS ligada com policy', rls.r === true && rls.p >= 1, JSON.stringify(rls));

  const inserir = (tenant, team, nome, desc = '', padrao = false) =>
    tentar(
      `insert into public.tenant_times (tenant_id, team_id, nome, descricao, padrao)
       values ($1, $2, $3, $4, $5)`,
      [tenant, team, nome, desc, padrao],
    );

  // -------------------------------------------------------------------------
  console.log('\n-- 2. O teto da SOMA (o que o teto por linha deixa passar) --\n');

  const d80 = 'x'.repeat(80);
  let entraram = 0;
  let barrouNo = null;
  for (let i = 1; i <= 15; i += 1) {
    const r = await inserir(A, 1000 + i, `time ${i}`, d80);
    if (r.erro === null) entraram += 1;
    else if (barrouNo === null) barrouNo = i;
  }
  // 720 / 80 = 9 cabem; o décimo estoura.
  chk('quinze times de 80 chars NÃO entram todos', entraram < 15, `entraram ${entraram}`);
  chk('cabem 9 (720/80) e o 10º é barrado', entraram === 9 && barrouNo === 10,
    `entraram ${entraram}, barrou no ${barrouNo}`);

  const soma = (await c.query(
    `select coalesce(sum(length(descricao)),0)::int s from public.tenant_times where tenant_id=$1`, [A])).rows[0].s;
  chk('a soma parou em 720', soma === 720, String(soma));

  const umGrande = await inserir(B, 2001, 'grande', 'y'.repeat(121));
  chk('descrição de 121 chars é barrada pelo CHECK de linha', umGrande.erro !== null,
    `veio ${umGrande.codigo}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 3. Padrão e nome --\n');

  await inserir(B, 20, 'suporte', 'Quando o cliente tem problema com algo que já comprou.', true);
  const doisPadroes = await inserir(B, 21, 'comercial', 'Quando quer comprar.', true);
  chk('só UM padrão por tenant', doisPadroes.codigo === '23505', `veio ${doisPadroes.codigo}`);

  const naoPadrao = await inserir(B, 21, 'comercial', 'Quando quer comprar.', false);
  chk('mas vários NÃO-padrão convivem', naoPadrao.erro === null, `veio ${naoPadrao.erro}`);

  const nomeIgual = await inserir(B, 22, 'Suporte', 'outro');
  chk('nome duplicado (só o caixa muda) é recusado', nomeIgual.codigo === '23505',
    `veio ${nomeIgual.codigo} — o modelo escolhe pelo nome`);

  const mesmoTime = await inserir(B, 20, 'suporte-2', 'x');
  chk('o mesmo team_id duas vezes é recusado', mesmoTime.codigo === '23505', `veio ${mesmoTime.codigo}`);

  // O padrão de A ainda não existe: dois tenants não brigam pelo índice parcial.
  const padraoDeA = await inserir(A, 30, 'atendimento', '', true);
  chk('o padrão de A não conflita com o padrão de B', padraoDeA.erro === null, `veio ${padraoDeA.erro}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 4. Isolamento, com contraprova --\n');

  const doB = (await c.query(
    `select count(*)::int n from public.tenant_times where tenant_id=$1`, [B])).rows[0].n;
  chk('B tem time cadastrado (contraprova)', doB >= 2, String(doB));

  const vistoPorA = (await c.query(
    `select count(*)::int n from public.api_n8n_times($1)`, [A])).rows[0].n;
  const vistoPorB = (await c.query(
    `select count(*)::int n from public.api_n8n_times($1)`, [B])).rows[0].n;
  /*
   * ISOLAMENTO POR ARGUMENTO, NAO POR RLS — e a distincao importa.
   *
   * `api_n8n_times` e SECURITY DEFINER: ela roda como o dono e a policy de
   * `tenant_times` nao e consultada aqui de jeito nenhum. E ainda que fosse, as
   * claims de super_admin setadas no topo deste arquivo valem a transacao
   * inteira, e `p_tenant_times_all` e
   * `auth_is_super_admin() OR tenant_id = auth_tenant_id()` — abriria assim
   * mesmo.
   *
   * O que esta assercao prova de verdade e util: o PARAMETRO filtra, e o
   * SECURITY DEFINER nao vaza pelos lados. E garantia mais fragil que a da RLS,
   * porque depende de quem chama passar o tenant certo — que e exatamente o que
   * o n8n faz, e por isso vale ter.
   */
  chk('api_n8n_times filtra pelo ARGUMENTO (SECURITY DEFINER: a RLS nao entra aqui)',
    vistoPorA === 10 && vistoPorB === doB, `A=${vistoPorA} B=${vistoPorB}`);
  chk('e o padrão vem primeiro na lista', (await c.query(
    `select padrao from public.api_n8n_times($1) limit 1`, [B])).rows[0].padrao === true);

  // -------------------------------------------------------------------------
  console.log('\n-- 5. Grants da função --\n');

  const chamada = `select * from public.api_n8n_times($1::uuid)`;
  const n8n = await comoRole('n8n_agent', chamada, [B]);
  chk('n8n_agent CHAMA api_n8n_times', !n8n.barrado, `veio ${n8n.codigo}`);
  for (const role of ['anon', 'authenticated']) {
    const r = await comoRole(role, chamada, [B]);
    chk(`${role} é barrado (o mesmo comando que n8n_agent roda)`, r.barrado, `veio ${r.codigo}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n-- 5b. O tenant NAO le a propria credencial --\n');

  // POR QUE ESTE TESTE EXISTE. A validacao de time precisa do token do Chatwoot,
  // e a primeira versao da Server Action leu `tenant_credenciais` com a sessao
  // do cliente. A unica policy da tabela e `auth_is_super_admin()` (migracao
  // 21a), entao a leitura voltava NULA sempre e a verificacao nunca rodava —
  // com a mensagem errada por cima, culpando a conexao do Chatwoot.
  //
  // A acao passou a usar `service_role`. Este teste guarda o fato que obriga
  // isso: se um dia a policy afrouxar, o cliente passa a ler o proprio token e
  // a segregacao da 21a some sem ninguem notar.
  await c.query(`insert into public.tenant_credenciais (tenant_id, chatwoot_token) values ($1, $2)`,
    [B, 'token-de-teste-24-chars']);

  await c.query('savepoint sp_cred');
  await c.query(`set local role authenticated`);
  // `set_config(..., true)` e nao `SET LOCAL`: SET nao aceita parametro
  // vinculado, e interpolar json de tenant na string seria injecao esperando
  // acontecer.
  await c.query(`select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ app_metadata: { tenant_id: B, papel: 'tenant_admin' } })]);
  const comoTenant = (await c.query(
    `select count(*)::int n from public.tenant_credenciais where tenant_id = $1`, [B])).rows[0].n;
  // Mesma sessao, mesmas claims, mesmo role: a leitura que TEM de funcionar.
  const timesComoTenant = (await c.query(
    `select count(*)::int n from public.tenant_times where tenant_id = $1`, [B])).rows[0].n;
  await c.query('reset role');
  await c.query('rollback to savepoint sp_cred');

  chk('o tenant_admin NAO le a propria credencial (a acao precisa de service_role)',
    comoTenant === 0, `leu ${comoTenant} linha(s) — a policy da 21a afrouxou`);

  // CONTROLE POSITIVO — e sem ele a assercao acima nao vale nada.
  //
  // A policy de tenant_credenciais e `auth_is_super_admin()` e mais nada:
  // QUALQUER role nao-super devolve 0, com ou sem as claims terem pegado. Se o
  // `set_config` virasse no-op amanha, "leu 0 linhas" continuaria verdadeiro e o
  // teste seguiria verde sem ter exercitado nada.
  //
  // `tenant_times` tem policy por tenant, entao ler > 0 sob as MESMAS claims e
  // o MESMO role prova que o harness esta de pe. Se o set_config quebrar, esta
  // assercao cai — e e ela que faz a de cima significar alguma coisa.
  //
  // A PRIMEIRA SABOTAGEM QUE EU RODEI NAO VALIA, e vale registrar: quebrei o
  // `set_config` (nome de chave errado) esperando que este controle caisse. Caiu
  // foi a assercao NEGATIVA — sem claims novas, as de super_admin setadas no topo
  // deste arquivo sobrevivem, e a credencial vira legivel. Ou seja: aquele caso
  // ela ja pegava sozinha, e a sabotagem nao exercitou o controle novo.
  //
  // A que prova e a SEGUNDA: claims aplicadas com `tenant_id` ERRADO. Ai a
  // negativa passa por VACUIDADE (qualquer role nao-super devolve 0) e so este
  // controle cai. Sabotar uma vez teria deixado o controle novo sem prova, com
  // cara de provado.
  chk('controle positivo: sob as MESMAS claims, o tenant LE os proprios times',
    timesComoTenant > 0,
    `leu ${timesComoTenant} — se for 0, o set_config nao pegou e a assercao acima e vacua`);

  // Contraprova: a linha existe. Sem isso, "0 linhas" seria verdade tambem se
  // a credencial nunca tivesse sido gravada.
  const existeMesmo = (await c.query(
    `select count(*)::int n from public.tenant_credenciais where tenant_id = $1`, [B])).rows[0].n;
  chk('e a credencial existe de verdade (contraprova)', existeMesmo === 1, String(existeMesmo));


  // -------------------------------------------------------------------------
  console.log('\n-- 6. Rollback --\n');

  const rb = await tentar(R44);
  chk('rollback aplica', rb.erro === null, `veio ${rb.erro}`);
  const sobrou = (await c.query(
    `select count(*)::int n from information_schema.tables where table_name='tenant_times'`)).rows[0].n;
  chk('a tabela some', sobrou === 0, String(sobrou));
  const fn = (await c.query(
    `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='api_n8n_times'`)).rows[0].n;
  chk('a função some', fn === 0, String(fn));
} catch (e) {
  falhas.push(`execução interrompida: ${e.message}`);
  console.log(`  FALHA execução interrompida — ${e.message}`);
} finally {
  try { await c.query('rollback'); } catch { /* conexão já perdida */ }
  await c.end().catch(() => {});
}

console.log('\n' + '-'.repeat(60));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();

process.exitCode = falhas.length > 0 ? 1 : 0;
