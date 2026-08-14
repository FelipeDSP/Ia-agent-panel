#!/usr/bin/env node
/**
 * Migração 38 (pedido não pago expira na leitura) numa TRANSAÇÃO ABORTADA
 * contra produção. Nada é gravado: o rollback no fim é incondicional.
 *
 * O QUE ELE PROVA, e ler o SQL não prova:
 *
 *   - que o cliente que volta depois do prazo consegue pedir NA MESMA CHAMADA.
 *     Não "depois de um cron rodar": o `adicionar_item` expira o velho e cria o
 *     novo no mesmo comando, e o índice único libera junto;
 *   - que `rascunho` NUNCA expira, por mais velho que seja. É o carrinho do
 *     próprio cliente, e expirar destruiria trabalho dele. A asserção existe
 *     para o dia em que alguém "generalizar" a regra;
 *   - que o aviso CHEGA ao agente. Liberar em silêncio faria o cliente seguir
 *     achando que o pedido antigo está de pé;
 *   - que `api_n8n_tem_pedido_pendente` — a GUARDA DO `resolver_conversa` —
 *     agora ESCREVE. Ver a seção 5: é o efeito colateral que o nome da função
 *     não sugere, e está amarrado aqui para não virar descoberta em produção.
 *
 * NOTA SOBRE O RELÓGIO. `trg_pedidos_upd` é BEFORE UPDATE e sobrescreve
 * `atualizado_em`, então não dá para envelhecer um pedido com UPDATE. A idade é
 * plantada no INSERT, que não tem trigger. Descoberto conferindo antes de
 * escrever a asserção — a versão ingênua teria passado por acidente.
 *
 * Uso: npm run teste:expirar-pedido
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const lim = (f) =>
  fs.readFileSync(RAIZ + 'supabase/migrations/' + f, 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

const M38 = lim('20260814160000_38_expirar_pedido_nao_pago.sql');
const R38 = lim('20260814160000_38_expirar_pedido_nao_pago_rollback.sql');

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

// Conversas de teste, uma por cenario, para os casos nao se contaminarem.
const CONV_VENCIDO = 996001n;
const CONV_NOVO = 996002n;
const CONV_RASCUNHO = 996003n;
const CONV_RESOLVER = 996004n;

const volatilidade = async (nome) =>
  (await c.query(
    `select p.provolatile, count(*) over ()::int assinaturas
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname = $1`,
    [nome],
  )).rows;

const statusDo = async (conv) =>
  (await c.query(
    `select status, numero from public.pedidos where conversation_id = $1 order by criado_em`,
    [conv],
  )).rows;

/** Planta um pedido com idade. A idade vai no INSERT: o BEFORE UPDATE reescreveria. */
const plantar = (tenant, conv, status, horas, numero) =>
  c.query(
    `insert into public.pedidos (tenant_id, conversation_id, status, numero, total_centavos, criado_em, atualizado_em)
     values ($1, $2, $3, $4, 33180, now() - make_interval(hours => $5), now() - make_interval(hours => $5))
     returning id`,
    [tenant, conv, status, numero, horas],
  );

await c.connect();
await c.query('begin');

try {
  console.log('\n== Migração 38: pedido não pago expira na leitura ==\n');

  const tenant = (await c.query(`select id from public.tenants where slug='restaurante-teste'`)).rows[0]?.id;
  // As MESMAS condições que `api_n8n_adicionar_item` aplica, `estoque` inclusive.
  // A primeira versão só filtrava `disponivel` e pegou um produto sem estoque: a
  // função respondeu "item nao esta disponivel" e a asserção do aviso reprovou.
  // Escolher o insumo com critério mais frouxo que o da função sob teste testa
  // outra coisa.
  const prod = (await c.query(
    `select id from public.produtos
      where tenant_id = $1 and disponivel and deletado_em is null
        and (estoque is null or estoque > 0)
      limit 1`, [tenant],
  )).rows[0]?.id;
  if (!tenant || !prod) throw new Error('tenant/produto de teste nao encontrado');

  // -------------------------------------------------------------------------
  console.log('\n-- 1. Aplicar não mexe no que já existe --\n');

  const antes = (await c.query(`select status, count(*)::int n from public.pedidos group by 1 order by 1`)).rows;
  const aplicou = await tentar(M38);
  chk('migração aplica', aplicou.erro === null, `veio ${aplicou.erro}`);
  if (aplicou.erro) throw new Error('migração 38 não aplica');

  const depois = (await c.query(`select status, count(*)::int n from public.pedidos group by 1 order by 1`)).rows;
  chk(
    'nenhum pedido muda de status ao aplicar',
    JSON.stringify(antes) === JSON.stringify(depois),
    `${JSON.stringify(antes)} -> ${JSON.stringify(depois)}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n-- 2. Volatilidade trocada, e uma assinatura só --\n');

  for (const f of ['pedido_aberto_da_conversa', 'api_n8n_tem_pedido_pendente']) {
    const v = await volatilidade(f);
    chk(`${f}: exatamente 1 assinatura`, v.length === 1, `veio ${v.length}`);
    chk(`${f}: VOLATILE`, v[0]?.provolatile === 'v', `provolatile=${v[0]?.provolatile}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n-- 3. Só o vencido expira --\n');

  await plantar(tenant, CONV_VENCIDO, 'aguardando_pagamento', 30, 90001); // > 24h
  await plantar(tenant, CONV_NOVO, 'aguardando_pagamento', 2, 90002); //  < 24h

  const avisoVencido = (await c.query(
    `select public.expirar_pedidos_vencidos($1, $2) aviso`, [tenant, CONV_VENCIDO],
  )).rows[0].aviso;
  const avisoNovo = (await c.query(
    `select public.expirar_pedidos_vencidos($1, $2) aviso`, [tenant, CONV_NOVO],
  )).rows[0].aviso;

  chk('pedido de 30h expira', (await statusDo(CONV_VENCIDO))[0]?.status === 'expirado',
    JSON.stringify(await statusDo(CONV_VENCIDO)));
  chk('pedido de 2h NÃO expira', (await statusDo(CONV_NOVO))[0]?.status === 'aguardando_pagamento',
    JSON.stringify(await statusDo(CONV_NOVO)));
  chk('o aviso menciona o número do pedido', /90001/.test(avisoVencido ?? ''), JSON.stringify(avisoVencido));
  chk('e o valor em reais', /R\$/.test(avisoVencido ?? ''), JSON.stringify(avisoVencido));
  chk('nada a expirar devolve NULL', avisoNovo === null, JSON.stringify(avisoNovo));

  // Idempotente: `adicionar_item` chama a expiração e `pedido_aberto_da_conversa`
  // chama de novo no mesmo turno. A segunda não pode inventar um segundo aviso.
  const segundaVez = (await c.query(
    `select public.expirar_pedidos_vencidos($1, $2) aviso`, [tenant, CONV_VENCIDO],
  )).rows[0].aviso;
  chk('segunda chamada no mesmo turno devolve NULL', segundaVez === null, JSON.stringify(segundaVez));

  // -------------------------------------------------------------------------
  console.log('\n-- 4. Rascunho NUNCA expira (escopo, não esquecimento) --\n');

  await plantar(tenant, CONV_RASCUNHO, 'rascunho', 24 * 90, 90003); // 90 dias
  await c.query(`select public.expirar_pedidos_vencidos($1, $2)`, [tenant, CONV_RASCUNHO]);
  chk(
    'rascunho de 90 dias continua rascunho — é o carrinho do cliente',
    (await statusDo(CONV_RASCUNHO))[0]?.status === 'rascunho',
    JSON.stringify(await statusDo(CONV_RASCUNHO)),
  );

  // -------------------------------------------------------------------------
  console.log('\n-- 5. resolver_conversa: a guarda agora ESCREVE --\n');
  //
  // `api_n8n_tem_pedido_pendente` é chamada pelo sub-workflow
  // `Tool - Resolver Conversa (Multi-Tenant)` (linha 146 do JSON) para não
  // encerrar conversa com pedido aberto. Desde a 38 ela é VOLATILE: perguntar
  // "posso encerrar?" expira pedido vencido daquela conversa.
  //
  // É correto — o pedido venceu de fato — mas ninguém espera escrita de uma
  // função com esse nome. A asserção existe para o comportamento ser uma
  // decisão registrada, e não uma descoberta em produção.

  await plantar(tenant, CONV_RESOLVER, 'aguardando_pagamento', 48, 90004);
  const antesResolver = (await statusDo(CONV_RESOLVER))[0]?.status;
  const pendente = (await c.query(
    `select public.api_n8n_tem_pedido_pendente($1, $2) p`, [tenant, CONV_RESOLVER],
  )).rows[0].p;
  const depoisResolver = (await statusDo(CONV_RESOLVER))[0]?.status;

  chk('antes de perguntar, o pedido está aguardando_pagamento', antesResolver === 'aguardando_pagamento', antesResolver);
  chk(
    'EFEITO COLATERAL: a guarda do resolver_conversa expirou o pedido',
    depoisResolver === 'expirado',
    `ficou ${depoisResolver}`,
  );
  chk('e por isso responde que NÃO há pedido pendente', pendente === false, `veio ${pendente}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 6. O cliente pede de novo na MESMA chamada --\n');

  // A conversa do vencido já teve o pedido expirado na seção 3. Aqui o que se
  // prova é o caminho completo: `adicionar_item` numa conversa cujo pedido
  // venceu abre pedido novo sem esbarrar no índice único.
  await plantar(tenant, 996005n, 'aguardando_pagamento', 30, 90005);
  const r = await tentar(
    `select public.api_n8n_adicionar_item($1, $2, $3, 1, null) txt`,
    [tenant, 996005n, prod],
  );
  chk('adicionar_item não estoura no índice único', r.erro === null, `veio ${r.erro}`);
  const txt = r.rows[0]?.txt ?? '';
  chk('o aviso do pedido expirado vem junto da resposta', /90005/.test(txt), JSON.stringify(txt.slice(0, 120)));

  const linhas = await statusDo(996005n);
  chk('o antigo virou expirado', linhas.some((l) => l.status === 'expirado' && l.numero === 90005),
    JSON.stringify(linhas));
  chk('e existe um rascunho novo na mesma conversa', linhas.some((l) => l.status === 'rascunho'),
    JSON.stringify(linhas));

  // -------------------------------------------------------------------------
  console.log('\n-- 7. O prazo é do cliente, não meu --\n');

  await c.query(
    `update public.tenant_tools set config = coalesce(config,'{}'::jsonb) || '{"horas_expirar_pagamento":"720"}'::jsonb
      where tenant_id = $1 and tool_nome = 'vendas'`, [tenant],
  );
  chk('config lida do tenant_tools', (
    await c.query(`select public.pedido_horas_para_expirar($1) h`, [tenant])
  ).rows[0].h === 720);

  await plantar(tenant, 996006n, 'aguardando_pagamento', 100, 90006); // 100h < 720h
  await c.query(`select public.expirar_pedidos_vencidos($1, $2)`, [tenant, 996006n]);
  chk(
    'com prazo de 720h, pedido de 100h NÃO expira',
    (await statusDo(996006n))[0]?.status === 'aguardando_pagamento',
    JSON.stringify(await statusDo(996006n)),
  );

  await c.query(
    `update public.tenant_tools set config = coalesce(config,'{}'::jsonb) || '{"horas_expirar_pagamento":"lixo"}'::jsonb
      where tenant_id = $1 and tool_nome = 'vendas'`, [tenant],
  );
  chk('config inválida cai no default de 24h, não desliga a expiração', (
    await c.query(`select public.pedido_horas_para_expirar($1) h`, [tenant])
  ).rows[0].h === 24);

  // -------------------------------------------------------------------------
  console.log('\n-- 8. Rollback --\n');

  const rb = await tentar(R38);
  chk('rollback aplica', rb.erro === null, `veio ${rb.erro}`);
  for (const f of ['pedido_aberto_da_conversa', 'api_n8n_tem_pedido_pendente']) {
    const v = await volatilidade(f);
    chk(`${f}: volta a STABLE`, v[0]?.provolatile === 's', `provolatile=${v[0]?.provolatile}`);
  }
  chk('expirar_pedidos_vencidos some', (
    await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
                    where ns.nspname='public' and p.proname='expirar_pedidos_vencidos'`)
  ).rows[0].n === 0);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log('\n' + '-'.repeat(60));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();

process.exitCode = falhas.length > 0 ? 1 : 0;
