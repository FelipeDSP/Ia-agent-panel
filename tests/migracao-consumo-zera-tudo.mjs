/**
 * Migração 77 — o consumo conta de 21/09/2026 19:45 UTC (a 76 cortava à meia-noite).
 *
 * Não tem rollback (é irreversível de propósito), então o teste não replaya
 * rollback: ele ARRANJA linhas de dois lados do corte, em tenants criados aqui,
 * aplica a 76 duas vezes e mede:
 *   - linha ANTES do corte: tokens nulos, fonte 'zerado_76', linha viva
 *     (conteúdo intacto — é memória);
 *   - linha DEPOIS do corte: intocada;
 *   - `billing_consumo_mensal` não conta a linha zerada nem como real nem
 *     como estimada, e o custo dela é zero;
 *   - `uso_ingestao` anterior ao corte fica com tokens = 0 e a linha existe
 *     (chave de idempotência da ingestão);
 *   - o teto diário (`api_n8n_portao_mensagem`) não muda de comportamento.
 * Escopo: só as linhas dos tenants do teste são conferidas; a migração mexe
 * na tabela inteira, mas tudo roda em transação abortada.
 *
 *   npm run teste:migracao-consumo-zera-tudo
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M76 = leia('20260921194500_77_consumo_zera_tudo.sql');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
const CORTE = '2026-09-21T19:45:00Z';

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

try {
  console.log('\n== 0. Arranjo: dois tenants, linhas dos dois lados do corte ==\n');
  const T = {};
  for (const s of ['a', 'b']) T[s] = (await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-76-${s}`, `Teste 76 ${s}`])).id;
  const COMP = (fonte) => JSON.stringify({ fonte, chamadas: 1, entrada_cache: 400, wrapper: 10, system_prompt: 20, schema_tools: 30, mensagens: 40, memoria: 50, round_trip: 60 });
  // A: uma estimativa antiga (n8n) e um usage antigo; B: um usage antigo e um de hoje
  const ins = async (t, exec, fonte) => (await um(`select public.api_n8n_registrar_mensagem($1, 1, 'saida', 'conteudo-guardado', 5000, 100, 'gpt-4.1-mini', null, $2, $3::jsonb) id`, [t, exec, COMP(fonte)])).id;
  const aAntEst = await ins(T.a, 'a1', 'estimativa_nossa_com_multiplicidade');
  const aAntReal = await ins(T.a, 'a2', 'openai_usage');
  const bAntReal = await ins(T.b, 'b1', 'openai_usage');
  const bHoje = await ins(T.b, 'b2', 'openai_usage');
  // datas: antes do corte para três, depois para uma (o trigger de atualizado_em não toca criado_em)
  await c.query(`update public.mensagens_log set criado_em = $2 where id = any($1::uuid[])`, [[aAntEst, aAntReal, bAntReal], '2026-09-21T10:00:00Z']);
  // 23/09: a linha "depois do corte" e a de ingestao de hoje usam `now()`, nao
  // uma data literal. Escritas com '2026-09-21T12:00Z' elas eram "hoje" no dia
  // em que o teste nasceu e viraram passado em 48 h — o teto diario do portao
  // (`criado_em >= date_trunc('day', now())`) passou a somar zero e o teste
  // ficou vermelho sem defeito nenhum. O corte da migracao e fixo no arquivo;
  // `now()` esta sempre depois dele, hoje e daqui a um ano.
  await c.query(`update public.mensagens_log set criado_em = now() where id = $1`, [bHoje]);
  await c.query(`insert into public.uso_ingestao (tenant_id, modelo, tokens, criado_em) values ($1, 'text-embedding-3-small', 777, '2026-09-21T10:00:00Z'), ($1, 'text-embedding-3-small', 555, now())`, [T.a]);
  const tok = async (id) => await um(`select tokens_entrada te, tokens_saida ts, tokens_entrada_cache tc, tokens_wrapper tw, tokens_round_trip tr, fonte_tokens f, conteudo, modelo from public.mensagens_log where id=$1`, [id]);
  const antes = await tok(aAntEst);
  chk('contraprova: antes da 77 (linhas da MANHÃ de 21/09, que a 76 não tocava) a linha antiga TEM tokens (5000/100, cache 400, componentes)', antes.te === 5000 && antes.ts === 100 && antes.tc === 400 && antes.tw === 10 && antes.tr === 60 && /estimativa/.test(antes.f), JSON.stringify(antes));
  await c.query(`select set_config('request.jwt.claims', '{"app_metadata":{"papel":"super_admin"}}', true)`);
  const bill = async (t) => (await tudo(`select * from public.billing_consumo_mensal() where tenant_id = $1 order by mes`, [t]));
  const bA0 = await bill(T.a);
  chk('contraprova: billing conta a estimativa e o real antigos de A (1 real + 1 estimada, tokens > 0)', bA0.length === 1 && Number(bA0[0].mensagens_reais) === 1 && Number(bA0[0].mensagens_estimadas) === 1 && Number(bA0[0].tokens_entrada) === 10000, JSON.stringify(bA0));

  console.log('\n== 1. A 77, duas vezes ==\n');
  await c.query(semTx(M76));
  const md5Depois1 = (await um(`select md5(string_agg(coalesce(tokens_entrada::text,'-')||coalesce(fonte_tokens,'-'), ',' order by id)) h from public.mensagens_log where tenant_id = any($1::uuid[])`, [[T.a, T.b]])).h;
  await c.query(semTx(M76));
  chk('reexecutável: a segunda vez não muda nada nas linhas do teste', (await um(`select md5(string_agg(coalesce(tokens_entrada::text,'-')||coalesce(fonte_tokens,'-'), ',' order by id)) h from public.mensagens_log where tenant_id = any($1::uuid[])`, [[T.a, T.b]])).h === md5Depois1);
  for (const [nome, id] of [['A estimativa antiga', aAntEst], ['A usage antigo', aAntReal], ['B usage antigo', bAntReal]]) {
    const r = await tok(id);
    chk(`${nome}: todos os tokens nulos, fonte 'zerado_76'`, r.te === null && r.ts === null && r.tc === null && r.tw === null && r.tr === null && r.f === 'zerado_76', JSON.stringify(r));
    chk(`${nome}: a linha continua (memória): conteúdo e modelo intactos`, r.conteudo === 'conteudo-guardado' && r.modelo === 'gpt-4.1-mini');
  }
  const h = await tok(bHoje);
  chk('B depois do corte: intocada (5000/100, cache 400, openai_usage)', h.te === 5000 && h.ts === 100 && h.tc === 400 && h.f === 'openai_usage', JSON.stringify(h));

  console.log('\n== 2. O que a aba vê ==\n');
  const bA = await bill(T.a);
  chk('A (só linhas antigas): nenhuma mensagem real nem estimada, tokens 0, custo 0 — ou linha nenhuma', bA.every((l) => Number(l.mensagens_reais) === 0 && Number(l.mensagens_estimadas) === 0 && Number(l.tokens_entrada) === 0 && Number(l.custo_usd) === 0), JSON.stringify(bA));
  const bB = await bill(T.b);
  chk('B: setembro mostra SÓ a mensagem de hoje (1 real, 5000 de entrada, custo > 0)', bB.length === 1 && Number(bB[0].mensagens_reais) === 1 && Number(bB[0].mensagens_estimadas) === 0 && Number(bB[0].tokens_entrada) === 5000 && Number(bB[0].custo_usd) > 0, JSON.stringify(bB));
  const ing = await tudo(`select tokens, criado_em from public.uso_ingestao where tenant_id=$1 order by criado_em`, [T.a]);
  chk('uso_ingestao: a linha antiga fica (idempotência) com tokens 0; a de hoje mantém 555', ing.length === 2 && Number(ing[0].tokens) === 0 && Number(ing[1].tokens) === 555, JSON.stringify(ing));
  chk('embedding na aba de A: só o de hoje (555)', bA.length === 1 && Number(bA[0].tokens_embedding) === 555, JSON.stringify(bA));
  await c.query(`select set_config('request.jwt.claims', '', true)`);

  console.log('\n== 3. O teto diário não vê o passado (antes e depois iguais) ==\n');
  // O portão soma só criado_em >= hoje; a linha de hoje de B continua com 5100 tokens.
  const hoje = await um(`select coalesce(sum(coalesce(tokens_entrada,0)+coalesce(tokens_saida,0)),0)::int s from public.mensagens_log where tenant_id=$1 and criado_em >= date_trunc('day', now())`, [T.b]);
  chk('soma de hoje de B = 5100 (a 77 não tocou no que veio depois do corte)', hoje.s === 5100, String(hoje.s));
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
