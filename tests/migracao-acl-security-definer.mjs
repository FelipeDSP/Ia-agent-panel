#!/usr/bin/env node
/**
 * Migração 43 (fecha o ACL de sete SECURITY DEFINER) numa TRANSAÇÃO ABORTADA
 * contra produção. Nada é gravado.
 *
 * O QUE ELE PROVA, e o catálogo não prova:
 *
 *   - que depois da 43 `anon` e `authenticated` levam **42501** nas sete. É a
 *     asserção negativa, e ela vem com CONTRAPROVA: o mesmo comando, na mesma
 *     transação, roda como `n8n_agent` (ou `service_role`) e passa. Sem isso,
 *     "anon não consegue" seria verdade também se a função não existisse ou se
 *     os argumentos estivessem errados;
 *   - que as TRÊS que o n8n chama continuam chamáveis por `n8n_agent`. Nenhuma
 *     delas tinha grant explícito antes da 43 — funcionavam pelo grant
 *     implícito a PUBLIC. Revogar sem conceder derruba foto, transcrição e a
 *     guarda do `resolver_conversa`. É a armadilha da 41, agora em três frentes.
 *
 * CLASSIFICAÇÃO POR CÓDIGO, e não por sucesso: o que importa aqui é permissão,
 * não resultado. `42501` = barrado. Qualquer outro desfecho — inclusive erro de
 * argumento — significa que a chamada PASSOU pela permissão, que é o que se
 * quer medir.
 *
 * Uso: npm run teste:acl-secdef
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const lim = (f) =>
  fs.readFileSync(RAIZ + 'supabase/migrations/' + f, 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

const M43 = lim('20260818180000_43_fechar_acl_security_definer.sql');
const R43 = lim('20260818180000_43_fechar_acl_security_definer_rollback.sql');

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
    return { erro: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sp');
    return { erro: e.message, codigo: e.code, rows: [] };
  }
}

/** Chama COMO um role. Devolve `barrado: true` só no 42501. */
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

const expostasAnon = async () => (await c.query(
  `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.prosecdef
      and coalesce(has_function_privilege('anon', p.oid, 'execute'), false)
    order by 1`)).rows.map((r) => r.proname);

await c.connect();
await c.query('begin');

try {
  console.log('\n== Migração 43: fechar ACL das SECURITY DEFINER ==\n');

  await c.query(`set local request.jwt.claims = '{"app_metadata":{"papel":"super_admin"}}'`);
  const slug = `zz-efem-acl43-${Math.random().toString(16).slice(2, 10)}`;
  const tenant = (await c.query(
    `insert into public.tenants (slug, nome, ativo) values ($1, $2, true) returning id`,
    [slug, 'efêmero acl 43'])).rows[0]?.id;
  if (!tenant) throw new Error('não consegui criar o tenant efêmero');
  const CONV = 970043n;

  // As sete, com a chamada que cada uma aceita. `enviar_foto` recebe um uuid
  // qualquer de produto: ela vai recusar por produto inexistente, e recusa por
  // REGRA é passagem pela permissão, que é o que se mede aqui.
  const FUNCOES = [
    ['api_n8n_enviar_foto', 'n8n',
      `select * from public.api_n8n_enviar_foto($1::uuid, $2::bigint, gen_random_uuid())`, [tenant, CONV]],
    ['api_n8n_pode_transcrever', 'n8n',
      `select * from public.api_n8n_pode_transcrever($1::uuid, $2::bigint)`, [tenant, CONV]],
    ['api_n8n_tem_pedido_pendente', 'n8n',
      `select public.api_n8n_tem_pedido_pendente($1::uuid, $2::bigint)`, [tenant, CONV]],
    ['pedido_aberto_da_conversa', 'interna',
      `select public.pedido_aberto_da_conversa($1::uuid, $2::bigint)`, [tenant, CONV]],
    ['expirar_pedidos_vencidos', 'interna',
      `select public.expirar_pedidos_vencidos($1::uuid, $2::bigint)`, [tenant, CONV]],
    ['pedido_horas_para_expirar', 'interna',
      `select public.pedido_horas_para_expirar($1::uuid)`, [tenant]],
  ];

  // -------------------------------------------------------------------------
  console.log('\n-- 1. Antes: o estado que a 43 conserta --\n');

  const antes = await expostasAnon();
  console.log(`  (antes) ${antes.length} SECURITY DEFINER executáveis por anon`);
  chk('o retrato do antes foi capturado', Array.isArray(antes));

  // O vazamento em si, medido pelo banco: anon consegue chamar a que devolve
  // token? Se este teste rodar num banco onde a 43 já entrou, ele não é falha —
  // é aviso, porque afirmar o estado do mundo anterior é o defeito que a
  // migração 42 me ensinou.
  const vazavaAntes = await comoRole('anon',
    `select * from public.api_n8n_pode_transcrever($1::uuid, $2::bigint)`, [tenant, CONV]);
  console.log(vazavaAntes.barrado
    ? '  aviso: a 43 já está aplicada neste banco — o teste reaplica por cima'
    : '  aviso: partindo do estado PRÉ-43 (anon ainda alcança pode_transcrever)');

  // -------------------------------------------------------------------------
  console.log('\n-- 2. Aplicar --\n');

  const aplicou = await tentar(M43);
  chk('migração 43 aplica', aplicou.erro === null, `veio ${aplicou.erro}`);
  if (aplicou.erro) throw new Error('migração 43 não aplica');

  const depois = await expostasAnon();
  chk('ZERO SECURITY DEFINER executáveis por anon', depois.length === 0, depois.join(', '));

  // -------------------------------------------------------------------------
  console.log('\n-- 3. Quem NÃO pode (asserção negativa) --\n');

  for (const [nome, , sql, params] of FUNCOES) {
    for (const role of ['anon', 'authenticated']) {
      const r = await comoRole(role, sql, params);
      chk(`${role} é barrado em ${nome}`, r.barrado, `veio ${r.codigo ?? 'sem erro'}`);
    }
  }

  // -------------------------------------------------------------------------
  console.log('\n-- 4. A CONTRAPROVA: o mesmo comando, quem pode --\n');

  for (const [nome, tipo, sql, params] of FUNCOES) {
    // As três do n8n precisam de n8n_agent; as internas, só de service_role.
    const rolePermitido = tipo === 'n8n' ? 'n8n_agent' : 'service_role';
    const r = await comoRole(rolePermitido, sql, params);
    chk(`${rolePermitido} PASSA em ${nome}`, !r.barrado, `veio 42501 — grant faltando`);
  }

  // E o outro lado do corte: interna NÃO abre para o n8n.
  for (const [nome, tipo, sql, params] of FUNCOES.filter((f) => f[1] === 'interna')) {
    const r = await comoRole('n8n_agent', sql, params);
    chk(`n8n_agent é barrado em ${nome} (interna, como n8n_assert_tenant)`, r.barrado,
      `veio ${r.codigo ?? 'sem erro'} — a interna ficou aberta ao agente`);
  }

  // -------------------------------------------------------------------------
  console.log('\n-- 5. Sabotagem --\n');

  const sabotagens = [
    // PREPARAR existe por causa de um achado do próprio teste: o rollback da 43
    // CONCEDE `n8n_agent` de propósito (seção 1 dele), para que desfazer a
    // migração não derrube o agente. Ótimo em produção, e péssimo como ponto de
    // partida de sabotagem: partindo dali, tirar o grant da 43 não muda nada,
    // porque o grant já existe. Produção HOJE não tem esse grant, e é esse o
    // estado que a sabotagem precisa reproduzir.
    ['sem o grant a n8n_agent em pode_transcrever',
      (sql) => sql.replace(
        'grant execute on function public.api_n8n_pode_transcrever(uuid, bigint) to n8n_agent;', ''),
      async () => (await comoRole('n8n_agent',
        `select * from public.api_n8n_pode_transcrever($1::uuid, $2::bigint)`, [tenant, CONV])).barrado,
      'o agente perde a transcrição',
      'revoke all on function public.api_n8n_pode_transcrever(uuid, bigint) from n8n_agent'],
    ['sem o revoke em pode_transcrever',
      (sql) => sql.replace(
        'revoke all on function public.api_n8n_pode_transcrever(uuid, bigint) from public, anon, authenticated;', ''),
      async () => !(await comoRole('anon',
        `select * from public.api_n8n_pode_transcrever($1::uuid, $2::bigint)`, [tenant, CONV])).barrado,
      'o token continua saindo para anon',
      null],
  ];

  let semEfeito = 0;
  for (const [nome, mutar, detecta, oQue, preparar] of sabotagens) {
    const sql = mutar(M43);
    if (sql === M43) {
      semEfeito++;
      chk(`sabotagem "${nome}" MUTOU o SQL`, false, 'o replace não casou — não testou nada');
      continue;
    }
    await c.query('savepoint sp_sab');
    await tentar(R43);          // volta ao estado pré-43 para a sabotagem partir de lá
    if (preparar) await tentar(preparar);  // ...e reproduz o que o rollback melhora
    const ap = await tentar(sql);
    const pegou = ap.erro !== null ? true : await detecta();
    chk(`sabotagem "${nome}" é detectada (${oQue})`, pegou,
      ap.erro ? `aplicou com erro: ${ap.erro}` : 'aplicou limpa e nada mudou');
    await c.query('rollback to savepoint sp_sab');
  }
  chk('toda sabotagem realmente mutou o arquivo', semEfeito === 0, `${semEfeito} não mutaram`);

  // -------------------------------------------------------------------------
  console.log('\n-- 6. Rollback (reabre de propósito) --\n');

  const rb = await tentar(R43);
  chk('rollback aplica', rb.erro === null, `veio ${rb.erro}`);
  const depoisRb = await expostasAnon();
  chk('e reabre mesmo — o rollback devolve o estado anterior, exposição inclusa',
    depoisRb.length >= 7, `${depoisRb.length} expostas`);
  const agenteRb = await comoRole('n8n_agent',
    `select * from public.api_n8n_pode_transcrever($1::uuid, $2::bigint)`, [tenant, CONV]);
  chk('e o agente continua funcionando depois do rollback', !agenteRb.barrado);
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
