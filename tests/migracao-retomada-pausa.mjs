#!/usr/bin/env node
/**
 * Migração 47 (retomada da pausa) numa TRANSAÇÃO ABORTADA contra produção. Nada
 * é gravado: o rollback no fim é incondicional.
 *
 * O QUE ELE PROVA, e ler o SQL não prova:
 *
 *   - que o ACL das TRÊS `api_n8n_*` tocadas atravessa a migração INTACTO. A 47
 *     não mexe em assinatura nenhuma, e é essa afirmação que precisa de prova:
 *     o teste tira um retrato do ACL antes e compara com o de depois, em vez de
 *     conferir contra a lista que eu escrevi — que foi exatamente como a 41
 *     passou verde sem `n8n_agent`;
 *   - que continua existindo EXATAMENTE UMA assinatura viva de cada uma. Duas
 *     tornariam ambígua a chamada que o n8n faz (28, 32, 37);
 *   - que `n8n_agent` consegue CHAMAR as três depois da migração. Chamar, não
 *     `has_function_privilege`: um diz o que o ACL contém, o outro diz o que
 *     acontece;
 *   - a TABELA VERDADE do predicado, com o estado ARRANJADO pelo teste — pausa
 *     manual velha não caduca, pausa por mensagem humana velha caduca, motivo
 *     nulo cai para o lado alto;
 *   - que `api_n8n_conversa_sync` e `api_n8n_pode_transcrever` NÃO DIVERGEM na
 *     mesma conversa. É a propriedade central da 47: predicado duplicado diverge
 *     entre "o painel diz pausada" e "o bot já respondeu";
 *   - que a janela é DO TENANT, com duas conversas de MESMO `conversation_id` em
 *     tenants diferentes — `conversation_id` não é único entre clientes, e é
 *     essa a armadilha que `tests/isolamento-pedidos.mjs` já existe para cobrir
 *     noutra tabela;
 *   - que aplicar a migração não muda o `status` de ninguém nem pausa/despausa
 *     ninguém (contagem por status antes × depois). Isso é PROPRIEDADE. "Hoje há
 *     11 pausadas" seria estado do mundo e ficaria falso na próxima mensagem —
 *     pausar conversa é operação normal.
 *
 * A SABOTAGEM (seção 10) remove, uma por vez, as linhas que sustentam essas
 * propriedades, e exige que o teste reprove. Sem ela isto seria só uma lista de
 * coisas que passaram. Cada sabotagem confirma antes que a MUTAÇÃO ENTROU — já
 * houve neste repo sabotagem que não mutou nada e imprimiu verde.
 *
 * O ARQUIVO É RESOLVIDO POR PADRÃO, não por nome fixo: a 47 vai ser renomeada
 * para bater com a versão do ledger quando for aplicada fora do CLI (CLAUDE.md,
 * seção Migrações), e um nome fixo aqui quebraria exatamente nesse dia.
 *
 * Uso: npm run teste:retomada-pausa
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DIR = RAIZ + 'supabase/migrations/';

/** Acha o arquivo pelo sufixo, para sobreviver ao rename do ledger. */
function acharMigracao(sufixo) {
  const achados = fs.readdirSync(DIR).filter((f) => f.endsWith(sufixo));
  if (achados.length !== 1) {
    throw new Error(`esperava exatamente 1 arquivo terminando em "${sufixo}", achei ${achados.length}: ${achados.join(', ')}`);
  }
  return fs.readFileSync(DIR + achados[0], 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
}

const M47 = acharMigracao('_47_retomada_pausa.sql');
const R47 = acharMigracao('_47_retomada_pausa_rollback.sql');

if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

let ok = 0;
let okSus = 0;
const falhas = [];
const avisos = [];

/**
 * `chk` = a asserção passa por MOTIVO PRÓPRIO: mede uma propriedade da migração
 * que importaria em produção.
 *
 * `sus` = SUSTENTAÇÃO: não mede a migração, mede o TESTE — que a mutação entrou,
 * que o arranjo pegou, que a precondição é a que se diz, que a versão sabotada
 * chegou a aplicar. Contar as duas juntas infla o número e esconde quanto do
 * verde é sobre o sistema. Marcadas com `~` na saída.
 */
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};
const sus = (nome, cond, det = '') => {
  if (cond) { okSus++; console.log(`  OK  ~ ${nome}`); }
  else { falhas.push(`[sustentação] ${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ~ ${nome}${det ? ' — ' + det : ''}`); }
};
const aviso = (txt) => { avisos.push(txt); console.log(`  AVISO ${txt}`); };

/** Roda em savepoint: erro esperado vira valor, não aborta a transação inteira. */
async function tentar(sql, params = []) {
  await c.query('savepoint sp');
  try {
    const r = await c.query(sql, params);
    await c.query('release savepoint sp');
    return { erro: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sp');
    return { erro: e.message, codigo: e.code, rows: [] };
  }
}

/**
 * Chama COMO outro role. Rejeição vira VALOR, não crash — `await` cru numa
 * chamada que a sabotagem faz estourar derrubaria o processo antes das
 * asserções seguintes, e ninguém saberia qual propriedade quebrou.
 */
async function comoRole(role, sql, params = []) {
  await c.query('savepoint sp_role');
  try {
    await c.query(`set local role ${role}`);
    const r = await c.query(sql, params);
    await c.query('reset role');
    await c.query('release savepoint sp_role');
    return { erro: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sp_role');
    await c.query('reset role');
    return { erro: e.message, codigo: e.code, rows: [] };
  }
}

/**
 * Roda UM comando com claim de super_admin, e devolve a sessão ao estado sem
 * claim nenhuma.
 *
 * POR QUE ISTO EXISTE, e é a correção de um falso verde: `tenants` tem
 * `trg_tenants_guard_colunas` (BEFORE UPDATE FOR EACH ROW), que levanta `42501`
 * para coluna fora da lista branca a menos que `auth_is_super_admin()`. A
 * primeira versão deste teste setava a claim UMA VEZ no topo — para criar os
 * tenants efêmeros — e com ela ligada a migração aplicava numa condição que o
 * apply real (psql, MCP, editor do Supabase) NÃO tem. A 47 tinha um
 * `update public.tenants` que teria derrubado a migração em produção, e este
 * teste dizia verde.
 *
 * Agora a claim é escopada ao comando que precisa dela, e a migração aplica
 * exatamente como vai aplicar de verdade: sem claim.
 */
const CLAIM_SUPER = `'{"app_metadata":{"papel":"super_admin"}}'`;
async function comoSuper(c, sql, params = []) {
  await c.query(`set local request.jwt.claims = ${CLAIM_SUPER}`);
  try {
    return await c.query(sql, params);
  } finally {
    await c.query(`reset request.jwt.claims`);
  }
}

const FUNCOES = ['api_n8n_definir_status_conversa', 'api_n8n_conversa_sync', 'api_n8n_pode_transcrever'];

/** ACL como conjunto de roles com EXECUTE — é o diff que pega grant perdido. */
async function aclDe(nome) {
  const { rows } = await c.query(
    `select coalesce(p.proacl::text[], array[]::text[]) acl
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = $1`, [nome]);
  return (rows[0]?.acl ?? []).map((e) => (e.split('=')[0] === '' ? 'PUBLIC' : e.split('=')[0])).sort();
}
async function aclDeTodas() {
  const out = {};
  for (const f of FUNCOES) out[f] = await aclDe(f);
  return out;
}
async function assinaturasDe(nome) {
  return (await c.query(
    `select p.pronargs::int n, pg_get_function_identity_arguments(p.oid) tipos
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = $1 order by n`, [nome])).rows;
}

/** Contagem por status na tabela INTEIRA — a propriedade é sobre todo mundo. */
async function statusPorContagem() {
  const { rows } = await c.query(`select status, count(*)::int n from public.conversas group by status order by status`);
  return rows.map((r) => `${r.status}=${r.n}`).join(',');
}

const syncStatus = async (tenant, conv) => (await c.query(
  `select status from public.api_n8n_conversa_sync($1::uuid, $2::bigint, null, null)`, [tenant, conv])).rows[0]?.status;

const transcreverPausada = async (tenant, conv) => (await c.query(
  `select conversa_pausada from public.api_n8n_pode_transcrever($1::uuid, $2::bigint)`, [tenant, conv])).rows;

const motivoDe = async (tenant, conv) => (await c.query(
  `select motivo_pausa from public.conversas where tenant_id = $1 and conversation_id = $2`,
  [tenant, conv])).rows[0]?.motivo_pausa;

/**
 * Insere conversa já no estado que a asserção vai medir.
 *
 * O motivo entra no MESMO `insert`, e não num `update` depois: a constraint
 * `conversas_pausa_tem_motivo` recusa a linha intermediária. A primeira versão
 * deste helper fazia em dois statements e o teste morreu na própria constraint
 * que ele existe para provar — o que é o sintoma certo, no lugar errado.
 *
 * Sem motivo, a coluna nem é citada: em `-- 1 --` o arranjo roda ANTES da
 * migração, quando `motivo_pausa` ainda não existe.
 */
async function arranjarConversa(tenant, conv, { status = 'ativo', minutosAtras = null, motivo = null } = {}) {
  const quando = `case when $4::int is null then null else now() - make_interval(mins => $4::int) end`;
  if (motivo === null) {
    await c.query(
      `insert into public.conversas (tenant_id, conversation_id, status, pausado_em)
       values ($1, $2, $3, ${quando})`, [tenant, conv, status, minutosAtras]);
  } else {
    await c.query(
      `insert into public.conversas (tenant_id, conversation_id, status, pausado_em, motivo_pausa)
       values ($1, $2, $3, ${quando}, $5)`, [tenant, conv, status, minutosAtras, motivo]);
  }
}

await c.connect();

/*
 * Retrato do mundo ANTES de qualquer transação. A propriedade garantida no fim
 * não é "a coluna não existe" — é "o banco terminou como começou".
 */
const colunaAntesDeTudo = (await c.query(
  `select 1 from information_schema.columns
    where table_name='conversas' and column_name='motivo_pausa'`)).rowCount === 1;

await c.query('begin');

try {
  console.log('\n== Migração 47: retomada da pausa ==\n');

  /*
   * NENHUMA claim de JWT é setada aqui. É deliberado: a migração tem de aplicar
   * na mesma condição do apply real. Ver `comoSuper` acima — a claim entra só
   * nos poucos comandos de ARRANJO que mexem em `tenants`.
   */

  // -------------------------------------------------------------------------
  console.log('-- 1. Arranja o estado de ANTES, em vez de torcer por ele --\n');

  /*
   * O TESTE ARRANJA O ESTADO QUE VAI MEDIR. Afirmar "a coluna ainda não existe"
   * seria estado do mundo, e ficaria falso no dia em que a 47 for aplicada — foi
   * a oitava armadilha dessa família no repo, e a segunda escrita por quem tinha
   * acabado de anotar a regra.
   *
   * A forma que não envelhece: rodar o ROLLBACK primeiro, aqui dentro da
   * transação abortada. Ele é idempotente (`drop ... if exists`), então põe o
   * banco no estado pré-47 tendo a 47 sido aplicada ou não — e o teste mede a
   * MIGRAÇÃO, não o calendário.
   */
  await c.query(R47);
  const jaAplicada = (await c.query(
    `select 1 from supabase_migrations.schema_migrations where version like '2026082114%'`)).rowCount === 1;
  console.log(`  (47 no ledger: ${jaAplicada ? 'sim — desfeita aqui dentro' : 'ainda não'})`);

  const semColuna = await tentar(`select motivo_pausa from public.conversas limit 1`);
  sus('o rollback deixou o banco no estado pré-47 (motivo_pausa ausente)',
    semColuna.erro !== null && /motivo_pausa/.test(semColuna.erro),
    semColuna.erro ?? 'a coluna ainda responde');

  // Três tenants, não um: um esconde todo bug de isolamento, dois escondem
  // vazamento unidirecional. Criados ANTES da migração de propósito — é assim
  // que se mede "tenant que já existia recebe a janela padrão".
  const sufixo = Math.random().toString(16).slice(2, 10);
  const tenants = [];
  for (let i = 0; i < 3; i++) {
    const { rows } = await c.query(
      `insert into public.tenants (slug, nome, ativo) values ($1, $2, true) returning id`,
      [`zz-efem-pausa47-${sufixo}-${i}`, `efêmero pausa 47 ${sufixo} #${i}`]);
    tenants.push(rows[0].id);
  }
  const [A, B, C] = tenants;
  const CONV_COMPART = 9_470_000 + Math.floor(Math.random() * 1000); // MESMO id em A e B

  // Estado pré-migração que o backfill vai encontrar. Confirma que entrou antes
  // de acreditar em qualquer asserção sobre ele.
  await arranjarConversa(A, 4701, { status: 'pausado', minutosAtras: 90 });
  await arranjarConversa(A, 4702, { status: 'ativo' });
  const semeadas = (await c.query(
    `select count(*)::int n from public.conversas where tenant_id = $1`, [A])).rows[0].n;
  sus('as conversas de arranjo entraram (anti-vacuidade)', semeadas === 2, `${semeadas} linha(s)`);

  const aclAntes = await aclDeTodas();
  const assinaturasAntes = {};
  for (const f of FUNCOES) assinaturasAntes[f] = await assinaturasDe(f);
  const statusAntes = await statusPorContagem();
  console.log(`  status antes: ${statusAntes}`);
  for (const f of FUNCOES) console.log(`  ACL antes ${f}: ${aclAntes[f].join(', ')}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 2. Aplica a migração --\n');

  /*
   * SEM CLAIM. Se a 47 voltar a usar `update public.tenants` para popular a
   * janela, `trg_tenants_guard_colunas` derruba aqui — que é onde tem de
   * derrubar, e não no dia do apply.
   */
  const aplicou = await tentar(M47);
  chk('a migração aplica SEM claim de JWT nenhuma (a condição do apply real)',
    aplicou.erro === null, aplicou.erro ?? '');

  /*
   * CONTRAPROVA. Sem ela a asserção acima seria verdadeira por vacuidade se o
   * trigger estivesse desligado: o teste diria "aplica sem claim" porque nada
   * barra nada. Aqui o guard TEM de barrar um `update` que mexa na janela.
   */
  const guardVivo = await tentar(
    `update public.tenants set pausa_expira_minutos = 31 where id = $1`, [A]);
  sus('contraprova: `trg_tenants_guard_colunas` está VIVO e barra a janela sem claim',
    guardVivo.erro !== null && guardVivo.codigo === '42501', guardVivo.erro ?? '(passou — trigger inerte?)');

  const aclDepois = await aclDeTodas();
  chk('o ACL das três é IDÊNTICO ao de antes (não houve drop, nada para reconceder)',
    JSON.stringify(aclAntes) === JSON.stringify(aclDepois),
    `antes: ${JSON.stringify(aclAntes)} | depois: ${JSON.stringify(aclDepois)}`);
  for (const f of FUNCOES) {
    chk(`\`n8n_agent\` continua no ACL de ${f}`, aclDepois[f].includes('n8n_agent'), aclDepois[f].join(','));
    chk(`\`anon\`/\`authenticated\` continuam FORA de ${f}`,
      !aclDepois[f].includes('anon') && !aclDepois[f].includes('authenticated'), aclDepois[f].join(','));
    const ass = await assinaturasDe(f);
    chk(`${f} tem EXATAMENTE UMA assinatura viva`, ass.length === 1,
      ass.map((a) => `${a.n}: ${a.tipos}`).join(' | '));
    chk(`e é a mesma de antes`, ass[0]?.tipos === assinaturasAntes[f][0]?.tipos,
      `${ass[0]?.tipos} vs ${assinaturasAntes[f][0]?.tipos}`);
  }

  const vol = (await c.query(
    `select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname='api_n8n_pode_transcrever'`)).rows[0].provolatile;
  chk('`api_n8n_pode_transcrever` continua STABLE (o predicado não a tornou VOLATILE)', vol === 's', `provolatile=${vol}`);

  const volPred = (await c.query(
    `select p.proname, p.provolatile, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname in ('pausa_vigente','conversa_status_efetivo') order by 1`)).rows;
  chk('os dois predicados são STABLE e NÃO são SECURITY DEFINER',
    volPred.length === 2 && volPred.every((r) => r.provolatile === 's' && r.prosecdef === false),
    JSON.stringify(volPred));

  // Propriedade, não estado do mundo.
  const statusDepois = await statusPorContagem();
  chk('aplicar a migração não muda o status de ninguém', statusAntes === statusDepois,
    `antes: ${statusAntes} | depois: ${statusDepois}`);

  const semMotivo = (await c.query(
    `select count(*)::int n from public.conversas where status = 'pausado' and motivo_pausa is null`)).rows[0].n;
  chk('nenhuma conversa pausada ficou sem motivo depois do backfill', semMotivo === 0, `${semMotivo} linha(s)`);

  const janelaA = (await c.query(`select pausa_expira_minutos j from public.tenants where id = $1`, [A])).rows[0].j;
  chk('tenant que já existia recebeu a janela padrão de 30', janelaA === 30, `janela=${janelaA}`);

  chk('a pausada de arranjo virou `mensagem_humana` (blanket)',
    (await motivoDe(A, 4701)) === 'mensagem_humana', String(await motivoDe(A, 4701)));
  chk('e a conversa ATIVA continua sem motivo', (await motivoDe(A, 4702)) === null, String(await motivoDe(A, 4702)));

  // A linha da lista de exceção é dado de produção: se alguém a despausar pelo
  // painel — operação legítima — isto vira AVISO, não vermelho. Treinar todo
  // mundo a ignorar vermelho é pior que não medir.
  const karen = (await c.query(
    `select cv.status, cv.motivo_pausa from public.conversas cv join public.tenants t on t.id = cv.tenant_id
      where t.slug = 'emporio' and cv.conversation_id = 6`)).rows[0];
  if (!karen) aviso('a linha da lista de exceção (emporio/6) não existe mais — a lista ficou inerte');
  else if (karen.status !== 'pausado') aviso(`emporio/6 já não está pausada (status=${karen.status}) — lista inerte, o que é correto`);
  else chk('a lista de exceção marcou emporio/6 como `manual`', karen.motivo_pausa === 'manual', String(karen.motivo_pausa));

  // -------------------------------------------------------------------------
  console.log('\n-- 3. A tabela verdade do predicado, com estado arranjado --\n');

  const pv = async (status, minutosAtras, motivo, janela) => (await c.query(
    `select public.pausa_vigente($1::text,
       case when $2::int is null then null else now() - make_interval(mins => $2::int) end,
       $3::text, $4::int) v`,
    [status, minutosAtras, motivo, janela])).rows[0].v;

  chk('manual velha (5 dias) NÃO caduca', (await pv('pausado', 7200, 'manual', 30)) === true);
  chk('mensagem_humana dentro da janela vale', (await pv('pausado', 10, 'mensagem_humana', 30)) === true);
  chk('mensagem_humana fora da janela CADUCA', (await pv('pausado', 90, 'mensagem_humana', 30)) === false);
  chk('status ativo nunca está pausado', (await pv('ativo', 10, 'mensagem_humana', 30)) === false);
  chk('status nulo nunca está pausado', (await pv(null, 10, 'mensagem_humana', 30)) === false);
  chk('motivo NULO cai para o lado alto (caduca)', (await pv('pausado', 90, null, 30)) === false);
  chk('pausado_em nulo cai para o lado alto', (await pv('pausado', null, 'mensagem_humana', 30)) === false);
  chk('janela nula cai para o lado alto', (await pv('pausado', 10, 'mensagem_humana', null)) === false);
  chk('nenhum caminho devolve NULL',
    (await c.query(`select bool_and(v is not null) t from (
        select public.pausa_vigente(s, case when m is null then null else now() - make_interval(mins => m) end, mo, j) v
        from (values ('pausado',10,'manual',30),('pausado',90,'mensagem_humana',30),('ativo',null,null,30),
                     (null,null,null,null),('pausado',null,null,null),('pausado',5,null,1)) x(s,m,mo,j)) y`)).rows[0].t === true);

  // -------------------------------------------------------------------------
  console.log('\n-- 4. `conversa_sync` devolve o status EFETIVO --\n');

  await arranjarConversa(A, 4711, { status: 'pausado', minutosAtras: 90, motivo: 'mensagem_humana' });
  await arranjarConversa(A, 4712, { status: 'pausado', minutosAtras: 10, motivo: 'mensagem_humana' });
  await arranjarConversa(A, 4713, { status: 'pausado', minutosAtras: 7200, motivo: 'manual' });

  chk('pausa humana VENCIDA → o sync devolve `ativo`', (await syncStatus(A, 4711)) === 'ativo', await syncStatus(A, 4711));
  chk('pausa humana DENTRO da janela → devolve `pausado`', (await syncStatus(A, 4712)) === 'pausado', await syncStatus(A, 4712));
  chk('pausa MANUAL de 5 dias → devolve `pausado`', (await syncStatus(A, 4713)) === 'pausado', await syncStatus(A, 4713));

  const lapide = (await c.query(
    `select status, motivo_pausa from public.conversas where tenant_id = $1 and conversation_id = 4711`, [A])).rows[0];
  chk('a lápide fica: o sync NÃO reescreve a linha vencida',
    lapide.status === 'pausado' && lapide.motivo_pausa === 'mensagem_humana', JSON.stringify(lapide));

  // -------------------------------------------------------------------------
  console.log('\n-- 5. `pode_transcrever` NÃO diverge do `conversa_sync` --\n');

  for (const [conv, esperado] of [[4711, false], [4712, true], [4713, true]]) {
    const linhas = await transcreverPausada(A, conv);
    chk(`conversa ${conv}: pode_transcrever concorda com o sync (pausada=${esperado})`,
      linhas.length === 1 && linhas[0].conversa_pausada === esperado,
      `${linhas.length} linha(s), pausada=${linhas[0]?.conversa_pausada}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n-- 6. A janela é DO TENANT, e `conversation_id` colide entre tenants --\n');

  // Com claim: mexer na janela é operação de agência (a coluna está fora da
  // lista branca de `tenants_guard_colunas` — ver a seção 1 da migração).
  await comoSuper(c, `update public.tenants set pausa_expira_minutos = 1 where id = $1`, [B]);
  sus('a janela de B foi mesmo para 1 (a mutação de arranjo entrou)',
    (await c.query(`select pausa_expira_minutos j from public.tenants where id = $1`, [B])).rows[0].j === 1);
  await arranjarConversa(A, CONV_COMPART, { status: 'ativo' });
  await arranjarConversa(B, CONV_COMPART, { status: 'pausado', minutosAtras: 10, motivo: 'mensagem_humana' });

  sus('mesmo `conversation_id` existe nos dois tenants (a colisão foi mesmo arranjada)',
    (await c.query(`select count(*)::int n from public.conversas where conversation_id = $1`, [CONV_COMPART])).rows[0].n === 2);
  chk('tenant B (janela 1 min, pausada há 10) → `ativo`', (await syncStatus(B, CONV_COMPART)) === 'ativo',
    await syncStatus(B, CONV_COMPART));

  await arranjarConversa(C, 4721, { status: 'pausado', minutosAtras: 10, motivo: 'mensagem_humana' });
  chk('tenant C (janela 30 padrão, pausada há 10) → `pausado`', (await syncStatus(C, 4721)) === 'pausado',
    await syncStatus(C, 4721));

  const doA = await transcreverPausada(A, CONV_COMPART);
  chk('A não enxerga a conversa de B com o mesmo id (1 linha, não pausada)',
    doA.length === 1 && doA[0].conversa_pausada === false,
    `${doA.length} linha(s), pausada=${doA[0]?.conversa_pausada}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 7. As constraints, e a chamada do n8n como `n8n_agent` --\n');

  const semMotivoInsert = await tentar(
    `insert into public.conversas (tenant_id, conversation_id, status, pausado_em)
     values ($1, 4731, 'pausado', now())`, [A]);
  chk('inserir pausada SEM motivo é recusado', semMotivoInsert.erro !== null && /conversas_pausa_tem_motivo/.test(semMotivoInsert.erro ?? ''),
    semMotivoInsert.erro ?? '(passou)');

  const motivoInvalido = await tentar(
    `insert into public.conversas (tenant_id, conversation_id, status, pausado_em, motivo_pausa)
     values ($1, 4732, 'pausado', now(), 'sei-la')`, [A]);
  chk('motivo fora do check é recusado', motivoInvalido.erro !== null && /conversas_motivo_pausa_check/.test(motivoInvalido.erro ?? ''),
    motivoInvalido.erro ?? '(passou)');

  /*
   * COM claim, de propósito. Sem ela quem recusaria seria o TRIGGER (42501), e
   * a asserção passaria pelo motivo errado — provaria o guard, não o check. Com
   * a claim, o guard libera e sobra exatamente a constraint que se quer medir.
   */
  await c.query(`set local request.jwt.claims = ${CLAIM_SUPER}`);
  const janelaZero = await tentar(`update public.tenants set pausa_expira_minutos = 0 where id = $1`, [C]);
  await c.query(`reset request.jwt.claims`);
  chk('janela <= 0 é recusada pelo CHECK (não pelo guard de colunas)',
    janelaZero.codigo === '23514' && /tenants_pausa_expira_positiva/.test(janelaZero.erro ?? ''),
    `${janelaZero.codigo}: ${janelaZero.erro ?? '(passou)'}`);

  const pausar = await comoRole('n8n_agent',
    `select public.api_n8n_definir_status_conversa($1::uuid, $2::bigint, 'pausado') v`, [A, 4702]);
  chk('`n8n_agent` CHAMA definir_status_conversa depois da migração', pausar.erro === null, pausar.erro ?? '');
  chk('e a pausa do n8n nasce como `mensagem_humana`', (await motivoDe(A, 4702)) === 'mensagem_humana',
    String(await motivoDe(A, 4702)));

  const despausar = await comoRole('n8n_agent',
    `select public.api_n8n_definir_status_conversa($1::uuid, $2::bigint, 'ativo') v`, [A, 4702]);
  chk('despausar limpa o motivo', despausar.erro === null && (await motivoDe(A, 4702)) === null,
    despausar.erro ?? String(await motivoDe(A, 4702)));

  const syncN8n = await comoRole('n8n_agent',
    `select status from public.api_n8n_conversa_sync($1::uuid, $2::bigint, null, null)`, [A, 4711]);
  chk('`n8n_agent` CHAMA conversa_sync e recebe o status efetivo',
    syncN8n.erro === null && syncN8n.rows[0]?.status === 'ativo', syncN8n.erro ?? JSON.stringify(syncN8n.rows));

  const transcN8n = await comoRole('n8n_agent',
    `select conversa_pausada from public.api_n8n_pode_transcrever($1::uuid, $2::bigint)`, [A, 4711]);
  chk('`n8n_agent` CHAMA pode_transcrever', transcN8n.erro === null && transcN8n.rows[0]?.conversa_pausada === false,
    transcN8n.erro ?? JSON.stringify(transcN8n.rows));

  // -------------------------------------------------------------------------
  console.log('\n-- 8. Reexecutável, e o backfill não reclassifica --\n');

  await c.query(`update public.conversas set motivo_pausa = 'manual' where tenant_id = $1 and conversation_id = 4711`, [A]);
  const r2 = await tentar(M47);
  chk('aplicar a migração duas vezes não quebra', r2.erro === null, r2.erro ?? '');
  chk('e a segunda passagem NÃO reclassifica quem já tem motivo',
    (await motivoDe(A, 4711)) === 'manual', String(await motivoDe(A, 4711)));
  chk('o ACL continua o mesmo depois da segunda', JSON.stringify(await aclDeTodas()) === JSON.stringify(aclAntes));
  await c.query(`update public.conversas set motivo_pausa = 'mensagem_humana' where tenant_id = $1 and conversation_id = 4711`, [A]);

  // -------------------------------------------------------------------------
  console.log('\n-- 9. Rollback --\n');

  await c.query(R47);
  const colDepois = (await c.query(
    `select 1 from information_schema.columns where table_name='conversas' and column_name='motivo_pausa'`)).rowCount;
  const janDepois = (await c.query(
    `select 1 from information_schema.columns where table_name='tenants' and column_name='pausa_expira_minutos'`)).rowCount;
  const predDepois = (await c.query(
    `select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('pausa_vigente','conversa_status_efetivo')`)).rowCount;
  chk('o rollback derruba as duas colunas e os dois predicados',
    colDepois === 0 && janDepois === 0 && predDepois === 0, `col=${colDepois} jan=${janDepois} pred=${predDepois}`);
  chk('o ACL continua intacto depois do rollback',
    JSON.stringify(await aclDeTodas()) === JSON.stringify(aclAntes));

  const posRb = await comoRole('n8n_agent',
    `select status from public.api_n8n_conversa_sync($1::uuid, $2::bigint, null, null)`, [A, 4711]);
  chk('e o n8n continua sincronizando conversa depois do rollback',
    posRb.erro === null && posRb.rows[0]?.status === 'pausado', posRb.erro ?? JSON.stringify(posRb.rows));

  await c.query(M47); // volta para "aplicada", para as sabotagens rodarem em cima

  // -------------------------------------------------------------------------
  console.log('\n-- 10. Sabotagem --\n');

  /** Aplica uma variante sabotada e devolve se a mutação realmente entrou. */
  const sabotar = (de, para) => {
    const s = M47.replace(de, para);
    return { sql: s, entrou: s !== M47 && !s.includes(de) };
  };

  {
    // Sem a linha do `manual`, pausa manual velha passa a caducar.
    const { sql, entrou } = sabotar(
      "    when p_motivo_pausa = 'manual'           then true\n", '');
    sus('S1 mutação entrou (a linha do `manual` saiu)', entrou);
    const r = await tentar(sql);
    sus('S1 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    chk('S1 sem ela, pausa MANUAL de 5 dias caduca (o teste reprova)',
      (await pv('pausado', 7200, 'manual', 30)) === false, String(await pv('pausado', 7200, 'manual', 30)));
    await c.query(M47);
  }
  {
    // O sync volta a devolver o status cru.
    const { sql, entrou } = sabotar(
      '  returning public.conversa_status_efetivo(c.status, c.pausado_em, c.motivo_pausa, v_janela),',
      '  returning c.status,');
    sus('S2 mutação entrou (o invólucro saiu do RETURNING)', entrou);
    const r = await tentar(sql);
    sus('S2 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    chk('S2 sem ele, o sync mente sobre a pausa vencida (o teste reprova)',
      (await syncStatus(A, 4711)) === 'pausado', await syncStatus(A, 4711));
    await c.query(M47);
  }
  {
    // `pode_transcrever` volta a comparar cru — e diverge do sync.
    const { sql, entrou } = sabotar(
      '    public.pausa_vigente(cv.status, cv.pausado_em, cv.motivo_pausa, t.pausa_expira_minutos),',
      "    coalesce(cv.status, 'ativo') = 'pausado',");
    sus('S3 mutação entrou (o predicado saiu do pode_transcrever)', entrou);
    const r = await tentar(sql);
    sus('S3 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    const div = await transcreverPausada(A, 4711);
    chk('S3 sem ele, pode_transcrever DIVERGE do sync (o teste reprova)',
      div[0]?.conversa_pausada === true && (await syncStatus(A, 4711)) === 'ativo',
      `transcrever=${div[0]?.conversa_pausada} sync=${await syncStatus(A, 4711)}`);
    await c.query(M47);
  }
  {
    // O caminho do n8n para de escrever o motivo — e a constraint o derruba.
    const { sql, entrou } = sabotar(
      "         motivo_pausa  = case when p_status = 'pausado' then 'mensagem_humana' else null end,\n", '');
    sus('S4 mutação entrou (o motivo saiu do definir_status_conversa)', entrou);
    const r = await tentar(sql);
    sus('S4 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    const p = await comoRole('n8n_agent',
      `select public.api_n8n_definir_status_conversa($1::uuid, $2::bigint, 'pausado') v`, [A, 4702]);
    chk('S4 sem ele, a pausa do n8n é RECUSADA pela constraint (o teste reprova)',
      p.erro !== null && /conversas_pausa_tem_motivo/.test(p.erro ?? ''), p.erro ?? '(passou)');
    await c.query(M47);
  }
  {
    // Unidade errada na janela: minutos viram horas.
    const { sql, entrou } = sabotar(
      'else p_pausado_em > now() - make_interval(mins => p_janela_minutos)',
      'else p_pausado_em > now() - make_interval(hours => p_janela_minutos)');
    sus('S5 mutação entrou (`mins` virou `hours`)', entrou);
    const r = await tentar(sql);
    sus('S5 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    chk('S5 com a unidade errada, a janela de 1 min não vence em 10 (o teste reprova)',
      (await syncStatus(B, CONV_COMPART)) === 'pausado', await syncStatus(B, CONV_COMPART));
    await c.query(M47);
  }
  {
    // Vazamento clássico: o join de conversas sem `tenant_id`.
    const { sql, entrou } = sabotar(
      '         on cv.tenant_id = t.id and cv.conversation_id = p_conversation_id\n  where t.id = p_tenant_id;',
      '         on cv.conversation_id = p_conversation_id\n  where t.id = p_tenant_id;');
    sus('S6 mutação entrou (o `tenant_id` saiu do join de conversas)', entrou);
    const r = await tentar(sql);
    sus('S6 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    const vaz = await transcreverPausada(A, CONV_COMPART);
    chk('S6 sem ele, A enxerga a conversa de B com o mesmo id (o teste reprova)',
      vaz.length !== 1 || vaz.some((l) => l.conversa_pausada === true),
      `${vaz.length} linha(s): ${JSON.stringify(vaz.map((l) => l.conversa_pausada))}`);
    await c.query(M47);
  }
  {
    // A constraint sai da migração. Precisa do rollback antes, senão ela já
    // existe e o `if not exists` esconderia a sabotagem.
    const { sql, entrou } = sabotar(
      `  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.conversas'::regclass
       and conname  = 'conversas_pausa_tem_motivo'
  ) then
    alter table public.conversas
      add constraint conversas_pausa_tem_motivo
      check (status <> 'pausado' or motivo_pausa is not null);
  end if;`, '');
    sus('S7 mutação entrou (a constraint saiu da migração)', entrou);
    await c.query(R47);
    const r = await tentar(sql);
    sus('S7 a versão sabotada aplica', r.erro === null, r.erro ?? '');
    const existe = (await c.query(
      `select 1 from pg_constraint where conrelid='public.conversas'::regclass
        and conname='conversas_pausa_tem_motivo'`)).rowCount;
    sus('S7 a constraint realmente não existe na versão sabotada', existe === 0);
    const passou = await tentar(
      `insert into public.conversas (tenant_id, conversation_id, status, pausado_em)
       values ($1, 4741, 'pausado', now())`, [A]);
    chk('S7 sem ela, pausa sem motivo ENTRA (o teste reprova)', passou.erro === null, passou.erro ?? '');
    await c.query(R47);
    await c.query(M47);
  }
  {
    /*
     * S8 guarda o conserto de 2026-08-21. A forma ÓBVIA de popular a janela
     * (`add column` nullable + `update ... where null`) derruba a migração
     * inteira: `trg_tenants_guard_colunas` levanta 42501 para coluna fora da
     * lista branca sem claim de super_admin — e apply real não tem claim.
     *
     * Sem esta sabotagem, alguém "simplifica" o `not null default` de volta e
     * descobre no dia do apply, com a transação abortando em produção.
     */
    const { sql, entrou } = sabotar(
      'alter table public.tenants\n  add column if not exists pausa_expira_minutos integer not null default 30;',
      'alter table public.tenants\n  add column if not exists pausa_expira_minutos integer;\n' +
      'update public.tenants set pausa_expira_minutos = 30 where pausa_expira_minutos is null;\n' +
      'alter table public.tenants alter column pausa_expira_minutos set default 30;\n' +
      'alter table public.tenants alter column pausa_expira_minutos set not null;');
    sus('S8 mutação entrou (voltou o `update public.tenants`)',
      entrou && sql.includes('update public.tenants set pausa_expira_minutos = 30'));
    await c.query(R47);
    const r = await tentar(sql);
    chk('S8 com o `update`, o guard DERRUBA a migração sem claim (o teste reprova)',
      r.erro !== null && r.codigo === '42501', `${r.codigo ?? '(aplicou)'}: ${r.erro ?? ''}`);
    await c.query(M47);
  }
} catch (e) {
  falhas.push(`exceção não prevista: ${e.message}`);
  console.log(`  FALHA exceção não prevista — ${e.message}`);
} finally {
  await c.query('rollback');
  const colunaDepoisDeTudo = (await c.query(
    `select 1 from information_schema.columns
      where table_name='conversas' and column_name='motivo_pausa'`)).rowCount === 1;
  console.log(`\n  (transação revertida; motivo_pausa em produção: ${colunaDepoisDeTudo ? 'existe' : 'não existe'}` +
    ` — igual a antes do teste: ${colunaAntesDeTudo === colunaDepoisDeTudo ? 'sim' : 'NÃO'})`);
  if (colunaAntesDeTudo !== colunaDepoisDeTudo) {
    falhas.push(`o teste mudou o schema de produção (coluna antes: ${colunaAntesDeTudo}, depois: ${colunaDepoisDeTudo})`);
  }
  const sobra = (await c.query(`select count(*)::int n from public.tenants where slug like 'zz-efem-pausa47-%'`)).rows[0].n;
  console.log(`  (tenants efêmeros sobrando: ${sobra})`);
  if (sobra > 0) falhas.push(`${sobra} tenant(s) efêmero(s) sobraram — a transação devia ter revertido a criação`);
  await c.end();
}

console.log('\n----------------------------------------------------------');
console.log(`  ${ok + okSus} passaram, ${falhas.length} falharam, ${avisos.length} aviso(s)`);
console.log(`    ${ok} por motivo próprio (propriedade da migração)`);
console.log(`    ${okSus} de sustentação (~) — provam que o TESTE faz o que diz,`);
console.log('       não que o sistema funciona: mutação entrou, arranjo pegou,');
console.log('       precondição é a declarada, versão sabotada chegou a aplicar.');
falhas.forEach((f) => console.log(`  ! ${f}`));
avisos.forEach((a) => console.log(`  ~ ${a}`));
console.log();
process.exit(falhas.length === 0 ? 0 : 1);
