/**
 * Migração 69 — modalidade (retirada), pagamento na retirada, aviso ao dono.
 *
 * Rollback-first, 69 duas vezes; ACL das quatro funções substituídas por diff
 * (antes × depois); três tenants com ofertas diferentes (A = padrão/link,
 * B = só na retirada, C = os dois + entrega → atendente); "na retirada" não
 * expira nem trava o encerramento; notificar_venda escreve modalidade e
 * pagamento; eventos filtram; painel_marcar_pedido usa o tenant do JWT (A não
 * marca o pedido de B); aviso por evento é idempotente. Sabotagens: o filtro
 * de `pagamento_modo` na expiração; o filtro de tenant no marcar.
 *
 *   npm run teste:migracao-vendas-modalidades
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M69 = leia('20260917150000_69_vendas_modalidades.sql');
const R69 = leia('20260917150000_69_vendas_modalidades_rollback.sql');
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
const aclFn = async (nome) => (await um(
  `select coalesce(string_agg(coalesce(p.proacl::text,'(NULO)'), ' | ' order by p.oid), '(AUSENTE)') acl
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [nome])).acl;
const temCol = async (col) => (await um(`select count(*)::int n from information_schema.columns where table_name='pedidos' and column_name=$1`, [col])).n === 1;
const claims = async (t) => c.query(`select set_config('request.jwt.claims', $1, true)`, [t ? JSON.stringify({ app_metadata: { papel: 'tenant_admin', tenant_id: t } }) : '']);
const SUBST = ['api_n8n_fechar_pedido', 'expirar_pedidos_vencidos', 'api_n8n_tem_pedido_pendente', 'api_n8n_notificar_venda'];
const CONV = 4242;

// arranja um tenant com vendas contratada + config dada, um produto e uma
// conversa; devolve ids. Tudo dentro da transação abortada.
const arranja = async (sufixo, config) => {
  const id = (await um(`insert into public.tenants (slug, nome) values ($1, $2) returning id`, [`z-teste-69-${sufixo}`, `Teste 69 ${sufixo}`])).id;
  await c.query(`insert into public.tenant_tools (tenant_id, tool_nome, ativo, contratado, config) values ($1, 'vendas', true, true, $2)`, [id, JSON.stringify(config)]);
  const prod = (await um(`insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel) values ($1, 'Bolo 69', 4000, 'un', true) returning id`, [id])).id;
  await c.query(`insert into public.conversas (tenant_id, conversation_id, contact_name, phone) values ($1, $2, 'Cliente 69', '5569900000000')`, [id, CONV]);
  return { id, prod };
};
const adiciona = async (t) => um(`select public.api_n8n_adicionar_item($1, $2, $3, 1, null) r`, [t.id, CONV, t.prod]);
const fecha = async (t, meta) => (await um(`select public.api_n8n_fechar_pedido($1, $2, $3) r`, [t.id, CONV, meta])).r;
const pedidoDe = async (t) => um(`select id, status, modalidade, pagamento_modo, pago_em, retirado_em, metadados from public.pedidos where tenant_id=$1 and conversation_id=$2 order by criado_em desc limit 1`, [t.id, CONV]);
const pedidoPorId = async (id) => um(`select id, status, modalidade, pagamento_modo, pago_em, retirado_em, metadados from public.pedidos where id=$1`, [id]);
// `trg_pedidos_upd` sobrescreve atualizado_em em todo update; para "envelhecer"
// um pedido o trigger sai de cena só nessa linha, dentro da transação abortada
const envelhece = async (ids, horas) => {
  await c.query('alter table public.pedidos disable trigger trg_pedidos_upd');
  await c.query(`update public.pedidos set atualizado_em = now() - make_interval(hours => $2) where id = any($1::uuid[])`, [ids, horas]);
  await c.query('alter table public.pedidos enable trigger trg_pedidos_upd');
};

try {
  console.log('\n== 0. Rollback primeiro, 69 duas vezes, ACL por diff ==\n');
  await c.query(semTx(R69));
  const aclAntes = {};
  for (const f of SUBST) aclAntes[f] = await aclFn(f);
  chk('pré-69: sem colunas, sem funções novas', !(await temCol('pagamento_modo')) && !(await temCol('retirado_em'))
    && (await aclFn('painel_marcar_pedido')) === '(AUSENTE)' && (await aclFn('api_agente_aviso_pedido')) === '(AUSENTE)');
  await c.query(semTx(M69)); await c.query(semTx(M69));
  chk('a 69 aplica duas vezes; colunas e funções existem', (await temCol('modalidade')) && (await temCol('pagamento_modo')) && (await temCol('pago_em')) && (await temCol('retirado_em'))
    && (await aclFn('painel_marcar_pedido')) !== '(AUSENTE)');
  for (const f of SUBST) chk(`ACL de ${f} igual ao de antes (create or replace, sem drop)`, (await aclFn(f)) === aclAntes[f], `${aclAntes[f]} -> ${await aclFn(f)}`);
  chk('api_agente_aviso_pedido / confirmar_aviso: ACL == irmã api_n8n_fechar_pedido (service_role + n8n_agent)',
    (await aclFn('api_agente_aviso_pedido')) === aclAntes['api_n8n_fechar_pedido'] && (await aclFn('api_agente_confirmar_aviso')) === aclAntes['api_n8n_fechar_pedido'],
    await aclFn('api_agente_aviso_pedido'));
  chk('painel_marcar_pedido: ACL == irmã conversa_historico (authenticated + service_role)', (await aclFn('painel_marcar_pedido')) === (await aclFn('conversa_historico')), await aclFn('painel_marcar_pedido'));
  chk('vendas_oferta: só postgres (helper interno)', (await aclFn('vendas_oferta')) === '{postgres=X/postgres}', await aclFn('vendas_oferta'));
  chk('aplicar NÃO muda pedido nenhum: nenhum ganhou modalidade/pagamento_modo', (await um(`select count(*)::int n from public.pedidos where modalidade is not null or pagamento_modo is not null or pago_em is not null or retirado_em is not null`)).n === 0);

  console.log('\n== 1. Três ofertas ==\n');
  const A = await arranja('a', {});                                                   // padrão = link (hoje)
  const B = await arranja('b', { pagamentos: ['na_retirada'], notificacao: { canal: 'waha', sessao: 'sess', destino: '5569911111111@c.us', nota_chatwoot: true } });
  const C = await arranja('c', { pagamentos: ['link', 'na_retirada'], entrega: 'atendente', eventos: ['pagamento_confirmado'] });

  await adiciona(A);
  const fa = await fecha(A, '{"entrega":"retirada"}');
  const pa = await pedidoDe(A);
  chk('A (config vazia): fecha como antes — link, texto idêntico ao de hoje', /^Pedido nº \d+ fechado\.\n/.test(fa) && pa.status === 'aguardando_pagamento' && pa.pagamento_modo === 'link' && pa.modalidade === 'retirada', fa.split('\n')[0]);
  chk('A: pedir na_retirada onde só há link -> NADA FOI FECHADO (novo carrinho)', await (async () => { await adiciona(A); const r = await fecha(A, '{"pagamento":"na_retirada"}'); return /^NADA FOI FECHADO: este estabelecimento nao aceita pagamento "na_retirada"/.test(r); })());
  chk('A: entrega sem atendente -> NADA FOI FECHADO, só retirada', /^NADA FOI FECHADO: este estabelecimento nao faz entrega/.test(await fecha(A, '{"modalidade":"entrega"}')));

  await adiciona(B);
  const fb = await fecha(B, '{"observacao":"as 7h"}');
  const pb = await pedidoDe(B);
  chk('B (só na retirada): fecha sem o modelo dizer nada; texto avisa NA RETIRADA', /pagamento NA RETIRADA/.test(fb) && pb.pagamento_modo === 'na_retirada' && pb.modalidade === 'retirada', fb.split('\n')[0]);
  chk('B: as chaves viraram coluna; observacao ficou em metadados', pb.metadados.observacao === 'as 7h' && !('pagamento' in pb.metadados) && !('modalidade' in pb.metadados), JSON.stringify(pb.metadados));

  await adiciona(C);
  chk('C (os dois): sem dizer -> NADA FOI FECHADO, pergunte', /^NADA FOI FECHADO: falta saber como o cliente prefere pagar/.test(await fecha(C, '{}')));
  chk('C: entrega -> NADA FOI FECHADO, chame transferir_humano', /^NADA FOI FECHADO: pedido para ENTREGA.*transferir_humano/.test(await fecha(C, '{"entrega":"entrega"}')));
  chk('C: pagamento inventado -> NADA FOI FECHADO com as opções', /Opcoes: link ou na_retirada/.test(await fecha(C, '{"pagamento":"fiado"}')));
  const fc = await fecha(C, '{"pagamento":"na_retirada","modalidade":"retirada"}');
  const pc = await pedidoDe(C);
  chk('C: com pagamento=na_retirada fecha', /fechado — retirada no local/.test(fc) && pc.pagamento_modo === 'na_retirada', fc.split('\n')[0]);
  chk('CHECK: pagamento_modo fora da lista -> 23514', await (async () => { await c.query('savepoint sp_chk'); try { await c.query(`update public.pedidos set pagamento_modo='fiado' where id=$1`, [pc.id]); await c.query('release savepoint sp_chk'); return false; } catch (e) { await c.query('rollback to savepoint sp_chk'); return e.code === '23514'; } })());

  console.log('\n== 2. Na retirada não expira nem trava; link continua igual ==\n');
  await envelhece([pa.id, pb.id], 30);
  chk('arranjo: os dois pedidos têm 30 h', (await um(`select count(*)::int n from public.pedidos where id = any($1::uuid[]) and atualizado_em < now() - interval '29 hours'`, [[pa.id, pb.id]])).n === 2);
  chk('B: tem_pedido_pendente = false (na retirada não trava o resolver)', (await um(`select public.api_n8n_tem_pedido_pendente($1, $2) r`, [B.id, CONV])).r === false);
  chk('B: 30 h depois continua aguardando_pagamento (sem prazo)', (await pedidoPorId(pb.id)).status === 'aguardando_pagamento');
  chk('A: 30 h depois o link expirou (comportamento de antes preservado)', (await um(`select public.expirar_pedidos_vencidos($1, $2) r`, [A.id, CONV])).r !== null && (await pedidoPorId(pa.id)).status === 'expirado');

  console.log('\n== 3. Aviso da venda fechada e eventos ==\n');
  const nb = await um(`select * from public.api_n8n_notificar_venda($1, $2)`, [B.id, CONV]);
  chk('B: notificar_venda escreve "Retirada no local" e "NA RETIRADA"', /📦 Retirada no local/.test(nb?.mensagem ?? '') && /NA RETIRADA/.test(nb?.mensagem ?? '') && /Obs\.: as 7h/.test(nb?.mensagem ?? ''), nb?.mensagem);
  chk('B: segunda chamada não devolve (claim)', (await um(`select * from public.api_n8n_notificar_venda($1, $2)`, [B.id, CONV])) === undefined);
  await c.query(`update public.tenant_tools set config = config || '{"notificacao":{"canal":"waha","sessao":"sess","destino":"5569922222222@c.us"}}' where tenant_id=$1 and tool_nome='vendas'`, [C.id]);
  chk('C: eventos sem pedido_fechado -> notificar_venda cala', (await um(`select * from public.api_n8n_notificar_venda($1, $2)`, [C.id, CONV])) === undefined);
  chk('C: pedido de C NÃO ganhou claim (calar não gasta)', (await pedidoDe(C)).metadados.notificacao === undefined);
  // só a nota, sem WhatsApp: a linha vem com sessao/destino nulos e o claim é gasto
  const N = await arranja('n', { pagamentos: ['na_retirada'], notificacao: { canal: 'nenhum', nota_chatwoot: true } });
  await adiciona(N); await fecha(N, '{}');
  const nn = await um(`select * from public.api_n8n_notificar_venda($1, $2)`, [N.id, CONV]);
  chk('N (só nota): notificar_venda devolve a linha com sessao/destino NULOS e a mensagem', nn?.pedido_id && nn.sessao === null && nn.destino === null && /Venda fechada/.test(nn.mensagem ?? ''), JSON.stringify(nn));
  chk('N: e gastou o claim (segunda chamada vazia)', (await um(`select * from public.api_n8n_notificar_venda($1, $2)`, [N.id, CONV])) === undefined);
  const S = await arranja('s', { pagamentos: ['na_retirada'] });
  await adiciona(S); await fecha(S, '{}');
  chk('S (sem WhatsApp nem nota): notificar_venda cala e não gasta claim', (await um(`select * from public.api_n8n_notificar_venda($1, $2)`, [S.id, CONV])) === undefined && (await pedidoDe(S)).metadados.notificacao === undefined);

  console.log('\n== 4. painel_marcar_pedido — tenant do JWT ==\n');
  await claims(A.id);
  const xa = await um(`select * from public.painel_marcar_pedido($1, 'pago')`, [pb.id]);
  chk('A (claims) tentando marcar o pedido de B -> nao_encontrado, B intocado', xa.ok === false && xa.motivo === 'nao_encontrado' && (await pedidoDe(B)).status === 'aguardando_pagamento', JSON.stringify(xa));
  await claims(B.id);
  const xr = await um(`select * from public.painel_marcar_pedido($1, 'retirado')`, [pb.id]);
  chk('B: retirado antes de pago -> nao_esta_pago', xr.ok === false && xr.motivo === 'nao_esta_pago');
  const xp = await um(`select * from public.painel_marcar_pedido($1, 'pago')`, [pb.id]);
  const pb2 = await pedidoDe(B);
  chk('B: pago -> status pago, pago_em E retirado_em (paga ao retirar)', xp.ok === true && pb2.status === 'pago' && pb2.pago_em !== null && pb2.retirado_em !== null, JSON.stringify(xp));
  chk('B: pago de novo -> nao_esta_aguardando; retirado de novo -> ja_retirado',
    (await um(`select * from public.painel_marcar_pedido($1, 'pago')`, [pb.id])).motivo === 'nao_esta_aguardando'
    && (await um(`select * from public.painel_marcar_pedido($1, 'retirado')`, [pb.id])).motivo === 'ja_retirado');
  await claims(C.id);
  const xc = await um(`select * from public.painel_marcar_pedido($1, 'pago')`, [pc.id]);
  chk('C (na retirada): pago marca os dois de uma vez', xc.ok === true && xc.retirado_em !== null, JSON.stringify(xc));
  chk('ação inválida -> acao_invalida', (await um(`select * from public.painel_marcar_pedido($1, 'entregue')`, [pc.id])).motivo === 'acao_invalida');
  await claims(null);
  chk('sem claims: pedido de B invisível (nao_encontrado)', (await um(`select * from public.painel_marcar_pedido($1, 'pago')`, [pb.id])).motivo === 'nao_encontrado');
  // cobrança aberta é encerrada no banco quando o dono marca pago
  await adiciona(A); await fecha(A, '{}');
  const pa2 = await pedidoDe(A);
  await c.query(`insert into public.pedido_cobrancas (tenant_id, pedido_id, conversation_id, ambiente, valor_centavos, expira_em, url, link_id) values ($1, $2, $3, 'sandbox', 4000, now() + interval '20 minutes', 'https://x', 'lnk')`, [A.id, pa2.id, CONV]);
  await claims(A.id);
  await um(`select * from public.painel_marcar_pedido($1, 'pago')`, [pa2.id]);
  await claims(null);
  const cob = await um(`select encerrada_em, encerramento_detalhe from public.pedido_cobrancas where pedido_id=$1`, [pa2.id]);
  chk('A: marcar pago no painel encerra a cobrança aberta (a varredura não manda "expirou")', cob.encerrada_em !== null && /pago no painel/.test(cob.encerramento_detalhe), JSON.stringify(cob));
  chk('A (link): pago pelo painel NÃO marca retirado', (await pedidoPorId(pa2.id)).retirado_em === null);
  await claims(A.id);
  const xa2 = await um(`select * from public.painel_marcar_pedido($1, 'retirado')`, [pa2.id]);
  await claims(null);
  chk('A (link): retirado depois de pago -> ok, retirado_em preenchido', xa2.ok === true && xa2.retirado_em !== null && (await pedidoPorId(pa2.id)).retirado_em !== null, JSON.stringify(xa2));

  console.log('\n== 5. Aviso por evento (idempotente, por evento) ==\n');
  const av = await um(`select * from public.api_agente_aviso_pedido($1, $2, 'pagamento_confirmado')`, [B.id, CONV]);
  chk('B: pagamento_confirmado -> sessão/destino/nota + texto "Pago na retirada"', av?.destino === '5569911111111@c.us' && av?.nota_chatwoot === true && /Pagamento confirmado/.test(av?.mensagem ?? '') && /Pago na retirada/.test(av?.mensagem ?? ''), JSON.stringify(av));
  chk('B: segunda chamada do mesmo evento não devolve', (await um(`select * from public.api_agente_aviso_pedido($1, $2, 'pagamento_confirmado')`, [B.id, CONV])) === undefined);
  chk('B: confirmar_aviso grava enviado_em em metadados.avisos.pagamento_confirmado', (await um(`select public.api_agente_confirmar_aviso($1, $2, 'pagamento_confirmado', true, null) r`, [B.id, pb.id])).r === true
    && (await pedidoDe(B)).metadados.avisos.pagamento_confirmado.enviado_em !== undefined);
  chk('B: evento desconhecido -> nada', (await um(`select * from public.api_agente_aviso_pedido($1, $2, 'pedido_entregue')`, [B.id, CONV])) === undefined);
  chk('A: sem notificação nem nota -> nada', (await um(`select * from public.api_agente_aviso_pedido($1, $2, 'pagamento_confirmado')`, [A.id, CONV])) === undefined);
  const avc = await um(`select * from public.api_agente_aviso_pedido($1, $2, 'pagamento_confirmado')`, [C.id, CONV]);
  chk('C (eventos só pagamento_confirmado): devolve para pagamento…', avc?.destino === '5569922222222@c.us' && avc?.nota_chatwoot === false, JSON.stringify(avc));
  await c.query(`update public.pedidos set status='cancelado' where id=$1`, [pc.id]);
  chk('…e cala para pedido_cancelado', (await um(`select * from public.api_agente_aviso_pedido($1, $2, 'pedido_cancelado')`, [C.id, CONV])) === undefined);
  {
    await c.query('savepoint sp_role'); await c.query('set local role n8n_agent');
    let err = null;
    try { await um(`select * from public.api_agente_aviso_pedido($1, $2, 'pagamento_confirmado')`, [B.id, CONV]); await um(`select public.api_n8n_fechar_pedido($1, $2, '{}')`, [B.id, CONV]); } catch (e) { err = e; }
    await c.query('rollback to savepoint sp_role');
    chk('n8n_agent chama de verdade as duas (nova e substituída)', err === null, err?.message);
  }

  console.log('\n== 6. SABOTAGEM ==\n');
  {
    await c.query('savepoint sp_s1');
    const mut = M69.replace("     and coalesce(p.pagamento_modo, 'link') = 'link'\n", '');
    chk('S1 mutou (md5)', md5(mut) !== md5(M69));
    await c.query(semTx(mut));
    const D = await arranja('d', { pagamentos: ['na_retirada'] });
    await adiciona(D); await fecha(D, '{}');
    const pd = await pedidoDe(D);
    await envelhece([pd.id], 30);
    await um(`select public.expirar_pedidos_vencidos($1, $2)`, [D.id, CONV]);
    chk('S1: sem o filtro, "na retirada" EXPIRA (a asserção 2 pegaria)', (await pedidoPorId(pd.id)).status === 'expirado');
    await c.query('rollback to savepoint sp_s1');

    await c.query('savepoint sp_s2');
    const mut2 = M69.replace('and (public.auth_is_super_admin() or p.tenant_id = public.auth_tenant_id())', 'and true');
    chk('S2 mutou (md5)', md5(mut2) !== md5(M69));
    await c.query(semTx(mut2));
    const E = await arranja('e', { pagamentos: ['na_retirada'] });
    await adiciona(E); await fecha(E, '{}');
    const pe = await pedidoDe(E);
    await claims(A.id);
    const xs = await um(`select * from public.painel_marcar_pedido($1, 'pago')`, [pe.id]);
    await claims(null);
    chk('S2: sem o filtro de tenant, A marca o pedido de E (a asserção 4 pegaria)', xs.ok === true);
    await c.query('rollback to savepoint sp_s2');
  }
} catch (e) {
  falhas.push(`EXCEÇÃO: ${e.message}`); console.log(`  EXCEÇÃO ${e.message}`);
} finally {
  await c.query('rollback'); await c.end();
}
console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
