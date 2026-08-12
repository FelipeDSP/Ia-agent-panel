#!/usr/bin/env node
/**
 * Migrações 31 e 32 (áudio) aplicadas e revertidas numa TRANSAÇÃO ABORTADA
 * contra produção. Nada é gravado: o rollback no fim é incondicional.
 *
 * Mesmo método do `tests/migracao-vendas.mjs`. O que ele prova, e que ler o SQL
 * não prova: que a 32 não deixa DUAS assinaturas de `api_n8n_registrar_mensagem`
 * vivas — com DEFAULT no último parâmetro isso tornaria AMBÍGUA a chamada de 7
 * argumentos, que é exatamente a que o n8n faz hoje. Foi a armadilha que a
 * migração 28 criou com `fechar_pedido`.
 *
 * Toda checagem que ESPERA erro roda dentro de savepoint: no Postgres um erro
 * aborta a transação inteira, e sem savepoint o primeiro erro esperado derruba
 * todo o resto do teste.
 *
 * Uso: node tests/migracao-audio.mjs   (npm run teste:migracao-audio)
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { carregarEnv } from '../scripts/lib/env.mjs';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
carregarEnv();

const lim = (f) =>
  fs.readFileSync(RAIZ + 'supabase/migrations/' + f, 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

const M31 = lim('20260812183730_31_catalogo_tools_tipo.sql');
const R31 = lim('20260812183730_31_catalogo_tools_tipo_rollback.sql');
const M32 = lim('20260812183756_32_mensagens_log_audio_segundos.sql');
const R32 = lim('20260812183756_32_mensagens_log_audio_segundos_rollback.sql');

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

// Roda algo que DEVE falhar, sem derrubar a transação.
async function esperaErro(sql, params = []) {
  await c.query('savepoint sp');
  try {
    await c.query(sql, params);
    await c.query('release savepoint sp');
    return null;
  } catch (e) {
    await c.query('rollback to savepoint sp');
    return e.code || 'erro';
  }
}

await c.connect();
await c.query('begin');

try {
  console.log('\n== Migrações 31 e 32 ==\n');
  console.log('  -- 31: tipo em catalogo_tools --');
  await c.query(M31);

  const tipos = (await c.query('select tool_nome, tipo from public.catalogo_tools order by tool_nome')).rows;
  chk('transcricao_audio existe como capacidade_fluxo',
    tipos.find((t) => t.tool_nome === 'transcricao_audio')?.tipo === 'capacidade_fluxo');
  chk('as 4 tools antigas continuam tool_modelo',
    tipos.filter((t) => t.tool_nome !== 'transcricao_audio').every((t) => t.tipo === 'tool_modelo'),
    JSON.stringify(tipos.map((t) => `${t.tool_nome}:${t.tipo}`)));

  const erroTipo = await esperaErro(
    "insert into public.catalogo_tools (tool_nome, nome_exibicao, tipo) values ('x','X','invalido')");
  chk('CHECK recusa tipo fora do domínio', erroTipo === '23514', String(erroTipo));

  await c.query(M31);
  chk('31 é reaplicável (idempotente)', true);

  // A capacidade nova NÃO pode entrar em TOOLS_BASELINE por acidente: novo tenant
  // não deve nascer com áudio contratado.
  const contratados = (await c.query(
    "select count(*)::int n from public.tenant_tools where tool_nome='transcricao_audio' and contratado")).rows[0].n;
  chk('nenhum tenant já nasce com áudio contratado', contratados === 0, `${contratados}`);

  console.log('\n  -- 32: audio_segundos em mensagens_log --');
  await c.query(M32);

  const cols = (await c.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='mensagens_log'")
  ).rows.map((r) => r.column_name);
  chk('coluna audio_segundos existe', cols.includes('audio_segundos'));

  const assinaturas = (await c.query(`
    select pg_get_function_identity_arguments(p.oid) a from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='api_n8n_registrar_mensagem'`)).rows;
  chk('UMA assinatura só — sem overload ambíguo', assinaturas.length === 1,
    JSON.stringify(assinaturas.map((x) => x.a)));

  const t = (await c.query("select id from public.tenants where slug='restaurante-teste'")).rows[0];

  const id7 = (await c.query(
    'select public.api_n8n_registrar_mensagem($1,$2,$3,$4,$5,$6,$7) v',
    [t.id, 1864, 'entrada', 'sete args', 10, 0, 'gpt'])).rows[0].v;
  chk('a chamada de 7 argumentos (a que o n8n faz) continua válida', Boolean(id7));

  const id8 = (await c.query(
    'select public.api_n8n_registrar_mensagem($1,$2,$3,$4,$5,$6,$7,$8) v',
    [t.id, 1864, 'entrada', 'oito args', 10, 0, 'gpt', 3.42])).rows[0].v;
  const lido = (await c.query('select audio_segundos from public.mensagens_log where id=$1', [id8])).rows[0];
  chk('audio_segundos gravado com a duração exata', Number(lido.audio_segundos) === 3.42, String(lido.audio_segundos));

  const semAudio = (await c.query('select audio_segundos from public.mensagens_log where id=$1', [id7])).rows[0];
  chk('mensagem de texto fica com audio_segundos NULL', semAudio.audio_segundos === null, String(semAudio.audio_segundos));

  const erroNeg = await esperaErro(
    'select public.api_n8n_registrar_mensagem($1,$2,$3,$4,$5,$6,$7,$8)',
    [t.id, 1864, 'entrada', 'x', null, null, null, -1]);
  chk('recusa duração negativa', erroNeg === '22023', String(erroNeg));

  console.log('\n  -- rollbacks --');
  const erroR32 = await esperaErro(R32);
  chk('rollback 32 RECUSA com áudio já registrado', erroR32 === '55000', String(erroR32));

  await c.query('delete from public.mensagens_log where id in ($1,$2)', [id7, id8]);
  await c.query(R32);
  const colsDepois = (await c.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='mensagens_log'")
  ).rows.map((r) => r.column_name);
  chk('rollback 32 limpo remove a coluna', !colsDepois.includes('audio_segundos'));
  const assinDepois = (await c.query(`
    select pg_get_function_identity_arguments(p.oid) a from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='api_n8n_registrar_mensagem'`)).rows;
  chk('rollback 32 devolve UMA assinatura de 7 argumentos', assinDepois.length === 1,
    JSON.stringify(assinDepois.map((x) => x.a)));

  await c.query(R31);
  const colsCat = (await c.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='catalogo_tools'")
  ).rows.map((r) => r.column_name);
  chk('rollback 31 remove a coluna tipo', !colsCat.includes('tipo'));
  const restou = (await c.query("select count(*)::int n from public.catalogo_tools where tool_nome='transcricao_audio'")).rows[0].n;
  chk('rollback 31 remove a linha de áudio', restou === 0, `${restou}`);
} catch (e) {
  falhas.push('ERRO INESPERADO: ' + e.message);
  console.log('  FALHA ERRO INESPERADO: ' + e.message);
}

await c.query('rollback');
await c.end();

console.log('\n  === transação revertida; produção intacta ===');
console.log(`\n${'-'.repeat(56)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) {
  console.log('\n  FALHAS:');
  for (const f of falhas) console.log(`    - ${f}`);
  process.exit(1);
}
console.log('\n  As duas migrações aplicam e revertem sem surpresa.\n');
