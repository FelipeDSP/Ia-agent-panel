/**
 * Migração 86 — o agente atende a CONTA, não uma caixa.
 *
 * Felipe, 10/10: "a IA tem que responder em toda e qualquer caixa de entrada
 * presente na conta à qual aquele robô está aplicado — o robô da Acqua tá nas
 * 2 caixas". O modelo de hoje não suportava: `api_n8n_tenant_por_chatwoot`
 * (54) casa o PAR, e mensagem da segunda caixa não casava linha nenhuma. O
 * serviço respondia 200 e descartava como "não é meu tenant" — o cliente
 * escrevia e não recebia nada, sem erro em lugar nenhum.
 *
 * O teste central é o par de uma coisa só: a MESMA conta, com DUAS caixas
 * diferentes, resolvendo para o MESMO tenant. Com a 54 isso é impossível por
 * construção; é a diferença entre as duas funções e é o defeito.
 *
 * Rollback-first: o rollback recria os dois índices antigos e dropa a função,
 * o que põe o banco no estado pré-migração tendo ela sido aplicada ou não.
 * A 86 é aplicada duas vezes — migração que não é reexecutável deixa de rodar
 * aqui no dia em que entra em produção.
 *
 * Tudo em transação abortada, numa conexão só.
 *
 *   npm run teste:migracao-tenant-por-conta
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M87 = fs.readFileSync(path.join(RAIZ, 'supabase', 'migrations', '20261010210000_87_conta_com_fallback.sql'), 'utf8')
  .replace(/\r\n/g, '\n');
/*
 * O rollback da 87 põe o banco no estado da 86 — e isso inclui RECRIAR a função
 * de UM argumento que a 86 tinha. Não é detalhe: a 87 precisa dropá-la antes de
 * criar a de dois (o segundo com DEFAULT), senão as duas ficam vivas e a chamada
 * com UM argumento vira AMBÍGUA. É a armadilha das migrações 28, 32 e 37.
 *
 * A primeira versão deste rollback dropava a de um argumento, e com isso a
 * sabotagem "a 87 não dropa a assinatura antiga" passava VERDE — a ambiguidade
 * nunca chegava a existir no teste. Replayar a cadeia na ordem em que produção
 * a viu é o que torna a asserção capaz de falhar.
 */
const ROLLBACK = `
  drop function if exists public.api_agente_tenant_por_conta(bigint, bigint);
  drop function if exists public.api_agente_tenant_por_conta(bigint);
  drop index if exists public.idx_tenants_chatwoot_caixa;
  drop index if exists public.idx_tenants_chatwoot_sem_caixa;
  create unique index if not exists idx_tenants_chatwoot_conta
    on public.tenants (chatwoot_account_id)
    where chatwoot_account_id is not null and deletado_em is null;
  create or replace function public.api_agente_tenant_por_conta(p_account_id bigint)
  returns table(tenant_id uuid, slug text, nome text, agente_ativo boolean, system_prompt text,
                modelo text, temperatura numeric, debounce_segundos integer,
                msg_midia_nao_suportada text, msg_fora_escopo text, chatwoot_url text)
  language sql stable security definer set search_path = public, extensions as $rb$
    select t.id, t.slug, t.nome, t.agente_ativo, t.system_prompt, t.modelo, t.temperatura,
           t.debounce_segundos, t.msg_midia_nao_suportada, t.msg_fora_escopo, t.chatwoot_url
      from public.tenants t
     where t.chatwoot_account_id = p_account_id and t.ativo and t.deletado_em is null;
  $rb$;
`;

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
const um = async (q, p = []) => (await c.query(q, p)).rows[0];
const todas = async (q, p = []) => (await c.query(q, p)).rows;

/** O guard de `tenants` barra coluna de agência até para `postgres`. */
const semGuard = async (f) => {
  await c.query('alter table public.tenants disable trigger trg_tenants_guard_colunas');
  try { return await f(); } finally { await c.query('alter table public.tenants enable trigger trg_tenants_guard_colunas'); }
};

try {
  console.log('\n=== 1. Rollback-first, e a 86 duas vezes ===\n');

  await c.query(ROLLBACK);
  // O rollback da 87 volta ao estado da 86, que TEM a função de um argumento.
  // Afirmar "não existe" seria afirmar o estado errado — e foi o que escondeu
  // a sabotagem 8 na primeira rodada.
  const apos = await um(`select count(*)::int n, min(pg_get_function_identity_arguments(p.oid)) args
     from pg_proc p join pg_namespace x on x.oid=p.pronamespace
    where x.nspname='public' and p.proname='api_agente_tenant_por_conta'`);
  chk('depois do rollback sobra a função da 86, com UM argumento',
    apos.n === 1 && apos.args === 'p_account_id bigint', `${apos.n} / ${apos.args}`);

  await c.query(M87);
  chk('a 87 cria a função',
    (await um(`select count(*)::int n from pg_proc p join pg_namespace x on x.oid=p.pronamespace
                where x.nspname='public' and p.proname='api_agente_tenant_por_conta'`)).n === 1);
  await c.query(M87);
  chk('reexecutável: aplicar de novo não duplica',
    (await um(`select count(*)::int n from pg_proc p join pg_namespace x on x.oid=p.pronamespace
                where x.nspname='public' and p.proname='api_agente_tenant_por_conta'`)).n === 1);

  // Os índices da 54 VOLTAM — é o que permite dois agentes na mesma conta, e
  // foi o que a 86 matou sem precisar.
  chk('os dois índices da 54 estão de volta',
    (await um(`select count(*)::int n from pg_indexes where tablename='tenants'
                and indexname in ('idx_tenants_chatwoot_caixa','idx_tenants_chatwoot_sem_caixa')`)).n === 2);
  chk('o índice único por conta (da 86) saiu',
    (await um(`select count(*)::int n from pg_indexes where tablename='tenants' and indexname='idx_tenants_chatwoot_conta'`)).n === 0);

  console.log('\n=== 2. O retorno é o MESMO da 54 (o serviço lê as duas) ===\n');

  // Par derivado: se os tipos divergirem, o serviço quebra em runtime e o
  // typecheck não vê — a tipagem dele descreve a 54.
  const r54 = (await um(`select pg_get_function_result(p.oid) r from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                          where n.nspname='public' and p.proname='api_n8n_tenant_por_chatwoot'`)).r;
  const r86 = (await um(`select pg_get_function_result(p.oid) r from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                          where n.nspname='public' and p.proname='api_agente_tenant_por_conta'`)).r;
  chk('a varredura ACHOU as duas assinaturas', Boolean(r54) && Boolean(r86));
  chk('as colunas de retorno são idênticas', r54 === r86, `54=[${r54}]\n       86=[${r86}]`);

  console.log('\n=== 3. A MESMA conta, DUAS caixas, o MESMO tenant ===\n');

  const slug = 'z-86-' + crypto.randomUUID().slice(0, 8);
  const CONTA = 990086;
  const CAIXA_A = 1001;
  const CAIXA_B = 1002;   // a segunda caixa — o caso da Acqua
  const tid = await semGuard(async () => (await um(
    `insert into public.tenants (nome, slug, system_prompt, chatwoot_account_id, chatwoot_inbox_id)
     values ($1,$1,'t',$2,$3) returning id`, [slug, CONTA, CAIXA_A])).id);

  const porConta = await todas(`select * from public.api_agente_tenant_por_conta($1,$2)`, [CONTA, CAIXA_B]);
  chk('a conta resolve o tenant mesmo pela SEGUNDA caixa (o caso da Acqua)', porConta.length === 1 && porConta[0]?.slug === slug, JSON.stringify(porConta.map((x) => x.slug)));

  // O DEFEITO, medido nas duas funções lado a lado.
  const par_A = await todas(`select * from public.api_n8n_tenant_por_chatwoot($1,$2)`, [CONTA, CAIXA_A]);
  const par_B = await todas(`select * from public.api_n8n_tenant_por_chatwoot($1,$2)`, [CONTA, CAIXA_B]);
  chk('CONTRAPROVA: a função 54 acha pela caixa cadastrada', par_A.length === 1);
  chk('a função 54 NÃO acha pela segunda caixa — é este o defeito', par_B.length === 0, JSON.stringify(par_B.length));
  chk('a 86 acha pela conta, e a caixa do corpo não importa', porConta.length === 1);

  /*
   * A CAIXA GRAVADA NÃO PODE INFLUIR, e esta asserção nasceu de uma sabotagem
   * que passou: eu reintroduzi o filtro de caixa com um valor fixo (1001) e o
   * teste continuou verde, porque o tenant semeado tinha justamente a caixa
   * 1001. Coincidência de fixture escondendo o defeito exato que a migração
   * existe para consertar.
   *
   * A função não recebe caixa, então o jeito de medir é variar a GRAVADA: o
   * mesmo tenant, com a caixa trocada, tem de continuar resolvendo igual.
   */
  await semGuard(() => c.query(`update public.tenants set chatwoot_inbox_id = $2 where id = $1`, [tid, CAIXA_B]));
  const depoisDeTrocar = await todas(`select * from public.api_agente_tenant_por_conta($1)`, [CONTA]);
  chk('trocar a caixa GRAVADA não muda quem a conta resolve',
    depoisDeTrocar.length === 1 && depoisDeTrocar[0]?.slug === slug, JSON.stringify(depoisDeTrocar.map((x) => x.slug)));
  await semGuard(() => c.query(`update public.tenants set chatwoot_inbox_id = $2 where id = $1`, [tid, 777777]));
  const comCaixaEstranha = await todas(`select * from public.api_agente_tenant_por_conta($1)`, [CONTA]);
  chk('...nem com uma caixa que não aparece em lugar nenhum do teste',
    comCaixaEstranha.length === 1, JSON.stringify(comCaixaEstranha.length));
  await semGuard(() => c.query(`update public.tenants set chatwoot_inbox_id = $2 where id = $1`, [tid, CAIXA_A]));

  console.log('\n=== 4. O que ela recusa ===\n');

  // SAVEPOINT em volta da rejeição ESPERADA: sem ele o 22023 aborta a
  // transação inteira e tudo depois morre com 25P02 — foi o que aconteceu na
  // primeira execução, e a suíte perde as asserções seguintes sem avisar qual
  // propriedade quebrou.
  await c.query('savepoint antes_nulo');
  let estourou = false; let codigo = null;
  try { await c.query(`select * from public.api_agente_tenant_por_conta(null)`); }
  catch (e) { estourou = true; codigo = e.code; }
  await c.query('rollback to savepoint antes_nulo');
  chk('conta nula estoura 22023 (nunca valor de reserva)', estourou && codigo === '22023', String(codigo));

  chk('conta desconhecida: zero linhas', (await todas(`select * from public.api_agente_tenant_por_conta($1)`, [999999])).length === 0);

  await semGuard(() => c.query(`update public.tenants set ativo = false where id = $1`, [tid]));
  chk('tenant inativo some', (await todas(`select * from public.api_agente_tenant_por_conta($1)`, [CONTA])).length === 0);
  await semGuard(() => c.query(`update public.tenants set ativo = true where id = $1`, [tid]));

  await semGuard(() => c.query(`update public.tenants set deletado_em = now() where id = $1`, [tid]));
  chk('tenant soft-deletado some', (await todas(`select * from public.api_agente_tenant_por_conta($1)`, [CONTA])).length === 0);
  await semGuard(() => c.query(`update public.tenants set deletado_em = null where id = $1`, [tid]));
  chk('CONTRAPROVA: desfeito o soft delete, volta', (await todas(`select * from public.api_agente_tenant_por_conta($1)`, [CONTA])).length === 1);

  console.log('\n=== 5. DOIS agentes na mesma conta (a capacidade da 54) ===\n');

  /*
   * Esta seção inteira é o conserto da 86. Ela tinha criado índice único por
   * conta e matado a capacidade que a 54 construiu de propósito — e os testes
   * `roteamento-caixa` e `desconectar-chatwoot` ficaram vermelhos acusando
   * exatamente isso. Eram a guarda do desenho fazendo o trabalho dela.
   *
   * Com a 87 as duas coisas convivem, e é isso que se mede aqui.
   */
  const slugB = slug + '-b';
  const tidB = await semGuard(async () => (await um(
    `insert into public.tenants (nome, slug, system_prompt, chatwoot_account_id, chatwoot_inbox_id)
     values ($1,$1,'t',$2,$3) returning id`, [slugB, CONTA, CAIXA_B])).id);
  chk('um SEGUNDO tenant na mesma conta é aceito (a 86 proibia)', Boolean(tidB));

  // Cada um na sua caixa: o estrito manda.
  const estritoA = await todas(`select slug from public.api_agente_tenant_por_conta($1,$2)`, [CONTA, CAIXA_A]);
  const estritoB = await todas(`select slug from public.api_agente_tenant_por_conta($1,$2)`, [CONTA, CAIXA_B]);
  chk('a caixa A resolve o tenant A', estritoA.length === 1 && estritoA[0]?.slug === slug, JSON.stringify(estritoA));
  chk('a caixa B resolve o tenant B', estritoB.length === 1 && estritoB[0]?.slug === slugB, JSON.stringify(estritoB));

  // A sabotagem "o estrito não retorna cedo" passava verde porque NENHUMA
  // asserção cobria o caso comum: conta de UM dono consultada pela PRÓPRIA
  // caixa. Nele o estrito casa E o fallback roderia, devolvendo a mesma linha
  // DUAS vezes. É exatamente o caso da Acqua todo dia.
  await semGuard(() => c.query(`update public.tenants set deletado_em = now() where id = $1`, [tidB]));
  const umDonoCaixaPropria = await todas(`select slug from public.api_agente_tenant_por_conta($1,$2)`, [CONTA, CAIXA_A]);
  chk('conta de UM dono, consultada pela própria caixa: UMA linha (não duas)',
    umDonoCaixaPropria.length === 1, `vieram ${umDonoCaixaPropria.length}: ` + JSON.stringify(umDonoCaixaPropria));
  await semGuard(() => c.query(`update public.tenants set deletado_em = null where id = $1`, [tidB]));

  // E a ambiguidade NÃO vira sorteio: conta com dois donos, caixa de ninguém.
  const terceira = await todas(`select slug from public.api_agente_tenant_por_conta($1,$2)`, [CONTA, 9999]);
  chk('caixa desconhecida numa conta com DOIS donos devolve zero (silêncio, não sorteio)',
    terceira.length === 0, JSON.stringify(terceira));
  const semCaixa = await todas(`select slug from public.api_agente_tenant_por_conta($1)`, [CONTA]);
  chk('...e sem caixa nenhuma, idem', semCaixa.length === 0, JSON.stringify(semCaixa));

  // Tirando o segundo, o fallback volta a valer — é o caso da Acqua.
  await semGuard(() => c.query(`update public.tenants set deletado_em = now() where id = $1`, [tidB]));
  const voltou = await todas(`select slug from public.api_agente_tenant_por_conta($1,$2)`, [CONTA, 9999]);
  chk('com UM dono, a caixa desconhecida cai no fallback e resolve (o caso da Acqua)',
    voltou.length === 1 && voltou[0]?.slug === slug, JSON.stringify(voltou));

  console.log('\n=== 6. Chamar como n8n_agent, e anon não ===\n');

  await c.query('savepoint antes_role');
  await c.query('set local role n8n_agent');
  let chamou = false; let erro = null;
  try { await c.query(`select * from public.api_agente_tenant_por_conta($1)`, [CONTA]); chamou = true; }
  catch (e) { erro = e.message; }
  await c.query('rollback to savepoint antes_role');
  chk('`n8n_agent` consegue chamar', chamou, String(erro));

  await c.query('savepoint antes_anon');
  await c.query('set local role anon');
  let anon = false;
  try { await c.query(`select * from public.api_agente_tenant_por_conta($1)`, [CONTA]); anon = true; } catch { anon = false; }
  await c.query('rollback to savepoint antes_anon');
  chk('`anon` NÃO consegue chamar', !anon);

  const acl = (await um(`select coalesce(p.proacl::text,'(NULO)') a from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                          where n.nspname='public' and p.proname='api_agente_tenant_por_conta'`)).a;
  chk('nem anon nem authenticated no ACL', !/\banon=|\bauthenticated=/.test(acl), acl);
  chk('`n8n_agent` no ACL', /n8n_agent=/.test(acl), acl);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
