#!/usr/bin/env node
/**
 * Migração 36 (billing da ingestão cobra uma vez por job) numa TRANSAÇÃO
 * ABORTADA contra produção. Nada é gravado: o rollback no fim é incondicional.
 *
 * O QUE ELE PROVA, e ler o SQL não prova:
 *
 *   - que o banco RECUSA a segunda cobrança do mesmo job mesmo quando quem
 *     escreve não pede licença. O `on conflict do nothing` da Edge Function é a
 *     primeira camada; se ele fosse a única, qualquer SQL avulso ou uma segunda
 *     versão da função voltaria a duplicar. O índice é a autoridade;
 *   - que a chave NÃO é larga demais. Dois jobs diferentes do mesmo tenant, com
 *     o mesmo modelo e a mesma contagem de tokens, continuam sendo duas
 *     cobranças — porque a OpenAI foi chamada duas vezes. É exatamente o caso
 *     das 2 linhas que existem hoje em produção. Chave larga não evita cobrança
 *     a mais: produz cobrança a menos, e ninguém reclama de fatura baixa;
 *   - que o DINHEIRO, e não só a contagem de linhas, fica igual. Um teste que
 *     só contasse linhas passaria com um `do update` que dobrasse `tokens`.
 *
 * PROPRIEDADE, NÃO ESTADO DO MUNDO. Não afirma "uso_ingestao tem 2 linhas" —
 * isso fica falso na próxima ingestão, que é operação normal. Afirma que aplicar
 * a migração não mexe no que já existe (contagem e soma antes × depois), e que
 * a segunda tentativa do mesmo job não move nenhum dos dois.
 *
 * Uso: node --env-file=.env.local tests/migracao-billing-idempotente.mjs
 *      (npm run teste:billing-idempotente)
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));

const lim = (f) =>
  fs.readFileSync(RAIZ + 'supabase/migrations/' + f, 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

const M36 = lim('20260814150000_36_uso_ingestao_idempotente.sql');
const R36 = lim('20260814150000_36_uso_ingestao_idempotente_rollback.sql');

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

/**
 * Roda o SQL num savepoint; devolve o SQLSTATE se estourar, null se passou.
 *
 * Imprime o `detail` do Postgres quando há erro. É onde mora a informação útil
 * ("Key (job_id)=(...) already exists"), tanto no caminho em que o erro é
 * esperado quanto no em que ele é a falha — e é exatamente o que um stack trace
 * de crash joga fora.
 */
async function esperaErro(sql, params = []) {
  await c.query('savepoint sp');
  try {
    await c.query(sql, params);
    await c.query('release savepoint sp');
    return null;
  } catch (e) {
    await c.query('rollback to savepoint sp');
    if (e.detail) console.log(`        (${e.code}) ${e.detail}`);
    return e.code || 'erro';
  }
}

// Tenant sintético: `uso_ingestao.tenant_id` não tem FK (confirmado em
// pg_constraint), e um id que não existe garante que as contagens do teste não
// se misturem com dado real. A transação aborta de qualquer forma.
const TENANT = '00000000-0000-4000-8000-0000f36f36f3';
const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '22222222-2222-4222-8222-222222222222';

const contar = async (extra = '') =>
  (await c.query(`select count(*)::int n, coalesce(sum(tokens),0)::int soma from public.uso_ingestao ${extra}`))
    .rows[0];

const doTenant = () => contar(`where tenant_id = '${TENANT}'`);

const inserir = (job, tokens) =>
  c.query(
    `insert into public.uso_ingestao (tenant_id, modelo, tokens, job_id)
     values ($1, 'text-embedding-3-small', $2, $3)`,
    [TENANT, tokens, job],
  );

await c.connect();
await c.query('begin');

try {
  console.log('\n== Migração 36: um job de ingestão cobra uma vez ==\n');

  // -------------------------------------------------------------------------
  console.log('\n-- 1. Aplicar a migração não mexe no que já existe --\n');

  const antes = await contar();

  // O `create unique index` só sobe se o dado que JÁ existe respeitar a chave.
  // Se produção tivesse duas cobranças do mesmo job, ele estouraria 23505 aqui —
  // e isso é o aviso certo, não um verde enganoso. Reportado como FALHA em vez
  // de crash: a mensagem do Postgres diz qual valor duplicou, e essa informação
  // se perde num stack trace.
  const naoAplicou = await esperaErro(M36);
  chk('migração aplica sobre o dado que já existe', naoAplicou === null, `veio ${naoAplicou}`);
  if (naoAplicou) throw new Error(`migração 36 não aplica: ${naoAplicou} — veja o detalhe acima`);

  const depois = await contar();

  chk(
    'contagem de linhas não muda',
    antes.n === depois.n,
    `antes ${antes.n}, depois ${depois.n}`,
  );
  chk(
    'soma de tokens já cobrados não muda',
    antes.soma === depois.soma,
    `antes ${antes.soma}, depois ${depois.soma}`,
  );

  // O índice só sobe se os dados existentes já respeitarem a chave. Se produção
  // tivesse duplicata, o `create unique index` acima teria estourado 23505 e o
  // teste morreria aqui — que é o aviso certo, e não um verde enganoso.
  chk(
    'índice existe depois da migração',
    (
      await c.query(
        `select 1 from pg_indexes where schemaname='public' and indexname='uq_uso_ingestao_job'`,
      )
    ).rowCount === 1,
  );

  // -------------------------------------------------------------------------
  console.log('\n-- 2. O mesmo job não cobra duas vezes --\n');

  await inserir(JOB_A, 10333);
  const umaVez = await doTenant();
  chk('primeira cobrança entra', umaVez.n === 1 && umaVez.soma === 10333, JSON.stringify(umaVez));

  // (a) O caminho da Edge Function: pede licença, é ignorado em silêncio.
  //
  // `on conflict (job_id)` EXIGE que exista índice único em `job_id` — sem ele o
  // Postgres recusa a própria sintaxe com 42P10. Então esta asserção também é a
  // que prova que a Edge Function não está pedindo licença a uma chave
  // inexistente e se achando idempotente.
  const recusouIgnorar = await esperaErro(
    `insert into public.uso_ingestao (tenant_id, modelo, tokens, job_id)
     values ($1, 'text-embedding-3-small', 10333, $2)
     on conflict (job_id) do nothing`,
    [TENANT, JOB_A],
  );
  chk(
    'o ON CONFLICT da Edge Function tem chave para casar',
    recusouIgnorar === null,
    `veio ${recusouIgnorar}`,
  );
  const depoisDoRetry = await doTenant();
  chk(
    'segunda tentativa do mesmo job não cria linha',
    depoisDoRetry.n === 1,
    `veio ${depoisDoRetry.n}`,
  );
  chk(
    'e não soma tokens — o dinheiro fica igual',
    depoisDoRetry.soma === 10333,
    `veio ${depoisDoRetry.soma}`,
  );

  // (b) O caminho de quem NÃO pede licença: SQL avulso, script de correção, uma
  // segunda versão da função. O banco recusa. É isto que faz do índice a
  // autoridade em vez de uma sugestão que a aplicação escolhe seguir.
  const erro = await esperaErro(
    `insert into public.uso_ingestao (tenant_id, modelo, tokens, job_id)
     values ($1, 'text-embedding-3-small', 10333, $2)`,
    [TENANT, JOB_A],
  );
  chk('insert puro do mesmo job é REJEITADO pelo banco', erro === '23505', `veio ${erro}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 3. A chave não é larga demais --\n');

  // Mesmo tenant, mesmo modelo, MESMA contagem de tokens, job diferente: são as
  // 2 linhas que produção tem hoje (mesmo documento reindexado em 30/07 e
  // 04/08). Duas chamadas à OpenAI, duas cobranças corretas.
  //
  // POR QUE `esperaErro` NUM CAMINHO QUE DEVE PASSAR. Uma chave larga demais faz
  // este insert ser REJEITADO, e um `await` cru derrubaria o processo — o teste
  // morreria em vez de dizer qual propriedade quebrou. Descoberto sabotando: a
  // primeira versão travava aqui e a asserção abaixo nunca rodava.
  const recusouJobNovo = await esperaErro(
    `insert into public.uso_ingestao (tenant_id, modelo, tokens, job_id)
     values ($1, 'text-embedding-3-small', 10333, $2)`,
    [TENANT, JOB_B],
  );
  chk(
    'job DIFERENTE com tokens idênticos NÃO é recusado',
    recusouJobNovo === null,
    `a chave é larga demais — recusou com ${recusouJobNovo}`,
  );
  const doisJobs = await doTenant();
  chk(
    'e ele cobra de verdade: 2 linhas, soma dobrada',
    doisJobs.n === 2 && doisJobs.soma === 20666,
    JSON.stringify(doisJobs),
  );

  // `job_id` é nullable e segue assim. No Postgres, NULLs são distintos entre si
  // num índice único, e é o que se quer: "sem job" não identifica cobrança
  // nenhuma, então duas linhas sem job não são a mesma cobrança.
  const nulo1 = await esperaErro(
    `insert into public.uso_ingestao (tenant_id, modelo, tokens, job_id)
     values ($1, 'text-embedding-3-small', 7, null)`,
    [TENANT],
  );
  const nulo2 = await esperaErro(
    `insert into public.uso_ingestao (tenant_id, modelo, tokens, job_id)
     values ($1, 'text-embedding-3-small', 7, null)`,
    [TENANT],
  );
  const comNulos = await doTenant();
  chk(
    'duas linhas sem job_id convivem (NULLs distintos)',
    nulo1 === null && nulo2 === null && comNulos.n === 4,
    `erros ${nulo1}/${nulo2}, linhas ${comNulos.n}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n-- 4. O rollback devolve o estado anterior --\n');

  await c.query(R36);
  chk(
    'índice some',
    (
      await c.query(
        `select 1 from pg_indexes where schemaname='public' and indexname='uq_uso_ingestao_job'`,
      )
    ).rowCount === 0,
  );

  // E a duplicata volta a ser possível — o rollback devolve o problema junto,
  // que é o que "reverter" quer dizer. Se isto falhasse, o drop não teria
  // funcionado e o rollback estaria mentindo.
  const semIndice = await esperaErro(
    `insert into public.uso_ingestao (tenant_id, modelo, tokens, job_id)
     values ($1, 'text-embedding-3-small', 10333, $2)`,
    [TENANT, JOB_A],
  );
  chk('sem o índice, o insert duplicado passa de novo', semIndice === null, `veio ${semIndice}`);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log('\n' + '-'.repeat(60));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();

process.exitCode = falhas.length > 0 ? 1 : 0;
