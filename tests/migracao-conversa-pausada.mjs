#!/usr/bin/env node
/**
 * Migração 48 (`api_n8n_conversa_pausada`) numa TRANSAÇÃO ABORTADA contra
 * produção. Nada é gravado: o rollback no fim é incondicional.
 *
 * O QUE ELE PROVA, e ler o SQL não prova:
 *
 *   - que `n8n_agent` CHAMA a função. É a razão de existir do teste: a 40 e a 41
 *     saíram só com `service_role` e derrubaram o agente em produção, e a
 *     verificação delas conferiu contra a lista escrita à mão. Aqui é chamada de
 *     verdade, com `set local role`;
 *   - que `anon` e `authenticated` NÃO chamam — a função é SECURITY DEFINER, e
 *     aberta a `anon` qualquer um leria a pausa de qualquer conversa de qualquer
 *     cliente passando o par de ids;
 *   - que ela CONCORDA com `api_n8n_conversa_sync` e `api_n8n_pode_transcrever`
 *     na mesma conversa. É a propriedade central: três portas, um predicado. Se
 *     divergirem, a duplicação que a 47 evitou entrou por outra porta;
 *   - a tabela verdade, com o estado ARRANJADO pelo teste — manual não caduca,
 *     mensagem humana caduca pela janela DO TENANT;
 *   - que a janela é do tenant, com duas conversas de MESMO `conversation_id` em
 *     tenants diferentes (`conversation_id` não é único entre clientes);
 *   - que aplicar a migração não muda `status`, `motivo_pausa` nem contratação
 *     de ninguém. Propriedade, não estado do mundo.
 *
 * A SABOTAGEM (seção 7) remove, uma por vez, as linhas que sustentam isso, e
 * exige que o teste reprove — inclusive a que troca a função pela irmã de nome
 * errado, que é o atalho que alguém vai tentar.
 *
 * Uso: npm run teste:conversa-pausada
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DIR = RAIZ + 'supabase/migrations/';

/** Acha o arquivo pelo sufixo, para sobreviver ao rename do ledger. */
function acharMigracao(sufixo) {
  const achados = fs.readdirSync(DIR).filter((f) => f.endsWith(sufixo));
  if (achados.length !== 1) {
    throw new Error(`esperava 1 arquivo terminando em "${sufixo}", achei ${achados.length}`);
  }
  return fs.readFileSync(DIR + achados[0], 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
}

const M48 = acharMigracao('_48_conversa_pausada.sql');
const R48 = acharMigracao('_48_conversa_pausada_rollback.sql');

if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

let ok = 0;
let okSus = 0;
const falhas = [];
/** `chk` = propriedade da migração. `sus` = sustentação: prova que o TESTE faz o que diz. */
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};
const sus = (nome, cond, det = '') => {
  if (cond) { okSus++; console.log(`  OK  ~ ${nome}`); }
  else { falhas.push(`[sustentação] ${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ~ ${nome}${det ? ' — ' + det : ''}`); }
};

async function tentar(sql, params = []) {
  await c.query('savepoint sp');
  try {
    const r = await c.query(sql, params);
    await c.query('release savepoint sp');
    return { erro: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sp');
    return { erro: e.message, codigo: e.code, rows: [] };
  }
}

/** Rejeição vira VALOR, não crash — senão a sabotagem derruba o processo. */
async function comoRole(role, sql, params = []) {
  await c.query('savepoint sr');
  try {
    await c.query(`set local role ${role}`);
    const r = await c.query(sql, params);
    await c.query('reset role');
    await c.query('release savepoint sr');
    return { erro: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sr');
    await c.query('reset role');
    return { erro: e.message, codigo: e.code, rows: [] };
  }
}

const CLAIM_SUPER = `'{"app_metadata":{"papel":"super_admin"}}'`;
/** `tenants` tem guard de colunas: mexer na janela é operação de agência. */
async function comoSuper(sql, params = []) {
  await c.query(`set local request.jwt.claims = ${CLAIM_SUPER}`);
  try { return await c.query(sql, params); } finally { await c.query(`reset request.jwt.claims`); }
}

const acl = async () => {
  const { rows } = await c.query(
    `select coalesce(p.proacl::text[], array[]::text[]) a
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='api_n8n_conversa_pausada'`);
  return (rows[0]?.a ?? []).map((e) => (e.split('=')[0] === '' ? 'PUBLIC' : e.split('=')[0])).sort();
};

const pausada = async (t, conv) =>
  (await c.query(`select public.api_n8n_conversa_pausada($1::uuid,$2::bigint) v`, [t, conv])).rows[0].v;

const funcaoExiste = async () => (await c.query(
  `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='public' and p.proname='api_n8n_conversa_pausada'`)).rows[0].n;

async function arranjar(t, conv, { status = 'ativo', minAtras = null, motivo = null } = {}) {
  const quando = `case when $4::int is null then null else now() - make_interval(mins => $4::int) end`;
  if (motivo === null) {
    await c.query(`insert into public.conversas (tenant_id, conversation_id, status, pausado_em)
                   values ($1,$2,$3,${quando})`, [t, conv, status, minAtras]);
  } else {
    await c.query(`insert into public.conversas (tenant_id, conversation_id, status, pausado_em, motivo_pausa)
                   values ($1,$2,$3,${quando},$5)`, [t, conv, status, minAtras, motivo]);
  }
}

await c.connect();

const existiaAntes = await (async () => {
  const r = await c.query(
    `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='api_n8n_conversa_pausada'`);
  return r.rows[0].n === 1;
})();

await c.query('begin');

try {
  console.log('\n== Migração 48: api_n8n_conversa_pausada ==\n');

  /*
   * NENHUMA claim de JWT no topo. É a lição da 47: `trg_tenants_guard_colunas`
   * levanta 42501 para coluna fora da lista branca, e a primeira versão daquele
   * teste setava a claim uma vez, fazendo a migração passar numa condição que o
   * apply real não tem. A claim entra só nos comandos de arranjo que mexem em
   * `tenants`.
   */

  console.log('-- 1. Arranja o estado de ANTES --\n');

  // O rollback põe o banco no estado pré-48 tendo ela sido aplicada ou não.
  await c.query(R48);
  sus('o rollback deixou o banco no estado pré-48 (função ausente)',
    (await funcaoExiste()) === 0);

  const sufixo = Math.random().toString(16).slice(2, 10);
  const tenants = [];
  for (let i = 0; i < 3; i++) {
    const { rows } = await c.query(
      `insert into public.tenants (slug, nome, ativo) values ($1,$2,true) returning id`,
      [`zz-efem-pausada48-${sufixo}-${i}`, `efêmero pausada 48 ${sufixo} #${i}`]);
    tenants.push(rows[0].id);
  }
  const [A, B, C] = tenants;
  const CONV_COMPART = 9_480_000 + Math.floor(Math.random() * 1000);

  await arranjar(A, 4801, { status: 'pausado', minAtras: 90, motivo: 'mensagem_humana' });
  await arranjar(A, 4802, { status: 'pausado', minAtras: 10, motivo: 'mensagem_humana' });
  await arranjar(A, 4803, { status: 'pausado', minAtras: 7200, motivo: 'manual' });
  await arranjar(A, 4804, { status: 'ativo' });
  sus('as conversas de arranjo entraram (anti-vacuidade)',
    (await c.query(`select count(*)::int n from public.conversas where tenant_id=$1`, [A])).rows[0].n === 4);

  const statusAntes = (await c.query(
    `select status, count(*)::int n from public.conversas group by status order by status`)).rows
    .map((r) => `${r.status}=${r.n}`).join(',');
  const motivoAntes = (await c.query(
    `select coalesce(motivo_pausa,'(null)') m, count(*)::int n from public.conversas group by 1 order by 1`)).rows
    .map((r) => `${r.m}=${r.n}`).join(',');

  console.log('\n-- 2. Aplica a migração --\n');

  const aplicou = await tentar(M48);
  chk('a migração aplica SEM claim de JWT nenhuma (a condição do apply real)',
    aplicou.erro === null, aplicou.erro ?? '');
  chk('a função existe e tem EXATAMENTE UMA assinatura', (await funcaoExiste()) === 1);

  const meta = (await c.query(
    `select p.provolatile, p.prosecdef, pg_get_function_identity_arguments(p.oid) args
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='api_n8n_conversa_pausada'`)).rows[0];
  chk('é STABLE (não pode escrever — a expiração é preguiçosa)', meta.provolatile === 's', meta.provolatile);
  chk('é SECURITY DEFINER (n8n_agent não tem privilégio de tabela desde a 09)', meta.prosecdef === true);
  chk('a assinatura é (uuid, bigint)', meta.args === 'p_tenant_id uuid, p_conversation_id bigint', meta.args);

  const a = await acl();
  chk('`n8n_agent` está no ACL (a linha que faltou na 40 e na 41)', a.includes('n8n_agent'), a.join(','));
  chk('`service_role` está no ACL', a.includes('service_role'), a.join(','));
  chk('`PUBLIC`, `anon` e `authenticated` estão FORA',
    !a.includes('PUBLIC') && !a.includes('anon') && !a.includes('authenticated'), a.join(','));

  const statusDepois = (await c.query(
    `select status, count(*)::int n from public.conversas group by status order by status`)).rows
    .map((r) => `${r.status}=${r.n}`).join(',');
  const motivoDepois = (await c.query(
    `select coalesce(motivo_pausa,'(null)') m, count(*)::int n from public.conversas group by 1 order by 1`)).rows
    .map((r) => `${r.m}=${r.n}`).join(',');
  chk('aplicar a migração não muda o status de ninguém', statusAntes === statusDepois, `${statusAntes} | ${statusDepois}`);
  chk('nem o motivo de ninguém', motivoAntes === motivoDepois, `${motivoAntes} | ${motivoDepois}`);

  console.log('\n-- 3. A tabela verdade, com estado arranjado --\n');

  chk('pausa humana VENCIDA (90 min, janela 30) → false', (await pausada(A, 4801)) === false);
  chk('pausa humana DENTRO da janela (10 min) → true', (await pausada(A, 4802)) === true);
  chk('pausa MANUAL de 5 dias → true (nunca caduca)', (await pausada(A, 4803)) === true);
  chk('conversa ATIVA → false', (await pausada(A, 4804)) === false);
  chk('conversa INEXISTENTE → false (o que não existe não está pausado)',
    (await pausada(A, 4899)) === false);

  const semConv = await tentar(`select public.api_n8n_conversa_pausada($1::uuid, null::bigint)`, [A]);
  chk('conversation_id nulo é RECUSADO, não silencioso',
    semConv.erro !== null && semConv.codigo === '22023', semConv.erro ?? '(passou)');

  const tenantFalso = await tentar(
    `select public.api_n8n_conversa_pausada('00000000-0000-0000-0000-000000000000'::uuid, 1::bigint)`);
  chk('tenant inexistente é RECUSADO pelo n8n_assert_tenant',
    tenantFalso.erro !== null && tenantFalso.codigo === '42501', tenantFalso.erro ?? '(passou)');

  console.log('\n-- 4. As TRÊS portas concordam --\n');

  for (const [conv, esperado] of [[4801, false], [4802, true], [4803, true], [4804, false]]) {
    const p = await pausada(A, conv);
    const sync = (await c.query(
      `select status from public.api_n8n_conversa_sync($1::uuid,$2::bigint,null,null)`, [A, conv])).rows[0].status;
    const tr = (await c.query(
      `select conversa_pausada from public.api_n8n_pode_transcrever($1::uuid,$2::bigint)`, [A, conv])).rows[0].conversa_pausada;
    chk(`conversa ${conv}: as três portas concordam (pausada=${esperado})`,
      p === esperado && tr === esperado && (sync === 'pausado') === esperado,
      `nova=${p} transcrever=${tr} sync=${sync}`);
  }

  console.log('\n-- 5. A janela é DO TENANT, e conversation_id colide --\n');

  await comoSuper(`update public.tenants set pausa_expira_minutos = 1 where id = $1`, [B]);
  sus('a janela de B foi mesmo para 1 (a mutação de arranjo entrou)',
    (await c.query(`select pausa_expira_minutos j from public.tenants where id=$1`, [B])).rows[0].j === 1);

  await arranjar(B, CONV_COMPART, { status: 'pausado', minAtras: 10, motivo: 'mensagem_humana' });
  await arranjar(C, CONV_COMPART, { status: 'pausado', minAtras: 10, motivo: 'mensagem_humana' });
  sus('o mesmo conversation_id existe nos dois tenants (a colisão foi arranjada)',
    (await c.query(`select count(*)::int n from public.conversas where conversation_id=$1`, [CONV_COMPART])).rows[0].n === 2);

  chk('B (janela 1) → false; C (janela 30) → true, no MESMO conversation_id',
    (await pausada(B, CONV_COMPART)) === false && (await pausada(C, CONV_COMPART)) === true,
    `B=${await pausada(B, CONV_COMPART)} C=${await pausada(C, CONV_COMPART)}`);

  console.log('\n-- 6. Os roles --\n');

  const n8n = await comoRole('n8n_agent',
    `select public.api_n8n_conversa_pausada($1::uuid,$2::bigint) v`, [A, 4802]);
  chk('`n8n_agent` CHAMA (não `has_function_privilege` — chamada de verdade)',
    n8n.erro === null && n8n.rows[0]?.v === true, n8n.erro ?? JSON.stringify(n8n.rows));

  for (const role of ['anon', 'authenticated']) {
    const r = await comoRole(role, `select public.api_n8n_conversa_pausada($1::uuid,$2::bigint)`, [A, 4802]);
    chk(`\`${role}\` NÃO chama`, r.erro !== null && r.codigo === '42501', r.erro ?? '(chamou!)');
  }

  console.log('\n-- 7. Reexecutável e rollback --\n');

  const r2 = await tentar(M48);
  chk('aplicar duas vezes não quebra', r2.erro === null, r2.erro ?? '');
  chk('e o ACL continua o mesmo', JSON.stringify(await acl()) === JSON.stringify(a));

  await c.query(R48);
  chk('o rollback derruba a função', (await funcaoExiste()) === 0);
  const pv = (await c.query(
    `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='pausa_vigente'`)).rows[0].n;
  chk('e NÃO leva `pausa_vigente` junto (a regra é da 47 e tem outros leitores)', pv === 1);
  const syncVivo = await comoRole('n8n_agent',
    `select status from public.api_n8n_conversa_sync($1::uuid,$2::bigint,null,null)`, [A, 4802]);
  chk('o n8n continua sincronizando conversa depois do rollback',
    syncVivo.erro === null && syncVivo.rows[0]?.status === 'pausado', syncVivo.erro ?? '');

  await c.query(M48);

  console.log('\n-- 8. Sabotagem --\n');

  const sabotar = (de, para) => {
    const s = M48.replace(de, para);
    return { sql: s, entrou: s !== M48 && !s.includes(de) };
  };

  {
    // O atalho que alguém vai tentar: reusar a irmã de nome errado. Ela responde
    // igual HOJE — a sabotagem tem de mostrar que o teste NÃO percebe, e é por
    // isso que a defesa contra ela é o nome, não o comportamento.
    const { sql, entrou } = sabotar(
      'select public.pausa_vigente(cv.status, cv.pausado_em, cv.motivo_pausa, t.pausa_expira_minutos)\n    into v_pausada\n    from public.tenants t\n    left join public.conversas cv\n           on cv.tenant_id = t.id\n          and cv.conversation_id = p_conversation_id\n   where t.id = p_tenant_id;',
      'select conversa_pausada into v_pausada\n    from public.api_n8n_pode_transcrever(p_tenant_id, p_conversation_id);');
    sus('S1 mutação entrou (delegou para a irmã de nome errado)', entrou);
    const r = await tentar(sql);
    sus('S1 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    chk('S1 ela responde IGUAL — a proteção contra este atalho é o NOME, não o teste',
      (await pausada(A, 4801)) === false && (await pausada(A, 4803)) === true,
      'se um dia divergir, é porque pode_transcrever ganhou regra própria');
    await c.query(M48);
  }
  {
    // Tira o `n8n_agent` dos grants: é a falha exata da 40 e da 41.
    const { sql, entrou } = sabotar(
      'grant execute on function public.api_n8n_conversa_pausada(uuid, bigint) to n8n_agent;', '');
    sus('S2 mutação entrou (o grant de n8n_agent saiu)', entrou);
    await c.query(R48);
    const r = await tentar(sql);
    sus('S2 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    const chamada = await comoRole('n8n_agent',
      `select public.api_n8n_conversa_pausada($1::uuid,$2::bigint)`, [A, 4802]);
    chk('S2 sem o grant, `n8n_agent` é RECUSADO (o teste reprova)',
      chamada.erro !== null && chamada.codigo === '42501', chamada.erro ?? '(chamou!)');
    await c.query(R48);
    await c.query(M48);
  }
  {
    // Tira o SECURITY DEFINER: n8n_agent perde a tabela.
    const { sql, entrou } = sabotar('stable\nsecurity definer\n', 'stable\n');
    sus('S3 mutação entrou (o SECURITY DEFINER saiu)', entrou);
    await c.query(R48);
    const r = await tentar(sql);
    sus('S3 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    const chamada = await comoRole('n8n_agent',
      `select public.api_n8n_conversa_pausada($1::uuid,$2::bigint)`, [A, 4802]);
    chk('S3 sem definer, `n8n_agent` morre em permission denied for table (o teste reprova)',
      chamada.erro !== null && /permission denied/.test(chamada.erro ?? ''), chamada.erro ?? '(chamou!)');
    await c.query(R48);
    await c.query(M48);
  }
  {
    // Tira o `left join` do tenant: a janela deixa de ser do tenant certo.
    const { sql, entrou } = sabotar(
      'and cv.conversation_id = p_conversation_id\n   where t.id = p_tenant_id;',
      'and cv.conversation_id = p_conversation_id\n   where t.pausa_expira_minutos is not null\n   order by t.criado_em limit 1;');
    sus('S4 mutação entrou (o filtro de tenant saiu)', entrou);
    const r = await tentar(sql);
    sus('S4 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    chk('S4 sem o filtro, B e C param de discordar no mesmo id (o teste reprova)',
      (await pausada(B, CONV_COMPART)) === (await pausada(C, CONV_COMPART)),
      `B=${await pausada(B, CONV_COMPART)} C=${await pausada(C, CONV_COMPART)}`);
    await c.query(M48);
  }
} catch (e) {
  falhas.push(`exceção não prevista: ${e.message}`);
  console.log(`  FALHA exceção não prevista — ${e.message}`);
} finally {
  await c.query('rollback');
  const existeDepois = (await c.query(
    `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='api_n8n_conversa_pausada'`)).rows[0].n === 1;
  console.log(`\n  (transação revertida; função em produção: ${existeDepois ? 'existe' : 'não existe'}` +
    ` — igual a antes do teste: ${existiaAntes === existeDepois ? 'sim' : 'NÃO'})`);
  if (existiaAntes !== existeDepois) {
    falhas.push(`o teste mudou o schema de produção (antes: ${existiaAntes}, depois: ${existeDepois})`);
  }
  const sobra = (await c.query(
    `select count(*)::int n from public.tenants where slug like 'zz-efem-pausada48-%'`)).rows[0].n;
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
