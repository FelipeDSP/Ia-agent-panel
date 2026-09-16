/**
 * Migração 64 — o encerramento do link de pagamento (lado do banco).
 *
 * Em transação abortada: ROLLBACK PRIMEIRO (a 64 pode ou não estar em
 * produção), depois a 64 duas vezes. Três tenants efêmeros com credencial
 * Asaas e cobrança gerada pela função REAL da 61 (`api_n8n_gerar_cobranca` +
 * `api_n8n_registrar_cobranca`); o vencimento é ARRANJADO (`expira_em` para
 * trás) — não se espera 30 minutos.
 *
 * Propriedades:
 *   1. a varredura devolve SÓ cobranças vencidas, vivas, não pagas, não
 *      encerradas — e com a chave do TENANT delas;
 *   2. confirmar com ok=false registra o detalhe e a cobrança CONTINUA na
 *      varredura; ok=true a tira; cobrança paga não é encerrada;
 *   3. tenant em outro ambiente que o da cobrança: não sai (chave de produção
 *      não fecha link de sandbox);
 *   4. ACL igual ao da irmã; `n8n_agent` chama de verdade;
 *   5. nada em `pedidos` muda (o encerramento não mexe no relógio do pedido).
 *
 *   npm run teste:migracao-encerramento
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M64 = leia('20260916190000_64_encerramento_link_pagamento.sql');
const R64 = leia('20260916190000_64_encerramento_link_pagamento_rollback.sql');
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 12);

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
const esperaErro = async (fn) => {
  await c.query('savepoint sp_erro');
  try { await fn(); await c.query('release savepoint sp_erro'); return null; }
  catch (e) { await c.query('rollback to savepoint sp_erro'); return e; }
};
const aclFn = async (nome) => (await um(
  `select coalesce(string_agg(coalesce(p.proacl::text,'(NULO)'), ' | ' order by p.oid), '(AUSENTE)') acl
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [nome])).acl;
const existeCol = async (t, col) => (await um(
  `select count(*)::int n from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2`, [t, col])).n === 1;

const TOKEN = 'tok-webhook-teste-64-com-32-ou-mais-caracteres';
async function tenantComPagamento(sufixo, ambiente = 'sandbox') {
  const t = await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-enc64-${sufixo}`, `Teste 64 ${sufixo}`]);
  await c.query(`insert into public.tenant_credenciais (tenant_id, asaas_ambiente, asaas_api_key_sandbox, asaas_webhook_token_sandbox, asaas_api_key_producao, asaas_webhook_token_producao)
                 values ($1, $2, $3, $4, $5, $6)`, [t.id, ambiente, `sk_sb_${sufixo}`, TOKEN, `sk_pr_${sufixo}`, TOKEN.replace(/.$/, 'Z')]);
  await c.query(`insert into public.tenant_tools (tenant_id, tool_nome, ativo, contratado) values ($1, 'pagamento', true, true)`, [t.id]);
  return t.id;
}
let numero = 9100;
async function cobrancaViva(tenantId, conv, centavos = 5000) {
  const prod = await um(`insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel) values ($1, 'Item 64', $2, 'un', true) returning id`, [tenantId, centavos]);
  const ped = await um(`insert into public.pedidos (tenant_id, conversation_id, numero, status) values ($1, $2, $3, 'aguardando_pagamento') returning id`, [tenantId, conv, numero++]);
  await c.query(`insert into public.pedido_itens (tenant_id, pedido_id, produto_id, nome_snapshot, quantidade, preco_unit_centavos) values ($1, $2, $3, 'Item 64', 1, $4)`, [tenantId, ped.id, prod.id, centavos]);
  const g = await um(`select * from public.api_n8n_gerar_cobranca($1, $2)`, [tenantId, conv]);
  if (!g.ok) throw new Error(`gerar_cobranca falhou no arranjo: ${g.motivo}`);
  await c.query(`select public.api_n8n_registrar_cobranca($1, $2, true, $3, $4)`, [tenantId, g.cobranca_id, `pay_${conv}`, `https://sandbox.asaas.com/c/${conv}`]);
  return { cobrancaId: g.cobranca_id, pedidoId: ped.id };
}
const vencer = (cobrancaId) => c.query(`update public.pedido_cobrancas set expira_em = now() - interval '1 minute' where id=$1`, [cobrancaId]);
const retratoPedidos = async (ids) => md5(JSON.stringify(await tudo(`select id, status, atualizado_em from public.pedidos where id = any($1::uuid[]) order by id`, [ids])));

try {
  // =========================================================================
  console.log('\n== 0. Rollback primeiro, depois a 64 duas vezes ==\n');
  // =========================================================================
  await c.query(semTx(R64));
  chk('pré-64: sem coluna e sem funções', !(await existeCol('pedido_cobrancas', 'encerrada_em')) && (await aclFn('api_n8n_cobrancas_a_encerrar')) === '(AUSENTE)');
  await c.query(semTx(M64));
  await c.query(semTx(M64));
  chk('a 64 aplica DUAS vezes sem erro', true);
  chk('coluna `encerrada_em` e índice parcial existem', (await existeCol('pedido_cobrancas', 'encerrada_em')) && (await um(`select to_regclass('public.idx_pedido_cobrancas_a_encerrar') r`)).r !== null);

  // =========================================================================
  console.log('\n== 1. ACL igual ao da irmã; n8n_agent chama ==\n');
  // =========================================================================
  const irma = await aclFn('api_n8n_registrar_cobranca');
  for (const f of ['api_n8n_cobrancas_a_encerrar', 'api_n8n_confirmar_encerramento']) chk(`${f}: ACL == irmã`, (await aclFn(f)) === irma, await aclFn(f));
  chk('nenhuma das duas está aberta a anon/authenticated', !/anon=|authenticated=/.test((await aclFn('api_n8n_cobrancas_a_encerrar')) + (await aclFn('api_n8n_confirmar_encerramento'))));

  // =========================================================================
  console.log('\n== 2. A varredura: só vencidas, vivas, não pagas, não encerradas ==\n');
  // =========================================================================
  const TA = await tenantComPagamento('a');
  const TB = await tenantComPagamento('b');
  const TC = await tenantComPagamento('c', 'sandbox');
  const a1 = await cobrancaViva(TA, 6401);          // vencida -> sai
  const a2 = await cobrancaViva(TA, 6402);          // viva -> NÃO sai
  const b1 = await cobrancaViva(TB, 6403);          // vencida e paga -> NÃO sai
  const c1 = await cobrancaViva(TC, 6404);          // vencida, mas o tenant vira producao -> NÃO sai
  await vencer(a1.cobrancaId); await vencer(b1.cobrancaId); await vencer(c1.cobrancaId);
  await c.query(`update public.pedido_cobrancas set pago_em = now(), pagamento_id = 'pay_pago' where id=$1`, [b1.cobrancaId]);
  await c.query(`update public.tenant_credenciais set asaas_ambiente = 'producao' where tenant_id=$1`, [TC]);
  const pedidosAntes = await retratoPedidos([a1.pedidoId, a2.pedidoId, b1.pedidoId, c1.pedidoId]);

  const lista = await tudo(`select * from public.api_n8n_cobrancas_a_encerrar(50)`);
  const minhas = lista.filter((l) => [TA, TB, TC].includes(l.tenant_id));
  chk('sai exatamente a1 (vencida, viva, não paga, sandbox = sandbox)', minhas.length === 1 && minhas[0].cobranca_id === a1.cobrancaId, JSON.stringify(minhas.map((m) => m.cobranca_id)));
  chk('a linha traz a chave e a base do TENANT da cobrança (sandbox)', minhas[0]?.api_key === 'sk_sb_a' && minhas[0]?.base_url === 'https://api-sandbox.asaas.com' && minhas[0]?.link_id === 'pay_6401' && minhas[0]?.ambiente === 'sandbox');
  chk('contraprova: a viva (a2), a paga (b1) e a de ambiente trocado (c1) existem e NÃO saem',
    (await um(`select count(*)::int n from public.pedido_cobrancas where id = any($1::uuid[])`, [[a2.cobrancaId, b1.cobrancaId, c1.cobrancaId]])).n === 3
    && !minhas.some((m) => [a2.cobrancaId, b1.cobrancaId, c1.cobrancaId].includes(m.cobranca_id)));

  // =========================================================================
  console.log('\n== 3. Confirmar: falha mantém na varredura; sucesso tira; paga não encerra ==\n');
  // =========================================================================
  chk('ok=false -> true, detalhe gravado, e a1 CONTINUA na varredura',
    (await um(`select public.api_n8n_confirmar_encerramento($1,$2,false,'Asaas 500') r`, [TA, a1.cobrancaId])).r === true
    && (await um(`select encerramento_detalhe d, encerrada_em e from public.pedido_cobrancas where id=$1`, [a1.cobrancaId])).d === 'Asaas 500'
    && (await tudo(`select * from public.api_n8n_cobrancas_a_encerrar(50)`)).some((l) => l.cobranca_id === a1.cobrancaId));
  chk('ok=true -> true, encerrada_em preenchido, e a1 SAI da varredura',
    (await um(`select public.api_n8n_confirmar_encerramento($1,$2,true,'PUT 200; DELETE 200') r`, [TA, a1.cobrancaId])).r === true
    && (await um(`select encerrada_em e from public.pedido_cobrancas where id=$1`, [a1.cobrancaId])).e !== null
    && !(await tudo(`select * from public.api_n8n_cobrancas_a_encerrar(50)`)).some((l) => l.cobranca_id === a1.cobrancaId));
  chk('confirmar de novo a já encerrada -> false (idempotente, sem erro)', (await um(`select public.api_n8n_confirmar_encerramento($1,$2,true) r`, [TA, a1.cobrancaId])).r === false);
  chk('cobrança PAGA não é encerrada (false) — o pagamento vence a corrida', (await um(`select public.api_n8n_confirmar_encerramento($1,$2,true) r`, [TB, b1.cobrancaId])).r === false
    && (await um(`select encerrada_em e from public.pedido_cobrancas where id=$1`, [b1.cobrancaId])).e === null);
  const errB = await esperaErro(() => c.query(`select public.api_n8n_confirmar_encerramento($1,$2,true)`, [TB, a2.cobrancaId]));
  chk('tenant B confirmando cobrança de A -> false (não alcança), sem erro', errB === null && (await um(`select encerrada_em e from public.pedido_cobrancas where id=$1`, [a2.cobrancaId])).e === null);
  chk('NADA em `pedidos` mudou (retrato md5 igual)', (await retratoPedidos([a1.pedidoId, a2.pedidoId, b1.pedidoId, c1.pedidoId])) === pedidosAntes);

  // =========================================================================
  console.log('\n== 4. Como n8n_agent ==\n');
  // =========================================================================
  {
    await c.query('savepoint sp_role'); await c.query('set local role n8n_agent');
    let err = null; let n = null;
    try { n = (await tudo(`select * from public.api_n8n_cobrancas_a_encerrar(5)`)).length; await c.query(`select public.api_n8n_confirmar_encerramento($1,$2,false,'x')`, [TA, a2.cobrancaId]); } catch (e) { err = e; }
    await c.query('rollback to savepoint sp_role');
    chk('n8n_agent lê a varredura e confirma de verdade', err === null && typeof n === 'number', err?.message);
  }

  // =========================================================================
  console.log('\n== 5. SABOTAGEM (na própria migração, em savepoint) ==\n');
  // =========================================================================
  {
    await c.query('savepoint sp_sab');
    const mut = M64.replace("execute format('grant execute on function %s to n8n_agent', f);", '-- SABOTAGEM');
    chk('S1: a mutação entrou (md5 muda)', md5(mut) !== md5(M64));
    await c.query(semTx(mut));
    chk('S1: sem o grant do n8n_agent o ACL diverge da irmã (a asserção 1 pegaria)', (await aclFn('api_n8n_cobrancas_a_encerrar')) !== irma);
    await c.query('rollback to savepoint sp_sab');
    await c.query('savepoint sp_sab2');
    const mut2 = M64.replace('and c.pago_em is null and c.falhou_em is null and c.encerrada_em is null', 'and c.pago_em is null and c.falhou_em is null');
    chk('S2: a mutação entrou (md5 muda)', md5(mut2) !== md5(M64));
    await c.query(semTx(mut2));
    chk('S2: sem o filtro de encerrada, a1 (já encerrada) VOLTA à varredura (a asserção 3 pegaria)', (await tudo(`select * from public.api_n8n_cobrancas_a_encerrar(50)`)).some((l) => l.cobranca_id === a1.cobrancaId));
    await c.query('rollback to savepoint sp_sab2');
  }
} catch (e) {
  falhas.push(`EXCEÇÃO: ${e.message}`);
  console.log(`  EXCEÇÃO ${e.message}`);
} finally {
  await c.query('rollback');
  await c.end();
}
console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
