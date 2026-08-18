#!/usr/bin/env node
/**
 * Migração 42 (decomposição dos tokens) numa TRANSAÇÃO ABORTADA contra
 * produção. Nada é gravado: o rollback no fim é incondicional.
 *
 * O QUE ELE PROVA, e ler o SQL não prova:
 *
 *   - que a chamada de 9 ARGUMENTOS — a que o workflow em produção faz HOJE —
 *     continua resolvendo depois da migração. É o que permite aplicar sem
 *     coordenar com o import do n8n. Se isto quebrar, toda mensagem de todo
 *     cliente para de ser registrada;
 *   - que existe EXATAMENTE UMA assinatura viva. Duas tornariam a chamada de 9
 *     argumentos ambígua — a armadilha das migrações 28, 32 e 37;
 *   - que `n8n_agent` consegue CHAMAR. Não que o ACL o contenha: chamar.
 *     `has_function_privilege` diz o que o ACL contém e só a chamada diz o que
 *     acontece. Esta função executava por PUBLIC até a 42; revogar de PUBLIC
 *     sem conceder explicitamente derrubaria o log em toda mensagem;
 *   - que `anon` e `authenticated` NÃO conseguem mais. É asserção negativa, e
 *     por isso vem com contraprova: o mesmo comando roda como `n8n_agent` e
 *     precisa passar. Sem isso, "anon não consegue" seria verdade também se a
 *     função não existisse;
 *   - que jsonb mal formado vira NULL e NÃO exceção. É o caminho quente: um
 *     campo de diagnóstico não pode derrubar a mensagem de um cliente real.
 *
 * A SABOTAGEM (seção 8) remove, uma por vez, as linhas da migração que
 * sustentam cada uma dessas propriedades, e exige que o teste reprove. Sem ela
 * este arquivo seria só uma lista de coisas que passaram.
 *
 * Uso: npm run teste:componentes-token
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const lim = (f) =>
  fs.readFileSync(RAIZ + 'supabase/migrations/' + f, 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

const ARQ_42 = '20260818120000_42_componentes_de_token.sql';
const ARQ_R42 = '20260818120000_42_componentes_de_token_rollback.sql';
const M42 = lim(ARQ_42);
const R42 = lim(ARQ_R42);

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

/** Roda em savepoint: erro esperado vira valor, não aborta a transação inteira. */
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

const TIPOS_10 = 'uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb';

const assinaturas = async () => (await c.query(
  `select p.pronargs::int n, pg_get_function_identity_arguments(p.oid) tipos
     from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'api_n8n_registrar_mensagem'
    order by n`)).rows;

/** ACL como conjunto de roles com EXECUTE — é o diff que pega grant perdido. */
const rolesComExecute = async () => {
  const { rows } = await c.query(
    `select coalesce(p.proacl::text[], array[]::text[]) acl
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = 'api_n8n_registrar_mensagem'`);
  const acl = rows[0]?.acl ?? [];
  // '=X/postgres' (PUBLIC) vem com o lado esquerdo vazio.
  return acl.map((e) => (e.split('=')[0] === '' ? 'PUBLIC' : e.split('=')[0])).sort();
};

/** Chama a função COMO outro role. A prova que `has_function_privilege` não dá. */
async function chamarComoRole(role, tenantId, conv, execucaoId, componentes = null, { comComponentes = true } = {}) {
  // `comComponentes: false` chama com 9 argumentos — a forma que existe DEPOIS
  // do rollback. Sem esta variante o teste de rollback acusaria 42883 (função
  // não existe) e pareceria grant perdido, que é defeito bem diferente.
  const sql = comComponentes
    ? `select public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, 'saida', 'via ' || $5, 10, 2, 'gpt', null::numeric, $3::text, $4::jsonb) v`
    // Sem o jsonb, `$4` deixa de aparecer no SQL: mandar cinco parâmetros faria
    // o Postgres reclamar de tipo indeterminado ($4 sem uso). Renumera.
    : `select public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, 'saida', 'via ' || $4, 10, 2, 'gpt', null::numeric, $3::text) v`;
  const params = comComponentes
    ? [tenantId, conv, execucaoId, componentes, role]
    : [tenantId, conv, execucaoId, role];
  await c.query('savepoint sp_role');
  try {
    await c.query(`set local role ${role}`);
    const r = await c.query(sql, params);
    await c.query('reset role');
    await c.query('release savepoint sp_role');
    return { erro: null, id: r.rows[0].v };
  } catch (e) {
    await c.query('rollback to savepoint sp_role');
    await c.query('reset role');
    return { erro: e.message, codigo: e.code, id: null };
  }
}

await c.connect();
await c.query('begin');

try {
  console.log('\n== Migração 42: componentes de token em mensagens_log ==\n');

  // Tenant próprio, criado aqui dentro e desfeito pelo rollback. Não resolve
  // seed por slug: ver docs/PENDENCIA-SEED-DOS-TESTES.md. O prefixo `zz-efem`
  // é o mesmo de tenants-efemeros.mjs, para que uma sobra (impossível numa
  // transação abortada, mas ainda assim) seja identificável.
  await c.query(`set local request.jwt.claims = '{"app_metadata":{"papel":"super_admin"}}'`);
  const slug = `zz-efem-comp42-${Math.random().toString(16).slice(2, 10)}`;
  const tenant = (await c.query(
    `insert into public.tenants (slug, nome, ativo) values ($1, $2, true) returning id`,
    [slug, 'efêmero componentes 42'])).rows[0]?.id;
  if (!tenant) throw new Error('não consegui criar o tenant efêmero');
  const CONV = 970042n;

  // -------------------------------------------------------------------------
  console.log('\n-- 1. ACL antes: o retrato que o drop vai apagar --\n');

  const aclAntes = await rolesComExecute();
  console.log(`  (antes) ${aclAntes.join(', ')}`);
  chk('o retrato do ACL foi capturado', aclAntes.length > 0, JSON.stringify(aclAntes));

  // AVISO, NÃO ASSERÇÃO — e a primeira versão errou justamente aqui.
  //
  // Estava escrito como `chk('antes da 42, n8n_agent NÃO tinha grant
  // explícito')`. Passou enquanto a 42 não tinha sido aplicada e ficou vermelho
  // no minuto seguinte ao apply, sem defeito nenhum: era afirmação sobre o
  // ESTADO DO MUNDO, e o estado mudou porque o sistema funcionou. É o defeito
  // que a CLAUDE.md descreve, escrito no mesmo dia em que a regra foi citada —
  // ler a regra não protege nem quem a escreve.
  //
  // A propriedade que este teste garante é sobre o DEPOIS, e está na seção 6:
  // seja qual for o ponto de partida, aplicar a 42 termina com n8n_agent e
  // service_role podendo chamar e mais ninguém. O antes é contexto para quem
  // depura, então vira linha informativa.
  const partiaDePublic = !aclAntes.includes('n8n_agent') && aclAntes.includes('PUBLIC');
  console.log(partiaDePublic
    ? '  aviso: partindo do estado PRÉ-42 (n8n_agent executava por PUBLIC)'
    : '  aviso: a 42 já está aplicada neste banco — o teste reaplica por cima, que é o esperado de migração reexecutável');

  // -------------------------------------------------------------------------
  console.log('\n-- 2. Aplicar --\n');

  const aplicou = await tentar(M42);
  chk('migração 42 aplica', aplicou.erro === null, `veio ${aplicou.erro}`);
  if (aplicou.erro) throw new Error('migração 42 não aplica');

  const sigs = await assinaturas();
  chk('exatamente 1 assinatura viva (senão a chamada de 9 args fica ambígua)',
    sigs.length === 1, JSON.stringify(sigs.map((s) => s.n)));
  chk('e é a de 10 argumentos', sigs[0]?.n === 10, `veio ${sigs[0]?.n}`);

  const colunas = (await c.query(
    `select column_name, is_nullable from information_schema.columns
      where table_schema='public' and table_name='mensagens_log'
        and column_name in ('tokens_wrapper','tokens_system_prompt','tokens_schema_tools',
                            'tokens_mensagens','tokens_memoria','tokens_round_trip',
                            'chamadas','fonte_tokens')`)).rows;
  chk('as 8 colunas existem', colunas.length === 8, `vieram ${colunas.length}`);
  chk('todas nullable (o histórico fica NULL, e isso é honesto)',
    colunas.every((x) => x.is_nullable === 'YES'),
    JSON.stringify(colunas.filter((x) => x.is_nullable !== 'YES')));

  // -------------------------------------------------------------------------
  console.log('\n-- 3. A chamada de HOJE continua funcionando --\n');

  const nove = await tentar(
    `select public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, 'saida', 'nove args', 1554, 31, 'gpt-4.1-mini', null::numeric, $3::text) v`,
    [tenant, CONV, 'exec-9args']);
  chk('a chamada de 9 argumentos (a que o n8n faz hoje) resolve',
    nove.erro === null && nove.rows[0]?.v, `veio ${nove.erro}`);
  const linha9 = (await c.query(
    `select tokens_entrada, tokens_wrapper, chamadas from public.mensagens_log where id = $1`,
    [nove.rows[0]?.v])).rows[0];
  chk('e grava o total como antes', linha9?.tokens_entrada === 1554, JSON.stringify(linha9));
  chk('com os componentes NULL (não inventa decomposição)',
    linha9?.tokens_wrapper === null && linha9?.chamadas === null, JSON.stringify(linha9));

  // -------------------------------------------------------------------------
  console.log('\n-- 4. A chamada nova grava a decomposição --\n');

  const COMP = {
    wrapper: 2424, system_prompt: 7850, schema_tools: 1244,
    mensagens: 120, memoria: 800, round_trip: 55,
    chamadas: 2, fonte: 'estimativa_nossa_com_multiplicidade',
  };
  const total = COMP.wrapper + COMP.system_prompt + COMP.schema_tools
              + COMP.mensagens + COMP.memoria + COMP.round_trip;

  const dez = await tentar(
    `select public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, 'saida', 'dez args', $4::int, 60, 'gpt-4.1-mini', null::numeric, $3::text, $5::jsonb) v`,
    [tenant, CONV, 'exec-10args', total, JSON.stringify(COMP)]);
  chk('a chamada de 10 argumentos resolve', dez.erro === null && dez.rows[0]?.v, `veio ${dez.erro}`);

  const l = (await c.query(
    `select tokens_entrada, tokens_wrapper, tokens_system_prompt, tokens_schema_tools,
            tokens_mensagens, tokens_memoria, tokens_round_trip, chamadas, fonte_tokens
       from public.mensagens_log where id = $1`, [dez.rows[0]?.v])).rows[0];

  chk('wrapper gravado', l?.tokens_wrapper === COMP.wrapper, JSON.stringify(l));
  chk('system_prompt gravado', l?.tokens_system_prompt === COMP.system_prompt);
  chk('schema_tools gravado', l?.tokens_schema_tools === COMP.schema_tools);
  chk('mensagens gravado', l?.tokens_mensagens === COMP.mensagens);
  chk('memoria gravado', l?.tokens_memoria === COMP.memoria);
  chk('round_trip gravado', l?.tokens_round_trip === COMP.round_trip);
  chk('chamadas gravado', l?.chamadas === COMP.chamadas);
  chk('fonte gravada, e diz que NÃO é a fatura',
    l?.fonte_tokens === COMP.fonte && !/api|fatura|real/i.test(l?.fonte_tokens ?? ''),
    String(l?.fonte_tokens));
  // A invariante que o rateio vai usar. Não é imposta pela função de propósito
  // (levantar exceção aqui derrubaria a mensagem do cliente por aritmética);
  // é imposta aqui.
  const soma = l.tokens_wrapper + l.tokens_system_prompt + l.tokens_schema_tools
             + l.tokens_mensagens + l.tokens_memoria + l.tokens_round_trip;
  chk('os componentes somam o total gravado', soma === l.tokens_entrada,
    `soma ${soma} vs total ${l.tokens_entrada}`);

  // Nenhuma classificação foi gravada: a regra entra na query, quando houver.
  const colsRegra = (await c.query(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='mensagens_log'
        and (column_name ilike '%cliente%' or column_name ilike '%agencia%'
             or column_name ilike '%rateio%' or column_name ilike '%cobrav%')`)).rows;
  chk('a gravação é só gravação: nenhuma coluna de rateio foi criada',
    colsRegra.length === 0, JSON.stringify(colsRegra));

  // -------------------------------------------------------------------------
  console.log('\n-- 5. jsonb mal formado vira NULL, nunca exceção --\n');

  const casos = [
    ['string onde devia ser número', '{"wrapper":"muito","chamadas":2}'],
    ['chave ausente', '{"chamadas":1}'],
    ['objeto aninhado no lugar do número', '{"wrapper":{"a":1}}'],
    ['jsonb nulo', null],
    ['decimal (arredonda, não estoura)', '{"wrapper":5759.4}'],
  ];
  for (const [nome, payload] of casos) {
    const r = await tentar(
      `select public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, 'saida', $4, 10, 2, 'gpt', null::numeric, $3::text, $5::jsonb) v`,
      [tenant, CONV, `exec-mal-${nome.slice(0, 6)}`, nome, payload]);
    chk(`${nome}: não estoura`, r.erro === null, `veio ${r.codigo} ${r.erro}`);
  }
  const decimal = (await c.query(
    `select tokens_wrapper from public.mensagens_log where execucao_id like 'exec-mal-decima%'`)).rows[0];
  chk('o decimal virou inteiro (5759.4 -> 5759)', decimal?.tokens_wrapper === 5759, JSON.stringify(decimal));

  // -------------------------------------------------------------------------
  console.log('\n-- 6. Grants: quem pode CHAMAR (não quem está no ACL) --\n');

  const aclDepois = await rolesComExecute();
  console.log(`  (depois) ${aclDepois.join(', ')}`);
  chk('n8n_agent entrou no ACL', aclDepois.includes('n8n_agent'), JSON.stringify(aclDepois));
  chk('service_role continua no ACL', aclDepois.includes('service_role'), JSON.stringify(aclDepois));
  chk('PUBLIC saiu', !aclDepois.includes('PUBLIC'), JSON.stringify(aclDepois));
  chk('anon saiu', !aclDepois.includes('anon'), JSON.stringify(aclDepois));
  chk('authenticated saiu', !aclDepois.includes('authenticated'), JSON.stringify(aclDepois));

  // A PROVA. Chamada de verdade, como o agente conecta.
  const comoN8n = await chamarComoRole('n8n_agent', tenant, CONV, 'exec-como-n8n', JSON.stringify(COMP));
  chk('n8n_agent CHAMA de verdade (não só tem privilégio no catálogo)',
    comoN8n.erro === null && comoN8n.id, `veio ${comoN8n.codigo} ${comoN8n.erro}`);

  // Contraprova da asserção negativa: o mesmo comando, outro role.
  for (const role of ['anon', 'authenticated']) {
    const r = await chamarComoRole(role, tenant, CONV, `exec-como-${role}`);
    chk(`${role} NÃO chama mais (a mesma chamada que n8n_agent faz)`,
      r.erro !== null && r.codigo === '42501', `veio ${r.codigo} ${r.erro}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n-- 7. Idempotência da 37 preservada --\n');

  const p1 = await tentar(
    `select public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, 'saida', 'repetida', 100, 5, 'gpt', null::numeric, $3::text, $4::jsonb) v`,
    [tenant, CONV, 'exec-repetida', JSON.stringify(COMP)]);
  const p2 = await tentar(
    `select public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, 'saida', 'repetida', 100, 5, 'gpt', null::numeric, $3::text, $4::jsonb) v`,
    [tenant, CONV, 'exec-repetida', JSON.stringify(COMP)]);
  chk('a segunda chamada devolve o MESMO id', p1.rows[0]?.v && p1.rows[0].v === p2.rows[0]?.v,
    `${p1.rows[0]?.v} vs ${p2.rows[0]?.v}`);
  const quantas = (await c.query(
    `select count(*)::int n from public.mensagens_log where tenant_id=$1 and execucao_id='exec-repetida'`,
    [tenant])).rows[0].n;
  chk('e não duplicou a linha (um turno cobra uma vez)', quantas === 1, `vieram ${quantas}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 8. Sabotagem: cada propriedade tem uma linha que a sustenta --\n');

  const sabotagens = [
    ['sem o grant a n8n_agent', (sql) => sql.replace(
      /grant execute on function public\.api_n8n_registrar_mensagem\(\s*uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb\s*\) to n8n_agent;/, ''),
      async () => (await chamarComoRole('n8n_agent', tenant, CONV, 'sab-n8n')).erro !== null,
      'n8n_agent deixa de chamar'],
    ['sem o revoke de PUBLIC', (sql) => sql.replace(
      /revoke all on function public\.api_n8n_registrar_mensagem\(\s*uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb\s*\) from public;/, ''),
      async () => (await rolesComExecute()).includes('PUBLIC'),
      'PUBLIC continua no ACL'],
    ['sem o drop da assinatura antiga', (sql) => sql.replace(
      /drop function if exists public\.api_n8n_registrar_mensagem\([^)]*\);/, ''),
      async () => (await assinaturas()).length > 1,
      'duas assinaturas vivas'],
    ['com cast direto no lugar de n8n_json_int', (sql) => sql.replace(
      /public\.n8n_json_int\(p_componentes, 'wrapper'\)/, "(p_componentes->>'wrapper')::integer"),
      async () => {
        const r = await tentar(
          `select public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, 'saida', 'x', 1, 1, 'g', null::numeric, $3::text, '{"wrapper":"muito"}'::jsonb) v`,
          [tenant, CONV, 'sab-cast']);
        return r.erro !== null;
      },
      'jsonb mal formado passa a estourar'],
  ];

  let semEfeito = 0;
  for (const [nome, mutar, detecta, oQue] of sabotagens) {
    const sql = mutar(M42);
    if (sql === M42) {
      semEfeito++;
      chk(`sabotagem "${nome}" MUTOU o SQL`, false, 'o replace não casou — a sabotagem não testou nada');
      continue;
    }
    await c.query('savepoint sp_sab');
    // O rollback vem antes para a sabotagem partir do estado pré-42, senão ela
    // reaplicaria por cima da versão correta e não mudaria nada.
    await tentar(R42);
    const ap = await tentar(sql);
    const pegou = ap.erro !== null ? true : await detecta();
    chk(`sabotagem "${nome}" é detectada (${oQue})`, pegou,
      ap.erro ? `aplicou com erro: ${ap.erro}` : 'aplicou limpa e nada mudou');
    await c.query('rollback to savepoint sp_sab');
  }
  chk('toda sabotagem realmente mutou o arquivo', semEfeito === 0, `${semEfeito} não mutaram`);

  // O estado voltou ao da 42 correta? (o rollback to savepoint desfez as sabotagens)
  chk('depois das sabotagens, o ACL é o da 42 correta',
    (await rolesComExecute()).includes('n8n_agent'), JSON.stringify(await rolesComExecute()));

  // -------------------------------------------------------------------------
  console.log('\n-- 9. Rollback --\n');

  const rb = await tentar(R42);
  chk('rollback aplica', rb.erro === null, `veio ${rb.erro}`);
  const sigsRb = await assinaturas();
  chk('volta a exatamente 1 assinatura, de 9 argumentos',
    sigsRb.length === 1 && sigsRb[0]?.n === 9, JSON.stringify(sigsRb.map((s) => s.n)));
  const colsRb = (await c.query(
    `select count(*)::int n from information_schema.columns
      where table_schema='public' and table_name='mensagens_log'
        and column_name in ('tokens_wrapper','chamadas','fonte_tokens')`)).rows[0].n;
  chk('as colunas somem', colsRb === 0, `sobraram ${colsRb}`);
  const helperRb = (await c.query(
    `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='n8n_json_int'`)).rows[0].n;
  chk('o helper some', helperRb === 0, `sobraram ${helperRb}`);
  const rbN8n = await chamarComoRole('n8n_agent', tenant, CONV, 'exec-rb-n8n', null, { comComponentes: false });
  chk('e o agente continua chamando depois do rollback (9 argumentos)',
    rbN8n.erro === null, `veio ${rbN8n.codigo} ${rbN8n.erro}`);
  // O rollback restaura o ACL de antes, PUBLIC inclusive — é o que rollback
  // significa. A asserção existe para isso ser uma escolha visível, e não uma
  // surpresa no dia em que alguém rolar para trás.
  const aclRb = await rolesComExecute();
  chk('e o ACL volta ao estado anterior (PUBLIC de volta, deliberado)',
    aclRb.includes('PUBLIC') && aclRb.includes('n8n_agent'), JSON.stringify(aclRb));
} catch (e) {
  // Rejeição inesperada vira FALHA, não crash: sem isto o resumo não sai e você
  // fica sem saber quantas propriedades passaram antes de quebrar.
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
