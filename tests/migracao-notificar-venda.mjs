#!/usr/bin/env node
/**
 * Migração 52 (notificação de venda) numa TRANSAÇÃO ABORTADA contra produção.
 * Nada é gravado: o rollback no fim é incondicional.
 *
 * O QUE ELE PROVA, e ler o SQL não prova:
 *
 *   - IDEMPOTÊNCIA, que é a razão de a função existir. Chamar duas vezes
 *     notifica UMA. O modelo re-chama tool quando acha que falhou — foi assim
 *     que nasceu o pedido de R$ 75,00 — e aqui a defesa está no banco, não na
 *     confiança de o n8n chamar uma vez;
 *   - que RESERVAR NÃO É ENTREGAR: só `enviado_em` conta como notificado.
 *     Reserva presa (n8n morreu no meio) e falha do WAHA são as duas
 *     re-notificáveis; envio bem-sucedido não é, nunca mais;
 *   - que config vazia NÃO GASTA O CLAIM. Os quatro tenants estão com
 *     `vendas.config = {}` hoje; se a primeira venda queimasse a reserva,
 *     preencher o número depois não adiantaria nada;
 *   - ISOLAMENTO com três tenants efêmeros, e `conversation_id` repetido entre
 *     dois deles — porque `conversation_id` não é único entre clientes;
 *   - que as duas funções são executáveis por `n8n_agent`, chamando DE VERDADE
 *     como ele. `has_function_privilege` diz o que o ACL contém; chamar diz o
 *     que acontece. E chamar como `postgres` não valeria: superusuário ignora
 *     grant;
 *   - quanto o claim ATRASA O RELÓGIO DA EXPIRAÇÃO (defeito 1 de
 *     docs/PENDENCIA-EXPIRACAO-PEDIDO.md), medido em segundos em vez de
 *     suposto.
 *
 * E RENDERIZA A MENSAGEM com o pedido real do `emporio` (nº 1, conversa 3,
 * R$ 45,00), para que o texto seja lido como ele chega no celular do dono —
 * ainda dentro da transação revertida.
 *
 * AS SABOTAGENS (seção 8) tiram a condição do claim e o filtro de tenant, e
 * exigem que o teste FIQUE VERMELHO. Se não derrubarem, este arquivo não está
 * medindo idempotência nem isolamento — está medindo que uma query roda.
 *
 * Uso: npm run teste:notificar-venda
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DIR = `${RAIZ}supabase/migrations/`;
function acharMigracao(sufixo) {
  const a = fs.readdirSync(DIR).filter((f) => f.endsWith(sufixo));
  if (a.length !== 1) throw new Error(`esperava 1 arquivo em "${sufixo}", achei ${a.length}`);
  return fs.readFileSync(DIR + a[0], 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
}
const M52 = acharMigracao('_52_notificar_venda.sql');
const R52 = acharMigracao('_52_notificar_venda_rollback.sql');

if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

let ok = 0;
let okSus = 0;
const falhas = [];
const chk = (n, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${n}`); }
  else { falhas.push(`${n}${det ? ` — ${det}` : ''}`); console.log(`  FALHA ${n}${det ? ` — ${det}` : ''}`); }
};
const sus = (n, cond, det = '') => {
  if (cond) { okSus++; console.log(`  OK  ~ ${n}`); }
  else { falhas.push(`[sustentação] ${n}${det ? ` — ${det}` : ''}`); console.log(`  FALHA ~ ${n}${det ? ` — ${det}` : ''}`); }
};

/** Rejeição inesperada vira FALHA, não crash: `await` cru derruba o processo
 *  antes das asserções seguintes e você fica sem saber o que quebrou. */
async function tentar(sql, p = []) {
  await c.query('savepoint sp');
  try {
    const r = await c.query(sql, p);
    await c.query('release savepoint sp');
    return { erro: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sp');
    return { erro: e.message, codigo: e.code, rows: [] };
  }
}

/** Chama COMO `n8n_agent`. É o único caminho que prova o grant: `postgres`
 *  ignora ACL, e foi exatamente esse o erro da verificação da 41. */
async function comoN8n(sql, p = []) {
  await c.query('savepoint sn');
  try {
    await c.query('set local role n8n_agent');
    const r = await c.query(sql, p);
    await c.query('reset role');
    await c.query('release savepoint sn');
    return { erro: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sn');
    await c.query('reset role');
    return { erro: e.message, codigo: e.code, rows: [] };
  }
}

const contarFuncoes = async () => (await c.query(
  `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname in ('api_n8n_notificar_venda', 'api_n8n_confirmar_notificacao')`)).rows[0].n;

/** Semeia um tenant com tool `vendas`, a conversa e (por padrão) um produto e
 *  um pedido FECHADO. `comPedido: false` serve à sabotagem de isolamento: um
 *  tenant que NÃO tem pedido naquela conversa é quem revela o vazamento. */
async function semear(rotulo, conv, config, comPedido = true) {
  const t = (await c.query(
    `insert into public.tenants (slug, nome, ativo) values ($1, $2, true) returning id`,
    [`zz-efem-notif52-${rotulo}`, `efêmero notif 52 ${rotulo}`])).rows[0].id;
  await c.query(
    `insert into public.tenant_tools (tenant_id, tool_nome, ativo, contratado, config)
     values ($1, 'vendas', true, true, $2::jsonb)`, [t, JSON.stringify(config)]);
  await c.query(
    `insert into public.conversas (tenant_id, conversation_id, contact_name, phone, status)
     values ($1, $2, $3, $4, 'ativo')`,
    [t, conv, `Cliente ${rotulo}`, `5569900${String(conv).slice(-5)}`]);
  if (!comPedido) return { t, conv, ped: null };
  const prod = (await c.query(
    `insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel)
     values ($1, $2, 750, 'un', true) returning id`, [t, `7 - Bolo de ${rotulo}`])).rows[0].id;
  await c.query(`select public.api_n8n_adicionar_item($1::uuid, $2::bigint, $3::uuid, 2)`, [t, conv, prod]);
  await c.query(`select public.api_n8n_fechar_pedido($1::uuid, $2::bigint, $3::text)`,
    [t, conv, JSON.stringify({ entrega: `retirada ${rotulo}` })]);
  const ped = (await c.query(
    `select id, numero, status from public.pedidos
      where tenant_id = $1 and conversation_id = $2`, [t, conv])).rows[0];
  return { t, conv, ped };
}

const notificacaoDe = async (pedidoId) => (await c.query(
  `select metadados #> '{notificacao}' n from public.pedidos where id = $1`, [pedidoId])).rows[0].n;

await c.connect();
const funcoesAntesDeTudo = await contarFuncoes();
await c.query('begin');

try {
  console.log('\n== Migração 52: notificação de venda ==\n');

  console.log('-- 1. Estado de ANTES, e a migração --\n');
  await c.query(R52);
  sus('o rollback deixou o banco no estado pré-52 (nenhuma das duas funções)',
    (await contarFuncoes()) === 0);

  const ap = await tentar(M52);
  chk('a migração aplica', ap.erro === null, ap.erro ?? '');
  chk('as DUAS funções existem', (await contarFuncoes()) === 2);

  console.log('\n-- 2. Grants: os DOIS roles, e nenhum a mais --\n');
  const acls = (await c.query(
    `select p.proname, coalesce(p.proacl::text, '(default)') acl
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public'
        and p.proname in ('api_n8n_notificar_venda', 'api_n8n_confirmar_notificacao')
      order by p.proname`)).rows;
  acls.forEach((r) => console.log(`      ${r.proname}: ${r.acl}`));
  /*
   * Não basta conferir os roles que EU escrevi — isso é auto-confirmação, e foi
   * o erro da verificação da 41. O que vale é o DIFF contra as irmãs: as 19
   * `api_n8n_*` de produção têm exatamente {postgres, service_role, n8n_agent}.
   *
   * E foi esta seção que pegou um defeito real nesta migração: sem os `revoke`,
   * o ACL saiu com `=X/postgres` (PUBLIC) mais `anon` e `authenticated` — uma
   * SECURITY DEFINER que devolve nome, telefone e itens do cliente, ao alcance
   * da chave anônima. Nenhuma das sete que a migração 43 fechou tinha `anon=`
   * próprio: todas passavam por PUBLIC, exatamente como esta ia passar.
   */
  const padraoIrmas = (await c.query(
    `select distinct coalesce(p.proacl::text, '(default)') acl
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname like 'api\\_n8n\\_%'
        and p.proname not in ('api_n8n_notificar_venda', 'api_n8n_confirmar_notificacao')`)).rows;
  const rolesIrmas = new Set(padraoIrmas
    .flatMap((r) => r.acl.replace(/[{}]/g, '').split(','))
    .map((g) => g.split('=')[0]));
  console.log(`      irmãs concedem a: {${[...rolesIrmas].sort().join(', ')}}`);
  sus('as irmãs `api_n8n_*` têm um padrão de ACL para comparar (anti-vacuidade)',
    rolesIrmas.size > 0 && rolesIrmas.has('n8n_agent'), [...rolesIrmas].join(','));

  for (const r of acls) {
    chk(`${r.proname} concedida a service_role`, /service_role=X/.test(r.acl), r.acl);
    // A linha que faltou nas migrações 40 e 41. O n8n não passa por PostgREST.
    chk(`${r.proname} concedida a n8n_agent (o role com que o n8n conecta)`,
      /n8n_agent=X/.test(r.acl), r.acl);
    // PUBLIC vem antes de anon na ordem de descoberta porque é o default do
    // Postgres, não uma configuração deste projeto — e é invisível por nome.
    chk(`${r.proname} NÃO deixou EXECUTE para PUBLIC`, !/\{=X\//.test(r.acl), r.acl);
    chk(`${r.proname} NÃO abriu para anon`, !/(^|,|\{)anon=X/.test(r.acl), r.acl);
    chk(`${r.proname} NÃO abriu para authenticated`, !/authenticated=X/.test(r.acl), r.acl);
    const meus = new Set(r.acl.replace(/[{}]/g, '').split(',').map((g) => g.split('=')[0]));
    chk(`${r.proname} tem o MESMO conjunto de roles das irmãs (diff, não expectativa)`,
      [...rolesIrmas].every((x) => meus.has(x)) && [...meus].every((x) => rolesIrmas.has(x)),
      `esta: {${[...meus].sort().join(', ')}} vs irmãs: {${[...rolesIrmas].sort().join(', ')}}`);
  }

  console.log('\n-- 3. Arranjo: três tenants, dois com o MESMO conversation_id --\n');
  const suf = Math.random().toString(16).slice(2, 8);
  const CONV = 9_520_000 + Math.floor(Math.random() * 1000);
  const CFG_OK = { notificacao: { canal: 'waha', sessao: `sessao-${suf}`, destino: `5569900000000@c.us` } };

  const A = await semear(`${suf}-a`, CONV, CFG_OK);
  const B = await semear(`${suf}-b`, CONV, CFG_OK);           // MESMO conversation_id
  const C = await semear(`${suf}-c`, CONV + 7, {});           // config VAZIA, como os 4 de hoje
  // E tem config e conversa, e NÃO tem pedido — no mesmo conversation_id de A e
  // B. É ele quem revela vazamento na seção 9.
  const E = await semear(`${suf}-e`, CONV, CFG_OK, false);

  for (const [nome, s] of [['A', A], ['B', B], ['C', C]]) {
    sus(`tenant ${nome} tem pedido nº ${s.ped.numero} em ${s.ped.status} (anti-vacuidade)`,
      s.ped.status === 'aguardando_pagamento' && s.ped.numero !== null,
      JSON.stringify(s.ped));
  }
  sus('tenant E tem conversa no MESMO conversation_id e nenhum pedido',
    E.ped === null
    && (await c.query(`select count(*)::int n from public.pedidos where tenant_id = $1`, [E.t])).rows[0].n === 0);

  const semPedido = await comoN8n(
    `select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [E.t, E.conv]);
  chk('tenant sem pedido fechado nessa conversa: zero linhas, mesmo com config cheia',
    semPedido.erro === null && semPedido.rows.length === 0,
    semPedido.erro ?? `${semPedido.rows.length} linhas`);

  console.log('\n-- 4. Config vazia: zero linhas, e o CLAIM NÃO É GASTO --\n');
  const semCfg = await comoN8n(
    `select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [C.t, C.conv]);
  chk('com `config = {}` a função devolve ZERO linhas',
    semCfg.erro === null && semCfg.rows.length === 0, semCfg.erro ?? `${semCfg.rows.length} linhas`);
  chk('e NÃO gravou reserva nenhuma (preencher o número amanhã ainda vale)',
    (await notificacaoDe(C.ped.id)) === null, JSON.stringify(await notificacaoDe(C.ped.id)));

  // Contraprova: o mesmo tenant, agora COM config, notifica. Sem isto, "zero
  // linhas" seria verdade também com a função quebrada.
  await c.query(`update public.tenant_tools set config = $2::jsonb
                  where tenant_id = $1 and tool_nome = 'vendas'`, [C.t, JSON.stringify(CFG_OK)]);
  const comCfg = await comoN8n(
    `select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [C.t, C.conv]);
  sus('contraprova: preenchida a config, o MESMO tenant passa a notificar',
    comCfg.rows.length === 1, comCfg.erro ?? `${comCfg.rows.length} linhas`);

  console.log('\n-- 5. O caminho feliz, e a IDEMPOTÊNCIA --\n');
  const antesRelogio = (await c.query(
    `select atualizado_em from public.pedidos where id = $1`, [A.ped.id])).rows[0].atualizado_em;

  const um = await comoN8n(
    `select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [A.t, A.conv]);
  chk('1ª chamada devolve exatamente 1 linha', um.rows.length === 1, um.erro ?? `${um.rows.length}`);
  chk('com sessão e destino vindos da config de `vendas`',
    um.rows[0]?.sessao === CFG_OK.notificacao.sessao && um.rows[0]?.destino === CFG_OK.notificacao.destino,
    JSON.stringify(um.rows[0] ?? null));
  chk('e a reserva ficou gravada (`reservado_em`)',
    (await notificacaoDe(A.ped.id))?.reservado_em !== undefined,
    JSON.stringify(await notificacaoDe(A.ped.id)));
  chk('e NADA de `enviado_em` ainda — reservar não é entregar',
    (await notificacaoDe(A.ped.id))?.enviado_em === undefined,
    JSON.stringify(await notificacaoDe(A.ped.id)));

  const dois = await comoN8n(
    `select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [A.t, A.conv]);
  chk('2ª chamada devolve ZERO linhas — o dono não recebe dois WhatsApps',
    dois.erro === null && dois.rows.length === 0, dois.erro ?? `${dois.rows.length} linhas`);

  // O defeito 1 de PENDENCIA-EXPIRACAO-PEDIDO, medido em vez de suposto: o
  // claim escreve em `pedidos` e `trg_pedidos_upd` reescreve `atualizado_em`.
  const depoisRelogio = (await c.query(
    `select atualizado_em from public.pedidos where id = $1`, [A.ped.id])).rows[0].atualizado_em;
  const desvio = (new Date(depoisRelogio) - new Date(antesRelogio)) / 1000;
  console.log(`        (relógio da expiração andou ${desvio.toFixed(1)}s por causa do claim)`);
  chk('o claim adia a expiração em segundos, não em horas (defeito 1, medido)',
    desvio >= 0 && desvio < 5, `${desvio}s`);

  console.log('\n-- 6. Reserva presa e falha são re-notificáveis; envio não é --\n');
  const envelhecer = (pedido, min) => c.query(
    `update public.pedidos
        set metadados = jsonb_set(metadados, '{notificacao,reservado_em}',
                                  to_jsonb(now() - make_interval(mins => $2::int)))
      where id = $1`, [pedido, min]);

  await envelhecer(A.ped.id, 10);
  const tres = await comoN8n(
    `select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [A.t, A.conv]);
  chk('reserva presa há 10 min pode ser RETOMADA (o n8n morreu no meio)',
    tres.rows.length === 1, tres.erro ?? `${tres.rows.length} linhas`);

  const conf = await comoN8n(
    `select public.api_n8n_confirmar_notificacao($1::uuid, $2::uuid, true, null) v`, [A.t, A.ped.id]);
  chk('`confirmar_notificacao(ok)` grava `enviado_em`',
    conf.rows[0]?.v === true && (await notificacaoDe(A.ped.id))?.enviado_em !== undefined,
    JSON.stringify(await notificacaoDe(A.ped.id)));

  await envelhecer(A.ped.id, 999);
  const quatro = await comoN8n(
    `select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [A.t, A.conv]);
  chk('com `enviado_em` gravado, NENHUMA idade retoma a reserva',
    quatro.rows.length === 0, `${quatro.rows.length} linhas`);

  const falha = await comoN8n(
    `select public.api_n8n_confirmar_notificacao($1::uuid, $2::uuid, false, $3::text) v`,
    [A.t, A.ped.id, 'WAHA 502: session emporio not connected']);
  const nFalha = await notificacaoDe(A.ped.id);
  chk('`confirmar_notificacao(falha)` grava `falhou_em` + detalhe',
    falha.rows[0]?.v === true && nFalha?.falhou_em !== undefined && /502/.test(nFalha?.detalhe ?? ''),
    JSON.stringify(nFalha));
  chk('e LIMPA o `enviado_em` — "notificado" tem uma leitura só',
    nFalha?.enviado_em === undefined, JSON.stringify(nFalha));

  const cinco = await comoN8n(
    `select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [A.t, A.conv]);
  chk('e depois da falha a venda volta a ser notificável',
    cinco.rows.length === 1, `${cinco.rows.length} linhas`);

  console.log('\n-- 7. ISOLAMENTO: mesmo conversation_id em A e B --\n');
  const bNotif = await comoN8n(
    `select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [B.t, B.conv]);
  chk('B notifica o PRÓPRIO pedido, não o de A',
    bNotif.rows.length === 1 && bNotif.rows[0]?.pedido_id === B.ped.id,
    `devolveu ${bNotif.rows[0]?.pedido_id} — o de B é ${B.ped.id}, o de A é ${A.ped.id}`);
  chk('e o texto de B cita o cliente de B (contraprova de que há dado nos dois)',
    /Cliente .*-b/.test(bNotif.rows[0]?.mensagem ?? ''),
    (bNotif.rows[0]?.mensagem ?? '').split('\n')[2] ?? '');

  const confCruzado = await comoN8n(
    `select public.api_n8n_confirmar_notificacao($1::uuid, $2::uuid, true, null) v`, [B.t, A.ped.id]);
  chk('B NÃO consegue confirmar o pedido de A (escopo de tenant no update)',
    confCruzado.rows[0]?.v === false, String(confCruzado.rows[0]?.v));

  console.log('\n-- 8. Reexecutável e rollback --\n');
  const r2 = await tentar(M52);
  chk('aplicar duas vezes não quebra', r2.erro === null, r2.erro ?? '');
  await c.query(R52);
  chk('o rollback derruba as duas', (await contarFuncoes()) === 0);
  chk('e NÃO leva `api_n8n_fechar_pedido` junto',
    (await c.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public' and p.proname = 'api_n8n_fechar_pedido'`)).rows[0].n === 1);
  await c.query(M52);

  console.log('\n-- 9. Sabotagens --\n');
  // Normaliza a quebra de linha ANTES de casar: regex multi-linha com `\n` nunca
  // casa em arquivo CRLF, e sabotagem que não muta nada já imprimiu verde neste
  // repo. Por isso cada bloco confirma a mutação antes de acreditar no resultado.
  const SQL = M52.replace(/\r\n/g, '\n');
  {
    /*
     * S1 — tira a condição INTEIRA do claim.
     *
     * A primeira versão desta sabotagem tirava só o `enviado_em is null` e o
     * teste seguia verde: a outra metade da condição (a janela de reserva)
     * continuava bloqueando sozinha. Sabotagem parcial mede a metade que
     * sobrou, não a propriedade.
     */
    const ALVO = /and p\.metadados #> '\{notificacao,enviado_em\}' is null[\s\S]*?make_interval\(mins => v_janela\);/;
    sus('S1 o alvo existe no SQL (senão a sabotagem seria decorativa)', ALVO.test(SQL));
    const sab = SQL.replace(ALVO, ';');
    sus('S1 a mutação entrou (a condição do claim saiu por inteiro)',
      sab !== SQL && !ALVO.test(sab));
    const apS = await tentar(sab);
    sus('S1 a versão sabotada aplica', apS.erro === null, apS.erro ?? '');

    const D = await semear(`${suf}-s1`, CONV + 21, CFG_OK);
    const p1 = await comoN8n(`select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [D.t, D.conv]);
    const p2 = await comoN8n(`select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [D.t, D.conv]);
    chk('S1 sem a condição do claim, a MESMA venda notifica duas vezes (o teste reprova)',
      p1.rows.length === 1 && p2.rows.length === 1,
      `1ª=${p1.rows.length} 2ª=${p2.rows.length} — se a 2ª for 0, este arquivo NÃO mede idempotência`);
    await c.query(M52);
  }
  {
    /*
     * S2 — tira o filtro de tenant da busca do pedido E do claim.
     *
     * Tirar só o do `select` também não bastava: o `update` do claim tem o seu,
     * e ele sozinho já barrava o pedido alheio. Duas camadas, e a sabotagem
     * precisa remover as duas para provar que o teste enxerga vazamento.
     *
     * E quem revela o vazamento é um tenant SEM pedido naquela conversa: com A
     * e B ambos tendo pedido, `order by criado_em desc` empata (numa transação
     * `now()` é o mesmo para todo mundo) e o desempate podia devolver o próprio
     * pedido de A — falso verde por acidente de ordenação. Foi o que aconteceu
     * na primeira versão.
     */
    const ALVO = /p\.tenant_id\s*=\s*p_tenant_id/g;
    sus('S2 o alvo existe no SQL', (SQL.match(ALVO) ?? []).length >= 2,
      `${(SQL.match(ALVO) ?? []).length} ocorrências`);
    const sab = SQL.replace(ALVO, 'true');
    sus('S2 a mutação entrou (os filtros de tenant de `pedidos` saíram)',
      sab !== SQL && !new RegExp(ALVO.source).test(sab));
    const apS = await tentar(sab);
    sus('S2 a versão sabotada aplica', apS.erro === null, apS.erro ?? '');

    // As seções 5-7 deixaram reserva gravada em A e B. Sem limpar, o claim
    // barraria o vazamento pela condição de idempotência e não pelo filtro de
    // tenant — a sabotagem mediria a defesa errada e voltaria falso verde.
    await c.query(`update public.pedidos set metadados = metadados - 'notificacao'
                    where id in ($1, $2)`, [A.ped.id, B.ped.id]);
    sus('S2 as reservas de A e B foram limpas (senão a idempotência esconderia o vazamento)',
      (await notificacaoDe(A.ped.id)) === null && (await notificacaoDe(B.ped.id)) === null);

    const vaza = await comoN8n(
      `select * from public.api_n8n_notificar_venda($1::uuid, $2::bigint)`, [E.t, E.conv]);
    chk('S2 sem o filtro de tenant, E (que não tem pedido) recebe o pedido de OUTRO tenant',
      vaza.rows.length === 1,
      `devolveu ${vaza.rows.length} linha(s) — se for 0, a sabotagem não mudou o comportamento` +
      ' e este arquivo NÃO mede isolamento');
    if (vaza.rows.length === 1) {
      console.log(`        (E vazou o pedido ${vaza.rows[0].pedido_id} — de A é ${A.ped.id}, de B é ${B.ped.id})`);
    }
    await c.query(M52);
  }

  console.log('\n-- 10. A MENSAGEM, com o pedido REAL do emporio --\n');
  const emp = (await c.query(`select id from public.tenants where slug = 'emporio'`)).rows[0];
  if (!emp) {
    sus('tenant `emporio` encontrado', false, 'não achei o slug');
  } else {
    // Dentro da transação revertida: liga a config e limpa qualquer reserva,
    // para que a função renderize como renderizaria na venda de verdade.
    await c.query(`update public.tenant_tools set config = $2::jsonb
                    where tenant_id = $1 and tool_nome = 'vendas'`,
      [emp.id, JSON.stringify({ notificacao: { canal: 'waha', sessao: 'emporio', destino: '5569984043130@c.us' } })]);
    await c.query(`update public.pedidos set metadados = metadados - 'notificacao'
                    where tenant_id = $1 and conversation_id = 3`, [emp.id]);

    const real = await comoN8n(
      `select * from public.api_n8n_notificar_venda($1::uuid, 3::bigint)`, [emp.id]);
    chk('o pedido real do emporio (conv 3) rende uma notificação',
      real.rows.length === 1, real.erro ?? `${real.rows.length} linhas`);
    if (real.rows.length === 1) {
      const m = real.rows[0].mensagem;
      console.log('\n    ┌─ como chega no celular do dono ' + '─'.repeat(38));
      m.split('\n').forEach((l) => console.log(`    │ ${l}`));
      console.log('    └' + '─'.repeat(70) + '\n');
      chk('a mensagem traz o número do pedido', /pedido nº 1/.test(m), m.split('\n')[0]);
      chk('traz o nome do cliente', /Romilto/.test(m));
      chk('traz o telefone com `+` (o WhatsApp só transforma em link assim)',
        /\+5569992425314/.test(m));
      chk('traz os TRÊS itens com quantidade', (m.match(/^- \d+x /gm) ?? []).length === 3,
        `${(m.match(/^- \d+x /gm) ?? []).length} linhas de item`);
      chk('traz o total de R$ 45,00', /Total: R\$ 45,00/.test(m));
      chk('traz a entrega de `metadados`', /Entrega: retirada à tarde/.test(m));
      chk('e a ordem é número → cliente → itens → total → entrega',
        m.indexOf('pedido nº') < m.indexOf('Romilto')
        && m.indexOf('Romilto') < m.indexOf('- 2x')
        && m.indexOf('- 2x') < m.indexOf('Total:')
        && m.indexOf('Total:') < m.indexOf('Entrega:'));
    }
  }
} catch (e) {
  falhas.push(`exceção não prevista: ${e.message}`);
  console.log(`  FALHA exceção não prevista — ${e.message}`);
} finally {
  await c.query('rollback');
  const depois = await contarFuncoes();
  console.log(`\n  (transação revertida; funções em produção: ${depois}` +
    ` — igual a antes: ${funcoesAntesDeTudo === depois ? 'sim' : 'NÃO'})`);
  if (funcoesAntesDeTudo !== depois) falhas.push('o teste mudou o schema de produção');
  const sobra = (await c.query(
    `select count(*)::int n from public.tenants where slug like 'zz-efem-notif52-%'`)).rows[0].n;
  console.log(`  (tenants efêmeros sobrando: ${sobra})`);
  if (sobra > 0) falhas.push(`${sobra} tenant(s) efêmero(s) sobraram`);
  await c.end();
}

console.log('\n----------------------------------------------------------');
console.log(`  ${ok + okSus} passaram, ${falhas.length} falharam`);
console.log(`    ${ok} por motivo próprio (propriedade da migração)`);
console.log(`    ${okSus} de sustentação (~) — provam que o TESTE faz o que diz`);
falhas.forEach((f) => console.log(`  ! ${f}`));
console.log();
process.exit(falhas.length === 0 ? 0 : 1);
