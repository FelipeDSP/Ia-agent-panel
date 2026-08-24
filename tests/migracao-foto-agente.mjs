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

const M35 = lim('20260812210742_35_foto_enviada.sql');
const R35 = lim('20260812210742_35_foto_enviada_rollback.sql');

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

/*
 * `contratado` em tenant_tools é operação DA AGÊNCIA: o trigger
 * `tenant_tools_guard_colunas` recusa qualquer outro papel, e esta conexão chega
 * sem JWT. Assumir o papel é o que faz o teste arranjar o estado que vai medir,
 * em vez de depender de como o banco por acaso está hoje.
 *
 * `set local` morre no rollback junto com o resto — e NÃO desligamos trigger
 * nenhum: se houvesse cascade indesejado, o teste precisa vê-lo.
 */
await c.query(`set local request.jwt.claims = '{"app_metadata":{"papel":"super_admin"}}'`);

try {
  console.log('\n== Migração 35: trava do envio de foto ==\n');
  await c.query(M35);

  const A = (await c.query("select id from public.tenants where slug='restaurante-teste'")).rows[0];
  const B = (await c.query("select id from public.tenants where slug='sandbox-de-testes'")).rows[0];

  /* -----------------------------------------------------------------------
   * ARRANJA A CREDENCIAL, em vez de contar com ela.
   *
   * `api_n8n_enviar_foto` devolve `chatwoot_url` + `chatwoot_token` quando
   * permite, e a asserção lá embaixo exige os dois. Só que o token mora em
   * `tenant_credenciais` desde a migração 21, e conectar/desconectar um cliente
   * do Chatwoot é operação normal do painel — há `teste:desconectar-chatwoot`
   * provando que funciona. Em 24/08/2026 este teste ficou vermelho porque
   * ALGUÉM USOU O PRODUTO: dos 8 tenants vivos, 3 tinham token, e o
   * `restaurante-teste` não era um deles.
   *
   * É o décimo caso da série "afirme PROPRIEDADE, não estado do mundo" — e no
   * mesmo arquivo que já produziu o oitavo. Aquela varredura procurou
   * "afirmação sobre contratação" e esta linha, que é "afirmação sobre estado",
   * passou por baixo.
   *
   * Tudo dentro da transação abortada; nada disto sobrevive ao rollback.
   * --------------------------------------------------------------------- */
  await c.query(
    `insert into public.tenant_credenciais (tenant_id, chatwoot_token)
     values ($1, 'token-arranjado-pelo-teste')
     on conflict (tenant_id) do update set chatwoot_token = excluded.chatwoot_token`,
    [A.id]);
  // `chatwoot_url` mora em `tenants`, e `trg_tenants_guard_colunas` recusaria
  // coluna fora da whitelist — mas a claim de super_admin já está ligada desde a
  // linha 74, para a transação inteira. NÃO dê `reset` nela aqui: a primeira
  // versão deste arranjo setava e resetava a claim, e o `reset` derrubou a do
  // topo, quebrando o `insert` de `tenant_tools` trinta linhas abaixo.
  await c.query(`update public.tenants set chatwoot_url = 'https://chatwoot.arranjado.teste' where id = $1`, [A.id]);

  // Confirme que a mutação entrou antes de acreditar no resultado.
  const arranjo = (await c.query(
    `select t.chatwoot_url, cr.chatwoot_token
       from public.tenants t left join public.tenant_credenciais cr on cr.tenant_id = t.id
      where t.id = $1`, [A.id])).rows[0];
  chk('arranjo: o tenant A tem url e token de Chatwoot (o teste os criou)',
    Boolean(arranjo.chatwoot_url) && arranjo.chatwoot_token === 'token-arranjado-pelo-teste',
    JSON.stringify(arranjo));

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

  /*
   * ARRANJA o estado, não o afirma.
   *
   * Este bloco dizia "sem contratar" e simplesmente CONFIAVA que ninguém tinha
   * contratado `foto_produto` para o restaurante-teste. Era verdade no dia em
   * que foi escrito e virou falsa quando alguém contratou pelo painel — que é
   * operação normal. O teste então via a foto ser PERMITIDA, reprovava a recusa,
   * e o `insert` do bloco seguinte batia em duplicate key.
   *
   * Ironia registrada: isto veio no commit chamado "varredura de testes que
   * afirmavam estado do mundo". Ler a própria regra não basta.
   *
   * Tudo aqui roda em transação revertida, então descontratar de propósito é
   * grátis e não toca produção.
   */
  await c.query(
    `insert into public.tenant_tools (tenant_id, tool_nome, contratado, ativo, config)
     values ($1,'foto_produto',false,true,'{}'::jsonb)
     on conflict (tenant_id, tool_nome) do update set contratado = false`,
    [A.id]);
  // Confirma que o arranjo ENTROU. Arranjo que não aplicou faz o teste medir
  // outra coisa e passar — a mesma classe do falso verde que a sabotagem pega.
  chk('arranjo: foto_produto está DEScontratada',
    (await c.query(
      "select contratado from public.tenant_tools where tenant_id=$1 and tool_nome='foto_produto'",
      [A.id])).rows[0].contratado === false);

  console.log('  -- sem contratar --');
  let r = await enviar(A.id, prodComFoto.id);
  chk('recusa quem não contratou', r.permitido === false && r.motivo === 'nao_contratado', JSON.stringify(r.motivo));
  chk('NÃO devolve credencial na recusa', r.chatwoot_token === null && r.chatwoot_url === null,
    'token vazando em caminho não autorizado');
  chk('a recusa foi REGISTRADA', (await registros(A.id)).length === 1);

  console.log('\n  -- contratado --');
  // Upsert, não insert: a linha pode já existir (contratada ou não), e o
  // `insert` cru estourava `tenant_tools_tenant_id_tool_nome_key`.
  await c.query(
    `insert into public.tenant_tools (tenant_id, tool_nome, contratado, ativo, config)
     values ($1,'foto_produto',true,true,'{}'::jsonb)
     on conflict (tenant_id, tool_nome) do update set contratado = true, ativo = true`,
    [A.id]);
  chk('arranjo: foto_produto está contratada',
    (await c.query(
      "select contratado from public.tenant_tools where tenant_id=$1 and tool_nome='foto_produto'",
      [A.id])).rows[0].contratado === true);

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

  /*
   * Descontrata de TODOS, não só de A.
   *
   * A versão anterior apagava a contratação de um tenant e assumia que ninguém
   * mais tinha `foto_produto` — verdade quando foi escrita, falsa a partir do dia
   * em que a agência vendeu o módulo. O guard do rollback conta os tenants, então
   * o teste morria com "3 tenant(s) com foto_produto contratada" e nem chegava a
   * exercitar o caminho limpo. Não se afirma quantos são: zera-se, e confere-se
   * que zerou. Transação revertida, produção intacta.
   */
  await c.query("delete from public.tenant_tools where tool_nome='foto_produto'");
  chk('arranjo: nenhum tenant com foto_produto contratada',
    (await c.query(
      "select count(*)::int n from public.tenant_tools where tool_nome='foto_produto' and contratado")
    ).rows[0].n === 0);
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
