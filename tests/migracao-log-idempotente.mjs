#!/usr/bin/env node
/**
 * Migração 37 (um turno cobra uma vez) numa TRANSAÇÃO ABORTADA contra produção.
 * Nada é gravado: o rollback no fim é incondicional.
 *
 * O QUE ELE PROVA, e ler o SQL não prova:
 *
 *   - que a função ficou IDEMPOTENTE de verdade, não só "não duplica". A segunda
 *     chamada devolve o MESMO id da primeira. Se devolvesse null, o nó Postgres
 *     do n8n leria como falha e a execução ficaria vermelha sem nada errado;
 *   - que a chamada ANTIGA de 8 argumentos continua funcionando e se comportando
 *     como hoje. É isso que torna seguro aplicar a migração antes de mexer no
 *     n8n — e é a metade da compatibilidade que ninguém testa e todo mundo assume;
 *   - que sobrou UMA assinatura. `create or replace` com parâmetro novo deixaria
 *     as duas vivas e a chamada de 8 viraria ambígua (42725) — em runtime, no
 *     primeiro cliente. Terceira vez que a armadilha aparece (28, 32, 37);
 *   - que a chave não é larga demais: mesma conversa, mesmo conteúdo, execução
 *     diferente continua sendo duas cobranças. O cliente repete pergunta.
 *
 * PROPRIEDADE, NÃO ESTADO DO MUNDO. Não afirma "mensagens_log tem 70 linhas" —
 * fica falso na próxima mensagem, que é operação normal. Afirma que aplicar a
 * migração não mexe no que já existe e que o retry não move contagem nem soma.
 *
 * Uso: npm run teste:log-idempotente
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const lim = (f) =>
  fs.readFileSync(RAIZ + 'supabase/migrations/' + f, 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

const M37 = lim('20260814150100_37_mensagens_log_execucao.sql');
const R37 = lim('20260814150100_37_mensagens_log_execucao_rollback.sql');

if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) {
    ok++;
    console.log(`  OK    ${nome}`);
  } else {
    falhas.push(`${nome}${det ? ' — ' + det : ''}`);
    console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`);
  }
};

async function tentar(sql, params = []) {
  await c.query('savepoint sp');
  try {
    const r = await c.query(sql, params);
    await c.query('release savepoint sp');
    return { erro: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sp');
    if (e.detail) console.log(`        (${e.code}) ${e.detail}`);
    return { erro: e.code || 'erro', rows: [] };
  }
}

const CONV = 995001n;
const EXEC_A = 'exec-teste-3966582';
const EXEC_B = 'exec-teste-3966583';

/** Chamada de 9 argumentos (o n8n depois do ajuste). */
const reg9 = (tenant, direcao, conteudo, execucao) =>
  tentar(
    `select public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, $3::text, $4::text, 10, 5, 'gpt-4.1-mini', null, $5::text) as id`,
    [tenant, CONV, direcao, conteudo, execucao],
  );

/** Chamada de 8 argumentos (o n8n de hoje, antes de mexer no nó). */
const reg8 = (tenant, direcao, conteudo) =>
  tentar(
    `select public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, $3::text, $4::text, 10, 5, 'gpt-4.1-mini', null) as id`,
    [tenant, CONV, direcao, conteudo],
  );

const contar = async (extra = '') =>
  (
    await c.query(
      `select count(*)::int n, coalesce(sum(tokens_entrada),0)::int te, coalesce(sum(tokens_saida),0)::int ts
         from public.mensagens_log ${extra}`,
    )
  ).rows[0];

const daConversa = () => contar(`where conversation_id = ${CONV}`);

const assinaturas = async () =>
  (
    await c.query(
      `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and p.proname = 'api_n8n_registrar_mensagem'`,
    )
  ).rows[0].n;

await c.connect();
await c.query('begin');

try {
  console.log('\n== Migração 37: um turno cobra uma vez ==\n');

  const tenant = (await c.query(`select id from public.tenants where slug = 'restaurante-teste'`)).rows[0]?.id;
  if (!tenant) throw new Error('tenant restaurante-teste nao encontrado');

  // -------------------------------------------------------------------------
  console.log('\n-- 1. Aplicar não mexe no que já existe --\n');

  const antes = await contar();
  // A coluna pode não existir ainda (primeira aplicação) — nesse caso, zero.
  const comChave = async () => {
    const r = await tentar(
      `select count(*)::int n from public.mensagens_log where execucao_id is not null`,
    );
    return r.erro ? 0 : r.rows[0].n;
  };
  const comChaveAntes = await comChave();

  const aplicou = await tentar(M37);
  chk('migração aplica', aplicou.erro === null, `veio ${aplicou.erro}`);
  if (aplicou.erro) throw new Error('migração 37 não aplica');

  const depois = await contar();
  const comChaveDepois = await comChave();
  chk('contagem de linhas não muda', antes.n === depois.n, `${antes.n} -> ${depois.n}`);
  chk(
    'soma de tokens não muda',
    antes.te === depois.te && antes.ts === depois.ts,
    `${antes.te}/${antes.ts} -> ${depois.te}/${depois.ts}`,
  );
  // PROPRIEDADE, não estado do mundo.
  //
  // A primeira versão afirmava "nenhuma linha tem execucao_id". Era verdade no
  // minuto em que foi escrita e ficou FALSA quatro horas depois — porque a
  // migração entrou em produção e o n8n passou a gravar a chave, que é
  // exatamente o que se queria. Teste que fica vermelho porque o sistema
  // funcionou treina todo mundo a ignorar vermelho.
  //
  // O que a migração promete é não INVENTAR chave para linha que não tinha:
  // a contagem de linhas com execucao_id não muda ao aplicar, qualquer que ela
  // seja hoje.
  chk(
    'aplicar não preenche execucao_id em linha nenhuma (sem backfill inventado)',
    comChaveAntes === comChaveDepois,
    `antes ${comChaveAntes}, depois ${comChaveDepois}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n-- 2. Só uma assinatura viva --\n');

  chk('sobrou exatamente 1 assinatura', (await assinaturas()) === 1, `veio ${await assinaturas()}`);

  // A prova de que a de 8 não ficou viva: se tivesse, a chamada de 8 argumentos
  // não resolveria para a nova por default — daria 42725 (is not unique).
  const oito = await reg8(tenant, 'entrada', '{"chamada antiga"}');
  chk('chamada de 8 argumentos ainda funciona', oito.erro === null, `veio ${oito.erro}`);
  chk('e devolve um id', Boolean(oito.rows[0]?.id), JSON.stringify(oito.rows[0]));

  // Sem chave, o comportamento tem de ser o de hoje: duas chamadas, duas linhas.
  const oito2 = await reg8(tenant, 'entrada', '{"chamada antiga"}');
  chk(
    'sem execucao_id, duas chamadas geram DUAS linhas (comportamento de hoje preservado)',
    oito2.erro === null && (await daConversa()).n === 2,
    `veio ${(await daConversa()).n}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n-- 3. O mesmo turno não cobra duas vezes --\n');

  const p1 = await reg9(tenant, 'entrada', '{"vocês entregam?"}', EXEC_A);
  chk('primeira chamada do turno grava', p1.erro === null && Boolean(p1.rows[0]?.id), JSON.stringify(p1));

  const p2 = await reg9(tenant, 'entrada', '{"vocês entregam?"}', EXEC_A);
  chk('retry não estoura', p2.erro === null, `veio ${p2.erro}`);
  chk(
    'retry devolve o MESMO id (idempotente, não só "não duplica")',
    p2.rows[0]?.id === p1.rows[0]?.id,
    `${p1.rows[0]?.id} vs ${p2.rows[0]?.id}`,
  );

  const depoisRetry = await daConversa();
  chk('retry não cria linha', depoisRetry.n === 3, `veio ${depoisRetry.n}`);
  chk(
    'e não soma token — o dinheiro fica igual',
    depoisRetry.te === 30 && depoisRetry.ts === 15,
    `${depoisRetry.te}/${depoisRetry.ts}`,
  );

  // O par do turno: mesma execução, direção diferente. As duas linhas convivem.
  const saida = await reg9(tenant, 'saida', 'Sim, entregamos!', EXEC_A);
  chk('mesma execução, direção diferente, grava', saida.erro === null, `veio ${saida.erro}`);
  chk('o par entrada+saida existe', (await daConversa()).n === 4, `veio ${(await daConversa()).n}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 4. A chave não é larga demais --\n');

  // Conteúdo IDÊNTICO, conversa idêntica, execução diferente. O cliente repete
  // pergunta — em produção `"vocês entregam?"` aparece duas vezes com 18 min de
  // intervalo. São dois turnos, duas chamadas à OpenAI, duas cobranças.
  const outra = await reg9(tenant, 'entrada', '{"vocês entregam?"}', EXEC_B);
  chk('execução DIFERENTE com conteúdo idêntico NÃO é recusada', outra.erro === null, `veio ${outra.erro}`);
  chk('e cobra de verdade', (await daConversa()).n === 5, `veio ${(await daConversa()).n}`);
  chk(
    'com id próprio, não o da primeira',
    outra.rows[0]?.id !== p1.rows[0]?.id,
    `${outra.rows[0]?.id} vs ${p1.rows[0]?.id}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n-- 5. Rollback --\n');

  const rb = await tentar(R37);
  chk('rollback aplica', rb.erro === null, `veio ${rb.erro}`);
  chk('a coluna some', (
    await c.query(
      `select count(*)::int n from information_schema.columns
        where table_name='mensagens_log' and column_name='execucao_id'`,
    )
  ).rows[0].n === 0);
  chk('o índice some', (
    await c.query(`select count(*)::int n from pg_indexes where indexname='uq_mensagens_log_execucao'`)
  ).rows[0].n === 0);
  chk('continua com 1 assinatura só (a de 8)', (await assinaturas()) === 1, `veio ${await assinaturas()}`);

  const depoisRb = await reg8(tenant, 'entrada', '{"pos rollback"}');
  chk('e o n8n de 8 argumentos volta a funcionar', depoisRb.erro === null, `veio ${depoisRb.erro}`);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log('\n' + '-'.repeat(60));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();

process.exitCode = falhas.length > 0 ? 1 : 0;
