/**
 * Migração 85 — `api_agente_pedido_recente`.
 *
 * Rollback-first (o rollback é `drop function`, idempotente: põe o banco no
 * estado pré-migração tendo ela sido aplicada ou não — sem isso o teste estaria
 * afirmando o calendário, que é o nono defeito da lista do CLAUDE.md). A 85 é
 * aplicada DUAS vezes, porque migração que não é reexecutável deixa de rodar
 * aqui no dia em que entra em produção.
 *
 * O que é medido, e por quê:
 *
 *  - a função devolve o pedido FECHADO e ignora rascunho, cancelado e expirado.
 *    Rascunho é o que `api_n8n_estado_pedido` já cobre; trazê-lo aqui
 *    afrouxaria a regra 1 no caso que ela existe para pegar;
 *  - ela é escopada por tenant E por conversa. O `conversation_id` NÃO é único
 *    entre tenants — é justamente por isso que o teste semeia a mesma conversa
 *    em dois tenants e exige que um não veja o outro;
 *  - o ACL bate com o das IRMÃS `api_agente_*`, não com a lista que eu espero.
 *    Conferir grant contra a própria expectativa é auto-confirmação: a
 *    verificação da 41 conferiu os três roles que eu tinha escrito e reportou
 *    "intactos" — `n8n_agent` não estava na lista porque eu não sabia que
 *    existia, e o catálogo do Empório caiu;
 *  - e a função é CHAMADA como `n8n_agent`, porque `has_function_privilege`
 *    diz o que o ACL contém e chamar diz o que acontece. Chamar como
 *    superusuário não valeria: `postgres` ignora grant.
 *
 * Tudo em transação abortada, numa conexão só.
 *
 *   npm run teste:migracao-pedido-recente
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const ARQ = '20261008180000_85_pedido_recente.sql';
const M85 = fs.readFileSync(path.join(DIR, ARQ), 'utf8').replace(/\r\n/g, '\n');
const ROLLBACK = 'drop function if exists public.api_agente_pedido_recente(uuid, bigint, integer);';
const ASSIN = 'public.api_agente_pedido_recente(uuid, bigint, integer)';

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
const todas = async (sql, p = []) => (await c.query(sql, p)).rows;

try {
  console.log('\n=== 1. Rollback-first, e a 85 aplicada duas vezes ===\n');

  await c.query(ROLLBACK);
  const antes = await um(`select count(*)::int n from pg_proc p join pg_namespace x on x.oid=p.pronamespace
                           where x.nspname='public' and p.proname='api_agente_pedido_recente'`);
  chk('depois do rollback a função não existe', antes.n === 0, `n=${antes.n}`);

  await c.query(M85);
  const depois = await um(`select count(*)::int n from pg_proc p join pg_namespace x on x.oid=p.pronamespace
                            where x.nspname='public' and p.proname='api_agente_pedido_recente'`);
  chk('a 85 cria a função', depois.n === 1, `n=${depois.n}`);

  await c.query(M85);
  const dedois = await um(`select count(*)::int n from pg_proc p join pg_namespace x on x.oid=p.pronamespace
                            where x.nspname='public' and p.proname='api_agente_pedido_recente'`);
  chk('reexecutável: aplicar de novo não duplica assinatura', dedois.n === 1, `n=${dedois.n}`);

  console.log('\n=== 2. O ACL bate com o das IRMÃS, não com o que eu espero ===\n');

  const acl = (await um(
    `select coalesce(p.proacl::text,'(NULO)') a from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=$1`, ['api_agente_pedido_recente'])).a;
  // A referência sai do catálogo: as irmãs `api_agente_*` que já estavam lá.
  const irmas = await todas(
    `select p.proname, coalesce(p.proacl::text,'(NULO)') a from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'api\\_agente\\_%' and p.proname <> 'api_agente_pedido_recente'`);
  chk('a varredura ACHOU irmãs para comparar (lista vazia reprova antes de comparar)', irmas.length > 0, `${irmas.length}`);

  const papeis = (a) => [...new Set([...String(a).matchAll(/([a-z_0-9]*)=[a-zA-Z]+\//g)].map((m) => m[1] || 'PUBLIC'))].sort().join(',');
  const meus = papeis(acl);
  const dasIrmas = [...new Set(irmas.map((i) => papeis(i.a)))];
  chk('as irmãs concordam entre si sobre quais papéis têm execute', dasIrmas.length === 1, dasIrmas.join(' VS '));
  chk('o ACL da função nova é igual ao das irmãs', meus === dasIrmas[0], `nova=[${meus}] irmas=[${dasIrmas[0]}]`);
  chk('nem `anon` nem `authenticated` entraram junto', !/\banon=/.test(acl) && !/\bauthenticated=/.test(acl), acl);
  chk('`n8n_agent` está lá — é o role por onde o serviço conecta', /n8n_agent=/.test(acl), acl);

  console.log('\n=== 3. O que ela devolve ===\n');

  // Dois tenants efêmeros, a MESMA conversa nos dois. `conversation_id` não é
  // único entre tenants, e essa é a razão de existir este par.
  const slugA = 'z-85-a-' + crypto.randomUUID().slice(0, 8);
  const slugB = 'z-85-b-' + crypto.randomUUID().slice(0, 8);
  const novoTenant = async (slug) => (await um(
    `insert into public.tenants (nome, slug, system_prompt) values ($1,$1,'t') returning id`, [slug])).id;
  const tA = await novoTenant(slugA);
  const tB = await novoTenant(slugB);
  const CONV = 999851;

  const novoPedido = async (t, status, total, idade = '1 hour') => (await um(
    `insert into public.pedidos (tenant_id, conversation_id, status, total_centavos, atualizado_em)
     values ($1,$2,$3,$4, now() - $5::interval) returning id, numero`, [t, CONV, status, total, idade])).id;

  const chamar = async (t, horas = 24) => (await todas(
    `select * from public.api_agente_pedido_recente($1,$2,$3)`, [t, CONV, horas]));

  chk('sem pedido nenhum: zero linhas', (await chamar(tA)).length === 0);

  await novoPedido(tA, 'rascunho', 500);
  chk('só rascunho: zero linhas (rascunho é da outra função)', (await chamar(tA)).length === 0);

  await novoPedido(tA, 'cancelado', 700);
  chk('cancelado não conta', (await chamar(tA)).length === 0);
  await novoPedido(tA, 'expirado', 700);
  chk('expirado não conta', (await chamar(tA)).length === 0);

  await novoPedido(tA, 'aguardando_pagamento', 900);
  const r1 = await chamar(tA);
  chk('pedido fechado: uma linha', r1.length === 1, JSON.stringify(r1));
  chk('...com existe=true, status e total', r1[0]?.existe === true && r1[0]?.status === 'aguardando_pagamento' && r1[0]?.total_centavos === 900,
    JSON.stringify(r1[0]));

  // O MAIS RECENTE ganha.
  await novoPedido(tA, 'pago', 1500, '1 minute');
  const r2 = await chamar(tA);
  chk('com dois fechados, vem o mais recente', r2[0]?.status === 'pago' && r2[0]?.total_centavos === 1500, JSON.stringify(r2[0]));

  // A JANELA. Envelhecer o pedido exige DESLIGAR `trg_pedidos_upd`
  // (`set_atualizado_em`), que reescreve `atualizado_em = now()` em todo
  // UPDATE. Sem isso o envelhecimento não entra e a asserção da janela fica
  // vermelha sem defeito nenhum — foi o que aconteceu na primeira execução.
  // Vale a regra: CONFIRME QUE A MUTAÇÃO ENTROU antes de acreditar no
  // resultado. Helper que não muta nada e devolve sucesso é a mesma armadilha
  // da sabotagem que não mutou.
  await c.query('alter table public.pedidos disable trigger trg_pedidos_upd');
  await c.query(`update public.pedidos set atualizado_em = now() - interval '30 hours' where tenant_id = $1`, [tA]);
  await c.query('alter table public.pedidos enable trigger trg_pedidos_upd');
  const envelheceu = await um(
    `select min(now() - atualizado_em) > interval '29 hours' v from public.pedidos where tenant_id=$1`, [tA]);
  chk('o arranjo ENTROU: os pedidos do A estão com mais de 29 h', envelheceu.v === true, JSON.stringify(envelheceu));

  chk('fora da janela de 24 h: zero linhas', (await chamar(tA, 24)).length === 0);
  chk('CONTRAPROVA: com janela de 48 h, aparece', (await chamar(tA, 48)).length === 1);

  console.log('\n=== 4. Isolamento: a mesma conversa em dois tenants ===\n');

  await novoPedido(tB, 'aguardando_pagamento', 4242, '1 minute');
  const doB = await chamar(tB);
  chk('o tenant B vê o SEU pedido (contraprova: o dado existe)', doB.length === 1 && doB[0]?.total_centavos === 4242, JSON.stringify(doB[0]));
  const doA = await chamar(tA, 48);
  chk('o tenant A NÃO vê o pedido do B na mesma conversa', doA.every((r) => r.total_centavos !== 4242), JSON.stringify(doA));

  console.log('\n=== 5. Chamar DE VERDADE como n8n_agent ===\n');

  // `has_function_privilege` diz o que o ACL contém; chamar diz o que acontece.
  // E chamar como `postgres` não valeria: ele ignora grant.
  await c.query('savepoint antes_do_role');
  await c.query('set local role n8n_agent');
  let chamou = false; let erro = null;
  try { await c.query(`select * from public.api_agente_pedido_recente($1,$2,24)`, [tB, CONV]); chamou = true; }
  catch (e) { erro = e.message; }
  await c.query('rollback to savepoint antes_do_role');
  chk('`n8n_agent` consegue chamar a função', chamou, String(erro));

  // E a contraprova do lado fechado: `anon` NÃO consegue.
  await c.query('savepoint antes_anon');
  await c.query('set local role anon');
  let anonChamou = false;
  try { await c.query(`select * from public.api_agente_pedido_recente($1,$2,24)`, [tB, CONV]); anonChamou = true; }
  catch { anonChamou = false; }
  await c.query('rollback to savepoint antes_anon');
  chk('`anon` NÃO consegue chamar', !anonChamou);
} finally {
  // Tudo numa transação só, abortada: nada do que foi semeado sobrevive.
  await c.query('rollback');
  await c.end();
}

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
