#!/usr/bin/env node
/**
 * Migração 35 (trava e registro do envio de foto) numa TRANSAÇÃO ABORTADA
 * contra produção. Nada é gravado: o rollback no fim é incondicional.
 *
 * O QUE ELE PROVA, e ler o SQL não prova:
 *
 *   - que a trava REGISTRA a recusa, não só o envio. Uma tabela que só guarda o
 *     que passou responde "quantas fotos saíram" mas não responde "quantas vezes
 *     o modelo tentou mandar cinco" — que é a pergunta que diz se a regra de
 *     prompt está funcionando;
 *   - que recusa NÃO estende a janela. Se estendesse, um burst empurraria a
 *     janela a cada tentativa e o follow-up legítimo do cliente nunca passaria;
 *   - que a credencial do Chatwoot só sai quando o envio é permitido. Não pode
 *     existir caminho em que o n8n receba token sem autorização.
 *
 * NOTA SOBRE O TEMPO. `now()` é fixo dentro de uma transação no Postgres, então
 * não dá para "esperar a janela passar". A expiração é testada plantando uma
 * linha com `criado_em` antigo — que é o mesmo efeito, sem sleep.
 *
 * Uso: node tests/migracao-foto-agente.mjs   (npm run teste:migracao-foto)
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { carregarEnv } from '../scripts/lib/env.mjs';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
carregarEnv();

const lim = (f) =>
  fs.readFileSync(RAIZ + 'supabase/migrations/' + f, 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

const M35 = lim('20260812210000_35_foto_enviada.sql');
const R35 = lim('20260812210000_35_foto_enviada_rollback.sql');

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

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

const CONV = 990001n;

await c.connect();
await c.query('begin');

try {
  console.log('\n== Migração 35: trava do envio de foto ==\n');
  await c.query(M35);

  const A = (await c.query("select id from public.tenants where slug='restaurante-teste'")).rows[0];
  const B = (await c.query("select id from public.tenants where slug='sandbox-de-testes'")).rows[0];

  const enviar = async (tenantId, produtoId, conv = CONV) =>
    (await c.query('select * from public.api_n8n_enviar_foto($1,$2,$3)', [tenantId, conv, produtoId])).rows[0];

  const registros = async (tenantId, conv = CONV) =>
    (await c.query(
      'select permitido, motivo from public.fotos_enviadas where tenant_id=$1 and conversation_id=$2 order by criado_em',
      [tenantId, conv])).rows;

  // Produto de A com foto, e outro sem.
  const prodComFoto = (await c.query(
    `update public.produtos set foto_path = $2
      where id = (select id from public.produtos where tenant_id=$1 and deletado_em is null and disponivel order by nome limit 1)
      returning id, nome`,
    [A.id, `${A.id}/teste.jpg`])).rows[0];
  const prodSemFoto = (await c.query(
    `select id from public.produtos where tenant_id=$1 and deletado_em is null and disponivel and foto_path is null order by nome limit 1`,
    [A.id])).rows[0];
  const prodDeB = (await c.query(
    `select id from public.produtos where tenant_id=$1 and deletado_em is null limit 1`, [B.id])).rows[0];

  console.log('  -- sem contratar --');
  let r = await enviar(A.id, prodComFoto.id);
  chk('recusa quem não contratou', r.permitido === false && r.motivo === 'nao_contratado', JSON.stringify(r.motivo));
  chk('NÃO devolve credencial na recusa', r.chatwoot_token === null && r.chatwoot_url === null,
    'token vazando em caminho não autorizado');
  chk('a recusa foi REGISTRADA', (await registros(A.id)).length === 1);

  console.log('\n  -- contratado --');
  await c.query(
    "insert into public.tenant_tools (tenant_id, tool_nome, contratado, ativo, config) values ($1,'foto_produto',true,true,'{}'::jsonb)",
    [A.id]);

  r = await enviar(A.id, prodSemFoto.id);
  chk('recusa produto sem foto', r.permitido === false && r.motivo === 'sem_foto', String(r.motivo));

  r = await enviar(A.id, prodDeB.id);
  chk('recusa produto de OUTRO tenant', r.permitido === false && r.motivo === 'produto_invalido', String(r.motivo));

  r = await enviar(A.id, prodComFoto.id);
  chk('permite a primeira foto', r.permitido === true && r.motivo === null, String(r.motivo));
  chk('devolve nome, preço e path do produto',
    r.produto_nome === prodComFoto.nome && r.foto_path !== null && r.preco_centavos !== null);
  chk('devolve a credencial quando permite', Boolean(r.chatwoot_url) && Boolean(r.chatwoot_token));
  chk('janela default de 30s', Number(r.janela_segundos) === 30, String(r.janela_segundos));

  console.log('\n  -- a trava --');
  r = await enviar(A.id, prodComFoto.id);
  chk('recusa a SEGUNDA foto na janela', r.permitido === false && r.motivo === 'janela', String(r.motivo));
  chk('NÃO devolve credencial na recusa por janela', r.chatwoot_token === null);

  // O ponto mais fácil de errar: se a recusa contasse para a janela, um burst
  // empurraria a janela para frente e o follow-up legítimo nunca passaria.
  await enviar(A.id, prodComFoto.id);
  await enviar(A.id, prodComFoto.id);
  const permitidos = (await registros(A.id)).filter((x) => x.permitido).length;
  chk('recusa não vira envio', permitidos === 1, `${permitidos} permitido(s)`);

  console.log('\n  -- a janela expira --');
  // `now()` é fixo na transação; envelhecer a linha é o equivalente a esperar.
  await c.query(
    `update public.fotos_enviadas set criado_em = now() - interval '60 seconds'
      where tenant_id=$1 and conversation_id=$2 and permitido`, [A.id, CONV]);
  r = await enviar(A.id, prodComFoto.id);
  chk('permite de novo depois da janela', r.permitido === true, String(r.motivo));

  console.log('\n  -- a janela é por CONVERSA --');
  r = await enviar(A.id, prodComFoto.id, 990002n);
  chk('outra conversa não herda a janela', r.permitido === true, String(r.motivo));

  console.log('\n  -- janela configurável --');
  await c.query(
    `update public.tenant_tools set config = '{"janela_foto_segundos": 120}'::jsonb
      where tenant_id=$1 and tool_nome='foto_produto'`, [A.id]);
  r = await enviar(A.id, prodComFoto.id, 990003n);
  chk('lê janela_foto_segundos do config', Number(r.janela_segundos) === 120, String(r.janela_segundos));

  console.log('\n  -- integridade --');
  const erroMotivo = await esperaErro(
    "insert into public.fotos_enviadas (tenant_id, conversation_id, permitido, motivo) values ($1,1,true,'janela')",
    [A.id]);
  chk('CHECK recusa permitido COM motivo', erroMotivo === '23514', String(erroMotivo));

  const erroMotivoInvalido = await esperaErro(
    "insert into public.fotos_enviadas (tenant_id, conversation_id, permitido, motivo) values ($1,1,false,'inventado')",
    [A.id]);
  chk('CHECK recusa motivo fora do domínio', erroMotivoInvalido === '23514', String(erroMotivoInvalido));

  const rls = (await c.query(
    "select relrowsecurity from pg_class where oid='public.fotos_enviadas'::regclass")).rows[0];
  chk('RLS ligado na tabela', rls.relrowsecurity === true);
  const pol = (await c.query(
    "select count(*)::int n from pg_policies where schemaname='public' and tablename='fotos_enviadas'")).rows[0];
  chk('policy criada na MESMA migração', pol.n >= 1, `${pol.n}`);

  const idx = (await c.query(
    "select indexdef from pg_indexes where schemaname='public' and indexname='idx_fotos_enviadas_janela'")).rows[0];
  chk('índice começa por tenant_id (regra 3)', /\(tenant_id,/.test(idx?.indexdef ?? ''), idx?.indexdef ?? 'ausente');

  console.log('\n  -- catálogo --');
  const cat = (await c.query("select tipo from public.catalogo_tools where tool_nome='foto_produto'")).rows[0];
  chk('foto_produto no catálogo como tool_modelo', cat?.tipo === 'tool_modelo', String(cat?.tipo));

  console.log('\n  -- rollback --');
  const erroR = await esperaErro(R35);
  chk('rollback RECUSA com o módulo contratado', erroR === '55000', String(erroR));

  await c.query("delete from public.tenant_tools where tenant_id=$1 and tool_nome='foto_produto'", [A.id]);
  await c.query(R35);
  const sobrou = (await c.query(
    "select count(*)::int n from information_schema.tables where table_schema='public' and table_name='fotos_enviadas'")).rows[0];
  chk('rollback limpo remove a tabela', sobrou.n === 0);
} catch (e) {
  falhas.push('ERRO INESPERADO: ' + e.message);
  console.log('  FALHA ERRO INESPERADO: ' + e.message);
}

await c.query('rollback');
await c.end();

console.log('\n  === transação revertida; produção intacta ===');
console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) {
  console.log('\n  FALHAS:');
  for (const f of falhas) console.log(`    - ${f}`);
  process.exit(1);
}
console.log('\n  A trava tem teto E deixa rastro.\n');
