#!/usr/bin/env node
/**
 * Migracoes 25 (pedidos) e 26 (funcoes de venda) — validacao do par completo.
 *
 * Aplica as duas migracoes, exercita as sete funcoes e roda os dois rollbacks,
 * TUDO dentro de uma transacao que termina em ROLLBACK. Nada e persistido: da
 * para rodar contra producao sem medo, e foi assim que este par foi validado
 * antes de ser aplicado.
 *
 * Roda com a conexao direta (SUPABASE_DB_URL), como postgres. Por isso ele NAO
 * substitui tests/isolamento-pedidos.mjs, que usa JWT de usuario real: rodar
 * como postgres passa por cima da RLS e passaria enganosamente. O que se prova
 * aqui e a logica das funcoes — travas de preco, snapshot, status, unicidade —
 * e o isolamento que vem do filtro por p_tenant_id dentro delas.
 *
 * Uso: node tests/migracao-vendas.mjs
 */

import fs from 'node:fs';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const conn = fs.readFileSync(RAIZ+'.env.local', 'utf8').match(/SUPABASE_DB_URL=(.*)/)[1].trim();
const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
const mig = (f) => fs.readFileSync(RAIZ+'supabase/migrations/' + f, 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
const M25 = mig('20260811185334_25_pedidos.sql');
const M26 = mig('20260811185432_26_api_n8n_vendas.sql');
const R25 = mig('20260811185334_25_pedidos_rollback.sql');
const R26 = mig('20260811185432_26_api_n8n_vendas_rollback.sql');

const A = 'ebef4715-1a05-41d0-ad62-929b7fefa887'; // Restaurante Teste (13 produtos)
const B = '7cd0750e-e610-497a-bc0e-c1cd83b159ec'; // Sandbox de Testes (6 produtos)
const CONV_A = 900001n, CONV_B = 900002n;

let ok = 0; const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};
const val = async (sql, p = []) => (await c.query(sql, p)).rows[0]?.[Object.keys((await c.query(sql, p)).rows[0] ?? { x: 1 })[0]];
const um = async (sql, p = []) => { const r = await c.query(sql, p); return r.rows[0]; };

await c.connect();
await c.query('begin');
try {
  await c.query(M25); await c.query(M26);
  console.log('migracoes 25 e 26 aplicadas\n');

  // produtos reais do catalogo cadastrado na fatia 1
  // Mesma regra de visibilidade das funcoes: senao o teste escolhe um item que
  // a propria funcao recusa de proposito (a agua esta com estoque 0).
  const prods = (await c.query(
    `select id, nome, preco_centavos from public.produtos
      where tenant_id=$1 and deletado_em is null and disponivel
        and (estoque is null or estoque > 0)
      order by nome limit 4`, [A])).rows;
  const pA1 = prods[0], pA2 = prods[1];
  const pB = (await c.query(
    `select id, nome from public.produtos where tenant_id=$1 and deletado_em is null limit 1`, [B])).rows[0];
  console.log(`  catalogo A: ${prods.length} itens | usando "${pA1.nome}" e "${pA2.nome}"`);
  console.log(`  catalogo B: "${pB.nome}"\n`);

  console.log('--- formatacao de dinheiro ---');
  for (const [cent, esp] of [[2490, 'R$ 24,90'], [5, 'R$ 0,05'], [123456, 'R$ 1.234,56'], [100000000, 'R$ 1.000.000,00'], [0, 'R$ 0,00']]) {
    const r = await um('select public.centavos_brl($1) v', [cent]);
    chk(`${cent} -> ${esp}`, r.v === esp, `veio ${r.v}`);
  }

  console.log('\n--- carrinho vazio / sem pedido ---');
  chk('ver_pedido sem pedido', (await um('select public.api_n8n_ver_pedido($1,$2) v', [A, CONV_A])).v.includes('Nao ha pedido aberto'));
  chk('tem_pedido_pendente = false', (await um('select public.api_n8n_tem_pedido_pendente($1,$2) v', [A, CONV_A])).v === false);

  console.log('\n--- adicionar_item: preco vem do CATALOGO, nao do parametro ---');
  let r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [A, CONV_A, pA1.id, 2]);
  chk('adiciona e devolve o carrinho inteiro', r.v.includes('Pedido atual') && r.v.includes(pA1.nome), r.v.slice(0, 60));
  const item = await um(`select i.preco_unit_centavos, i.quantidade, i.nome_snapshot from public.pedido_itens i
                         join public.pedidos p on p.id=i.pedido_id where p.tenant_id=$1`, [A]);
  chk('preco gravado = preco do catalogo', item.preco_unit_centavos === pA1.preco_centavos,
      `item=${item.preco_unit_centavos} catalogo=${pA1.preco_centavos}`);
  chk('snapshot do nome congelado', item.nome_snapshot === pA1.nome);
  const ped = await um(`select total_centavos, status, numero from public.pedidos where tenant_id=$1`, [A]);
  chk('total recalculado pelo trigger', ped.total_centavos === pA1.preco_centavos * 2, `total=${ped.total_centavos}`);
  chk('status inicial rascunho', ped.status === 'rascunho');
  chk('numero ainda nulo antes de fechar', ped.numero === null);

  console.log('\n--- dois adicionar_item do mesmo produto SOMAM ---');
  await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4)', [A, CONV_A, pA1.id, 3]);
  const linhas = await um(`select count(*)::int n, max(quantidade) q from public.pedido_itens i
                           join public.pedidos p on p.id=i.pedido_id where p.tenant_id=$1`, [A]);
  chk('uma linha so, quantidade somada', linhas.n === 1 && linhas.q === 5, `linhas=${linhas.n} qtd=${linhas.q}`);

  console.log('\n--- produto de OUTRO tenant e recusado ---');
  r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [A, CONV_A, pB.id, 1]);
  chk('recusa produto_id alheio', r.v.includes('nao esta disponivel'), r.v.slice(0, 70));
  const nLinhas = await um(`select count(*)::int n from public.pedido_itens i
                            join public.pedidos p on p.id=i.pedido_id where p.tenant_id=$1`, [A]);
  chk('nada entrou no carrinho', nLinhas.n === 1, `${nLinhas.n} linha(s)`);

  console.log('\n--- produto invisivel (pausado) e recusado ---');
  await c.query(`update public.produtos set disponivel=false where id=$1`, [pA2.id]);
  r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [A, CONV_A, pA2.id, 1]);
  chk('recusa produto pausado', r.v.includes('nao esta disponivel'));
  const busca = await c.query(`select * from public.api_n8n_buscar_produtos($1,$2)`, [A, pA2.nome]);
  chk('buscar_produtos tambem nao oferece', !busca.rows.some(x => x.produto_id === pA2.id), `${busca.rowCount} resultado(s)`);
  await c.query(`update public.produtos set disponivel=true where id=$1`, [pA2.id]);

  console.log('\n--- um pedido aberto por conversa ---');
  let erroUnico = null;
  try {
    await c.query('savepoint u');
    await c.query(`insert into public.pedidos (tenant_id, conversation_id, status) values ($1,$2,'rascunho')`, [A, CONV_A]);
    await c.query('release savepoint u');
  } catch (e) { erroUnico = e.code; await c.query('rollback to savepoint u'); }
  chk('segundo pedido aberto na mesma conversa e barrado', erroUnico === '23505', `codigo ${erroUnico}`);

  console.log('\n--- fechar_pedido ---');
  chk('tem_pedido_pendente = true com item', (await um('select public.api_n8n_tem_pedido_pendente($1,$2) v', [A, CONV_A])).v === true);
  r = await um(`select public.api_n8n_fechar_pedido($1,$2,$3::jsonb) v`, [A, CONV_A, JSON.stringify({ entrega: 'retirada' })]);
  chk('fecha e devolve numero + resumo', /Pedido nº 1 fechado/.test(r.v) && r.v.includes('Total'), r.v.slice(0, 60));
  const fech = await um(`select status, numero, total_centavos, metadados from public.pedidos where tenant_id=$1`, [A]);
  chk('status aguardando_pagamento', fech.status === 'aguardando_pagamento');
  chk('numero atribuido', fech.numero === 1);
  chk('metadados mesclados', fech.metadados.entrega === 'retirada');
  chk('total = soma dos itens', fech.total_centavos === pA1.preco_centavos * 5);

  console.log('\n--- pedido fechado RECUSA alteracao ---');
  r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [A, CONV_A, pA1.id, 1]);
  chk('adicionar recusa com mensagem repassavel', r.v.includes('ja foi fechado'), r.v.slice(0, 60));
  r = await um('select public.api_n8n_remover_item($1,$2,$3) v', [A, CONV_A, pA1.id]);
  chk('remover recusa', r.v.includes('ja foi fechado'));
  const intacto = await um(`select total_centavos from public.pedidos where tenant_id=$1`, [A]);
  chk('total do pedido fechado nao mudou', intacto.total_centavos === pA1.preco_centavos * 5);

  console.log('\n--- cancelar libera a conversa ---');
  r = await um('select public.api_n8n_cancelar_pedido($1,$2) v', [A, CONV_A]);
  chk('cancela pedido ja fechado', r.v.includes('cancelado'), r.v.slice(0, 60));
  chk('tem_pedido_pendente volta a false', (await um('select public.api_n8n_tem_pedido_pendente($1,$2) v', [A, CONV_A])).v === false);
  r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [A, CONV_A, pA1.id, 1]);
  chk('novo pedido abre depois do cancelamento', r.v.includes('Pedido atual'), r.v.slice(0, 50));

  console.log('\n--- rascunho vazio NAO bloqueia resolver_conversa ---');
  await c.query(`delete from public.pedido_itens i using public.pedidos p
                 where i.pedido_id=p.id and p.tenant_id=$1 and p.status='rascunho'`, [A]);
  chk('pendente=false com rascunho vazio', (await um('select public.api_n8n_tem_pedido_pendente($1,$2) v', [A, CONV_A])).v === false);

  console.log('\n--- ISOLAMENTO: tenant B nao alcanca pedido de A ---');
  await c.query('select public.api_n8n_adicionar_item($1,$2,$3,$4)', [A, CONV_A, pA1.id, 2]);
  const idPedidoA = (await um(`select id from public.pedidos where tenant_id=$1 and status='rascunho'`, [A])).id;
  r = await um('select public.api_n8n_ver_pedido($1,$2) v', [B, CONV_A]);
  chk('B com a MESMA conversation_id nao ve o pedido de A', r.v.includes('Nao ha pedido aberto'), r.v.slice(0, 50));
  r = await um('select public.api_n8n_adicionar_item($1,$2,$3,$4) v', [B, CONV_A, pA1.id, 1]);
  chk('B nao adiciona produto de A', r.v.includes('nao esta disponivel'));
  const donoA = await um(`select tenant_id from public.pedidos where id=$1`, [idPedidoA]);
  chk('pedido de A segue de A', donoA.tenant_id === A);
  r = await um('select public.api_n8n_cancelar_pedido($1,$2) v', [B, CONV_A]);
  chk('B nao cancela pedido de A', r.v.includes('Nao ha pedido aberto'));
  const vivoA = await um(`select status from public.pedidos where id=$1`, [idPedidoA]);
  chk('pedido de A continua rascunho', vivoA.status === 'rascunho', `status=${vivoA.status}`);

  console.log('\n--- tenant_id do item nao pode ser forjado ---');
  await c.query(`insert into public.pedido_itens (tenant_id, pedido_id, produto_id, nome_snapshot, preco_unit_centavos, quantidade)
                 values ($1,$2,$3,'forjado',100,1)`, [B, idPedidoA, pA2.id]);
  const forjado = await um(`select tenant_id from public.pedido_itens where nome_snapshot='forjado'`);
  chk('trigger sobrescreve tenant_id alheio com o dono do pedido', forjado.tenant_id === A, `veio ${forjado.tenant_id}`);

  console.log('\n--- rollback recusa apagar pedido ---');
  await c.query('savepoint rb');
  let recusou = false;
  try { await c.query(R26); await c.query(R25); } catch (e) { recusou = /Abortado/.test(e.message); }
  chk('rollback da 25 aborta com pedidos existentes', recusou);
  await c.query('rollback to savepoint rb');

  console.log('\n--- rollback limpo (sem pedidos) ---');
  await c.query('delete from public.pedido_itens'); await c.query('delete from public.pedidos');
  await c.query(R26); await c.query(R25);
  const restou = await um(`select count(*)::int n from information_schema.tables
                           where table_schema='public' and table_name in ('pedidos','pedido_itens')`);
  const fn = await um(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                       where ns.nspname='public' and p.proname like 'api_n8n_%' and p.proname in
                       ('api_n8n_buscar_produtos','api_n8n_adicionar_item','api_n8n_fechar_pedido')`);
  chk('tabelas removidas', restou.n === 0);
  chk('funcoes removidas', fn.n === 0);
} catch (e) {
  console.log('\nERRO:', e.message);
  falhas.push('excecao: ' + e.message);
}
await c.query('rollback');
console.log('\n=== transacao revertida; producao intacta ===');
console.log(`${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { console.log('\nFALHAS:'); falhas.forEach(f => console.log('  - ' + f)); }
await c.end();
process.exit(falhas.length ? 1 : 0);
