#!/usr/bin/env node
/**
 * Migração 53 (proteção anti-loop) numa TRANSAÇÃO ABORTADA contra produção.
 * Nada é gravado: o rollback no fim é incondicional.
 *
 * O TESTE QUE VALE AQUI NÃO É "A MIGRAÇÃO APLICA". É rodar a regra contra o
 * HISTÓRICO REAL e exigir dois números:
 *
 *     1. dispara na conversa 20 do `emporio` (o laço de 5.624 mensagens);
 *     2. ZERO falsos positivos nas outras 24 conversas reais do banco.
 *
 * E roda a regra chamando `api_n8n_portao_mensagem` DE VERDADE, não uma cópia
 * dela em JavaScript. Reimplementar a regra aqui seria comparar a implementação
 * contra ela mesma — a asserção tautológica que este repo já pegou uma vez.
 *
 * COMO O HISTÓRICO É ARRANJADO, e por que precisa ser. A regra exige que as N
 * entradas caibam numa janela de 10 minutos, medida contra `now()`. Todo o
 * histórico do banco é mais velho que isso, então sem arranjo NADA dispararia e
 * o teste passaria por vacuidade. Cada conversa é DESLOCADA no tempo, com os
 * intervalos preservados, até o seu momento mais parecido com laço — ver
 * `alinharMaiorRepeticao`, que também guarda as duas versões erradas deste
 * arranjo, porque as duas produziram falso vermelho antes de o número fechar.
 *
 * AS TRÊS SABOTAGENS (seção 7):
 *   S1  alarga a janela de 10 minutos  -> conversa parada há dias vira pausa
 *   S2  troca 5 repetições por 2       -> falsos positivos aparecem
 *   S3  tira `anomalia` do `pausa_vigente` -> a pausa CADUCA em 30 min, que é
 *       o modo de falha que motivou a migração inteira e o mais fácil de
 *       reintroduzir sem perceber
 *
 * Uso: npm run teste:anti-loop
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
const M53 = acharMigracao('_53_anti_loop.sql').replace(/\r\n/g, '\n');
const R53 = acharMigracao('_53_anti_loop_rollback.sql');

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

/** Chama COMO `n8n_agent` — `postgres` ignora grant e diria verde sem medir. */
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

/**
 * `tenants` tem `trg_tenants_guard_colunas`: qualquer coluna fora da whitelist
 * exige claim de super_admin. Os tetos SÃO colunas de agência, então mexer neles
 * pede a claim — e este teste tropeçou nisso na primeira execução, o que é a
 * melhor prova de que a armadilha documentada na migração é real.
 */
const CLAIM_SUPER = `'{"app_metadata":{"papel":"super_admin"}}'`;
async function comoSuper(sql, p = []) {
  await c.query(`set local request.jwt.claims = ${CLAIM_SUPER}`);
  try { return await c.query(sql, p); } finally { await c.query('reset request.jwt.claims'); }
}

const portao = (t, conv) => comoN8n(
  `select * from public.api_n8n_portao_mensagem($1::uuid, $2::bigint)`, [t, conv]);

const existeFn = async (nome) => (await c.query(
  `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = $1`, [nome])).rows[0].n;

/**
 * ARRANJO. Alinha cada conversa na sua MAIOR SEQUÊNCIA de entradas consecutivas
 * de texto igual: essa sequência vira "acabou de acontecer", e o que veio depois
 * dela é descartado para que o `order by criado_em desc limit N` da regra a
 * alcance.
 *
 * DUAS VERSÕES ANTERIORES DESTE ARRANJO DERAM FALSO VERMELHO, e as duas valem
 * escritas porque são o mesmo erro em graus diferentes:
 *
 *   1. "traz o FIM da conversa para agora". A conv 20 tem a última entrada às
 *      12:12 e a penúltima às 05:30 — o laço parou e quase três horas depois veio
 *      uma mensagem solta. As últimas 5 não cabem em 10 minutos, então a regra
 *      não dispara no fim da série. O teste concluía "não pega o laço" medindo o
 *      pedaço errado do histórico;
 *   2. "traz a janela de 5 mais RÁPIDA para agora". Melhor, e ainda errado: as 5
 *      mais próximas no tempo podem cair justamente onde o outro robô troca de
 *      variante de saudação, e aí não são idênticas. Rapidez não é o sinal.
 *
 * A pergunta certa não é "o fim da conversa é um laço?", e sim **"em algum
 * momento esta conversa foi um laço?"** — e isso vale nos dois sentidos: dá ao
 * laço a chance de ser pego E dá a cada conversa legítima a sua melhor chance de
 * produzir um falso positivo, que é o arranjo mais adversário possível para a
 * afirmação "zero falsos positivos".
 *
 * E o arranjo NÃO conhece o limiar da regra — nem o 5, nem os 10 minutos. Por
 * isso a sabotagem S2 pode trocar 5 por 2 sem que o arranjo mude: a única coisa
 * diferente entre as duas medições é a função.
 */
async function alinharMaiorRepeticao() {
  // Ilhas: agrupa entradas CONSECUTIVAS de texto normalizado igual (a diferença
  // entre duas numerações é constante dentro de uma sequência) e escolhe a maior
  // de cada conversa. Repare que isto NÃO conhece o limiar da regra — nem o 5,
  // nem os 10 minutos. O arranjo escolhe QUANDO avaliar; quem decide é a função.
  const r = await c.query(`
    with e as (
      select tenant_id, conversation_id, criado_em,
             public.texto_normalizado(conteudo) txt,
             row_number() over (partition by tenant_id, conversation_id
                                order by criado_em) rn,
             row_number() over (partition by tenant_id, conversation_id,
                                             public.texto_normalizado(conteudo)
                                order by criado_em) rn_txt
        from public.mensagens_log
       where direcao = 'entrada'
    ),
    ilhas as (
      select tenant_id, conversation_id, count(*) tam, max(criado_em) fim
        from e group by tenant_id, conversation_id, txt, (rn - rn_txt)
    ),
    melhor as (
      select distinct on (tenant_id, conversation_id) tenant_id, conversation_id, fim
        from ilhas
       order by tenant_id, conversation_id, tam desc, fim desc
    )
    update public.mensagens_log l
       set criado_em = l.criado_em + (now() - m.fim)
      from melhor m
     where l.tenant_id = m.tenant_id and l.conversation_id = m.conversation_id`);
  // O que ficou "no futuro" veio depois da sequência escolhida. Sai, senão seria
  // ele que o `limit N` da regra alcançaria.
  await c.query(`delete from public.mensagens_log where criado_em > now()`);
  return r.rowCount;
}

/**
 * Roda o portão em todas as conversas reais sob um alinhamento, e desfaz tudo.
 * O savepoint é o que permite medir N=5 e N=2 partindo do MESMO histórico
 * intocado — sem ele o segundo alinhamento trabalharia sobre os restos do
 * primeiro, e o número não valeria nada.
 */
async function dispararamSob(alvos) {
  await c.query('savepoint alinha');
  const dis = [];
  try {
    await alinharMaiorRepeticao();
    await c.query(`update public.conversas set status = 'ativo', motivo_pausa = null, pausado_em = null`);
    for (const a of alvos) {
      const r = await portao(a.tenant_id, a.conv);
      if (r.rows.length !== 1) { falhas.push(`portão devolveu ${r.rows.length} linhas em ${a.slug}#${a.conv}`); continue; }
      if (r.rows[0].anomalia) dis.push(`${a.slug}#${a.conv}`);
      await c.query(`update public.conversas set status = 'ativo', motivo_pausa = null, pausado_em = null
                      where tenant_id = $1 and conversation_id = $2`, [a.tenant_id, a.conv]);
    }
  } finally {
    await c.query('rollback to savepoint alinha');
  }
  return dis;
}

/** Semeia tenant com conversa e um histórico de entradas dado em minutos atrás. */
async function semear(rotulo, conv, entradas, cfg = {}) {
  const t = (await c.query(
    `insert into public.tenants (slug, nome, ativo) values ($1, $2, true) returning id`,
    [`zz-efem-loop53-${rotulo}`, `efêmero loop 53 ${rotulo}`])).rows[0].id;
  await c.query(
    `insert into public.tenant_tools (tenant_id, tool_nome, ativo, contratado, config)
     values ($1, 'transferir_humano', true, true, $2::jsonb)`, [t, JSON.stringify(cfg)]);
  await c.query(
    `insert into public.conversas (tenant_id, conversation_id, contact_name, phone, status)
     values ($1, $2, $3, $4, 'ativo')`, [t, conv, `Cliente ${rotulo}`, `55699${String(conv).slice(-8)}`]);
  for (const [texto, minAtras] of entradas) {
    await c.query(
      `insert into public.mensagens_log (tenant_id, conversation_id, direcao, conteudo, criado_em,
                                         tokens_entrada, tokens_saida, modelo)
       values ($1, $2, 'entrada', $3, now() - make_interval(mins => $4::int), 0, 0, 'gpt-4.1-mini')`,
      [t, conv, texto, minAtras]);
  }
  return { t, conv };
}

const estadoConversa = async (t, conv) => (await c.query(
  `select cv.status, cv.motivo_pausa, cv.pausado_em,
          public.pausa_vigente(cv.status, cv.pausado_em, cv.motivo_pausa, tn.pausa_expira_minutos) vigente
     from public.conversas cv join public.tenants tn on tn.id = cv.tenant_id
    where cv.tenant_id = $1 and cv.conversation_id = $2`, [t, conv])).rows[0];

await c.connect();
const fnAntesDeTudo = await existeFn('api_n8n_portao_mensagem');
await c.query('begin');

try {
  console.log('\n== Migração 53: proteção anti-loop ==\n');

  console.log('-- 1. Estado de ANTES, e as duas migrações --\n');
  /*
   * ARRANJA o estado de antes, em vez de afirmar que ele existe.
   *
   * A primeira versão desta linha era `sus('a 53 ainda não está em produção',
   * fnAntesDeTudo === 0)` — verdade quando foi escrita, FALSA quatro horas
   * depois, quando a migração foi aplicada. Estado do mundo, não propriedade;
   * é o defeito que a `migracao-foto-agente.mjs` cometeu com `foto_produto` e
   * que está escrito no CLAUDE.md. Teste que fica vermelho porque o sistema
   * funcionou é a forma mais rápida de todo mundo parar de olhar a suíte.
   *
   * A forma que não envelhece: rodar o ROLLBACK aqui dentro da transação
   * abortada. Ele é idempotente, então põe o banco no estado pré-53 tendo a 53
   * sido aplicada ou não.
   */
  await c.query(R53);
  sus('o rollback deixou o banco no estado pré-53 (portão ausente)',
    (await existeFn('api_n8n_portao_mensagem')) === 0);
  console.log(`  (53 no ledger: ${(await c.query(
    `select 1 from supabase_migrations.schema_migrations where name = '53_anti_loop'`)).rowCount
    ? 'sim — desfeita aqui dentro' : 'ainda não'})`);
  // A 53 usa `contato_exibivel`, que é da 52. A ordem de aplicação é essa, e o
  // teste replaya a CADEIA — replayar um elo sozinho já deixou este repo
  // vermelho por três dias (migração 32 x 37).
  const ap52 = await tentar(M52);
  sus('a 52 aplica primeiro (a 53 depende do `contato_exibivel` dela)',
    ap52.erro === null, ap52.erro ?? '');
  const ap = await tentar(M53);
  chk('a 53 aplica', ap.erro === null, ap.erro ?? '');
  chk('a função do portão existe', (await existeFn('api_n8n_portao_mensagem')) === 1);
  chk('e `texto_normalizado` também', (await existeFn('texto_normalizado')) === 1);

  console.log('\n-- 2. Grants e ACL --\n');
  /*
   * AS DUAS funções da migração, e não só a `api_n8n_*`. Conferir por prefixo
   * deixou `contato_exibivel` (migração 52) aberta para PUBLIC/anon na primeira
   * aplicação em produção — não era vazamento, mas era inconsistência que
   * nenhuma checagem veria.
   */
  const acls53 = (await c.query(
    `select p.proname, coalesce(p.proacl::text, '(default)') a
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname in ('api_n8n_portao_mensagem', 'texto_normalizado')
      order by p.proname`)).rows;
  acls53.forEach((r) => console.log(`      ${r.proname}: ${r.a}`));
  sus('a conferência cobre as DUAS funções da migração', acls53.length === 2, `${acls53.length}`);
  for (const f of acls53) {
    chk(`${f.proname} executável por service_role`, /service_role=X/.test(f.a), f.a);
    chk(`${f.proname} executável por n8n_agent`, /n8n_agent=X/.test(f.a), f.a);
    chk(`${f.proname} NÃO deixou EXECUTE para PUBLIC`, !/\{=X\//.test(f.a), f.a);
    chk(`${f.proname} NÃO abriu para anon`, !/(^|,|\{)anon=X/.test(f.a), f.a);
  }
  const acl = acls53.find((f) => f.proname === 'api_n8n_portao_mensagem').a;

  const aclTab = (await c.query(`select relacl::text a from pg_class where relname = 'alertas_consumo'`)).rows[0].a;
  console.log(`      alertas_consumo: ${aclTab}`);
  chk('`alertas_consumo` dá a authenticated SOMENTE leitura', /authenticated=r\//.test(aclTab), aclTab);
  chk('e `anon` não aparece no ACL dela', !/anon=/.test(aclTab), aclTab);
  chk('`alertas_consumo` tem RLS com policy',
    (await c.query(`select cl.relrowsecurity r, (select count(*)::int from pg_policy p where p.polrelid = cl.oid) n
       from pg_class cl where cl.relname = 'alertas_consumo'`)).rows[0].r === true
    && (await c.query(`select count(*)::int n from pg_policy p
       where p.polrelid = 'public.alertas_consumo'::regclass`)).rows[0].n === 1);

  console.log('\n-- 3. A constraint aceita `anomalia`, e `pausa_vigente` trata --\n');
  const cons = (await c.query(
    `select pg_get_constraintdef(oid) d from pg_constraint
      where conrelid = 'public.conversas'::regclass and conname = 'conversas_motivo_pausa_check'`)).rows[0].d;
  chk('a constraint aceita os TRÊS motivos', /anomalia/.test(cons) && /manual/.test(cons) && /mensagem_humana/.test(cons), cons);

  // A propriedade central: pausa por anomalia com 5 DIAS de idade continua
  // vigente. Se caducasse, a proteção devolveria o agente ao laço.
  const velha = (await c.query(
    `select public.pausa_vigente('pausado', now() - interval '5 days', 'anomalia', 30) v`)).rows[0].v;
  chk('pausa por `anomalia` de 5 dias continua VIGENTE (não caduca)', velha === true, String(velha));
  const humana = (await c.query(
    `select public.pausa_vigente('pausado', now() - interval '90 minutes', 'mensagem_humana', 30) v`)).rows[0].v;
  sus('contraprova: `mensagem_humana` de 90 min CADUCOU (a janela segue viva)', humana === false, String(humana));

  /* -----------------------------------------------------------------------
   * 4. A REGRA CONTRA O HISTÓRICO REAL.
   * --------------------------------------------------------------------- */
  console.log('\n-- 3b. Os tetos são da AGÊNCIA, não do cliente --\n');
  /*
   * Mesma propriedade que a 47 estabeleceu para `pausa_expira_minutos`. Vale
   * conferir aqui porque é exatamente o que faria o portão estourar `42501` em
   * runtime se a marca de "já avisei hoje" morasse em `tenants` em vez de na
   * `alertas_consumo` — o motivo de a tabela existir.
   */
  const semClaim = await tentar(`update public.tenants set teto_aviso_tokens_dia = 5 where slug = 'emporio'`);
  chk('sem claim de super_admin, o teto NÃO pode ser alterado (é coluna de agência)',
    semClaim.erro !== null && semClaim.codigo === '42501', semClaim.erro ?? '(passou!)');
  const comClaim = await tentar(
    `select 1`);
  await c.query(`set local request.jwt.claims = ${CLAIM_SUPER}`);
  const claimOk = await tentar(`update public.tenants set teto_aviso_tokens_dia = 1000000 where slug = 'emporio'`);
  await c.query('reset request.jwt.claims');
  sus('contraprova: COM a claim o mesmo update passa (não é coluna inalterável)',
    comClaim.erro === null && claimOk.erro === null, claimOk.erro ?? '');

  console.log('\n-- 4. A regra contra o histórico REAL de produção --\n');

  // Tetos altos: aqui estamos medindo a regra B. Sem isto o teto (C) dispararia
  // primeiro — o histórico inteiro passa a caber "hoje" depois do deslocamento —
  // e o portão devolveria `teto_consumo` sem nunca chegar à regra de repetição.
  await comoSuper(`update public.tenants set teto_aviso_tokens_dia = 9223372036854775807`);

  /*
   * Só tenants VIVOS. `n8n_assert_tenant` recusa tenant inativo ou soft-deletado
   * com `42501`, e isso é contrato antigo, de toda `api_n8n_*` — o `sandbox`
   * está nas duas condições e tem 5 linhas de log. A primeira versão desta
   * varredura o incluía e reportava "o portão devolveu 0 linhas", que soava
   * defeito da função nova e era o assert fazendo o trabalho dele.
   */
  const alvos = (await c.query(
    `select distinct t.slug, t.id tenant_id, l.conversation_id conv
       from public.mensagens_log l join public.tenants t on t.id = l.tenant_id
      where t.ativo and t.deletado_em is null
      order by t.slug, l.conversation_id`)).rows;
  sus(`há ${alvos.length} conversas reais com histórico para medir`, alvos.length >= 20, `${alvos.length}`);

  // E a recusa em si é propriedade, não acidente: o portão não atende tenant
  // desligado. Sem esta asserção, tirar o `n8n_assert_tenant` passaria calado.
  const morto = (await c.query(
    `select id from public.tenants where not ativo or deletado_em is not null limit 1`)).rows[0];
  if (morto) {
    const rm = await comoN8n(`select * from public.api_n8n_portao_mensagem($1::uuid, 1::bigint)`, [morto.id]);
    chk('o portão RECUSA tenant inativo/deletado (42501), como toda api_n8n_*',
      rm.erro !== null && rm.codigo === '42501', rm.erro ?? '(atendeu!)');
  }

  // Anti-vacuidade do ARRANJO: se o alinhamento não movesse nada, "zero falsos
  // positivos" seria verdade por não haver o que disparar.
  await c.query('savepoint conf');
  const movidas = await alinharMaiorRepeticao();
  const janela20 = (await c.query(
    `select max(l.criado_em) - min(l.criado_em) span, count(*)::int n from (
       select l2.criado_em from public.mensagens_log l2 join public.tenants t2 on t2.id = l2.tenant_id
        where t2.slug = 'emporio' and l2.conversation_id = 20 and l2.direcao = 'entrada'
        order by l2.criado_em desc limit 5) l`)).rows[0];
  sus(`o alinhamento moveu ${movidas} linhas`, movidas > 10000, `${movidas}`);
  sus('e as 5 últimas entradas da conv 20 passaram a caber na janela de 10 min',
    janela20.n === 5 && janela20.span !== null, `span=${JSON.stringify(janela20.span)} n=${janela20.n}`);
  await c.query('rollback to savepoint conf');

  const disparou = await dispararamSob(alvos);
  console.log(`      dispararam: ${disparou.join(', ') || '(nenhuma)'}`);

  chk('1. a regra DISPARA na conversa 20 do emporio (o laço de 5.624 mensagens)',
    disparou.includes('emporio#20'), `disparou em: ${disparou.join(', ') || 'nada'}`);
  chk('2. ZERO falsos positivos nas outras conversas reais',
    disparou.filter((d) => d !== 'emporio#20').length === 0,
    `falsos positivos: ${disparou.filter((d) => d !== 'emporio#20').join(', ')}`);

  console.log('\n-- 5. O portão devolve SEMPRE uma linha --\n');
  // Zero linhas faria o nó do n8n parar o fluxo em silêncio e NENHUM tenant
  // responderia. É a falha mais cara que esta função pode ter.
  const semLog = await semear(`${Math.random().toString(16).slice(2, 8)}-vazio`, 9_530_001, []);
  for (const [nome, r] of [
    ['conversa sem histórico nenhum', await portao(semLog.t, semLog.conv)],
    ['conversation_id que não existe', await portao(semLog.t, 9_999_999)],
  ]) {
    chk(`${nome}: uma linha, e não pausa`,
      r.rows.length === 1 && r.rows[0].pausada === false, r.erro ?? JSON.stringify(r.rows));
  }

  console.log('\n-- 6. Anomalia: pausa, notifica UMA vez, e não volta sozinha --\n');
  const suf = Math.random().toString(16).slice(2, 8);
  const CFG = { notificacao: { canal: 'waha', sessao: `s-${suf}`, destino: '5569900000000@c.us' } };
  const rep = (n, m0, passo) => Array.from({ length: n }, (_, i) => ['{"Olá! Como posso te ajudar hoje?"}', m0 - i * passo]);

  // A e B com o MESMO conversation_id: `conversation_id` não é único entre
  // clientes, e A em laço não pode encostar em B.
  const CONV = 9_530_100 + Math.floor(Math.random() * 100);
  const A = await semear(`${suf}-a`, CONV, rep(5, 4, 1), CFG);
  const B = await semear(`${suf}-b`, CONV, [['quanto custa o bolo de milho?', 3], ['e o de cenoura?', 2]], CFG);

  const rA = await portao(A.t, A.conv);
  chk('A (5 idênticas em 4 min) é pausada por anomalia',
    rA.rows[0]?.pausada === true && rA.rows[0]?.motivo === 'anomalia' && rA.rows[0]?.anomalia === true,
    JSON.stringify(rA.rows[0] ?? rA.erro));
  chk('e a notificação sai pelo canal do `transferir_humano`',
    rA.rows[0]?.sessao === CFG.notificacao.sessao && rA.rows[0]?.destino === CFG.notificacao.destino,
    JSON.stringify(rA.rows[0] ?? null));
  console.log('\n    ┌─ como chega no celular do dono ' + '─'.repeat(38));
  String(rA.rows[0]?.mensagem ?? '').split('\n').forEach((l) => console.log(`    │ ${l}`));
  console.log('    └' + '─'.repeat(70) + '\n');

  const estA = await estadoConversa(A.t, A.conv);
  chk('a conversa ficou `pausado` com motivo `anomalia`',
    estA.status === 'pausado' && estA.motivo_pausa === 'anomalia', JSON.stringify(estA));

  const rA2 = await portao(A.t, A.conv);
  chk('2ª mensagem: segue pausada e NÃO notifica de novo (a transição é uma só)',
    rA2.rows[0]?.pausada === true && rA2.rows[0]?.anomalia === false && rA2.rows[0]?.destino === null,
    JSON.stringify(rA2.rows[0] ?? null));

  // A propriedade que a S3 vai atacar.
  await c.query(`update public.conversas set pausado_em = now() - interval '31 minutes'
                  where tenant_id = $1 and conversation_id = $2`, [A.t, A.conv]);
  const est31 = await estadoConversa(A.t, A.conv);
  chk('31 minutos depois a pausa por anomalia CONTINUA vigente',
    est31.vigente === true, JSON.stringify(est31));

  const rB = await portao(B.t, B.conv);
  chk('B, no MESMO conversation_id mas com mensagens diferentes, NÃO é pausada',
    rB.rows[0]?.pausada === false && rB.rows[0]?.anomalia === false, JSON.stringify(rB.rows[0] ?? null));
  const estB = await estadoConversa(B.t, B.conv);
  chk('e a conversa de B continua ativa (o laço de A não encostou nela)',
    estB.status === 'ativo' && estB.motivo_pausa === null, JSON.stringify(estB));

  // Anti-vacuidade do canal: sem config, pausa mesmo assim — só não notifica.
  const semCfg = await semear(`${suf}-nc`, CONV + 40, rep(5, 4, 1), {});
  const rNC = await portao(semCfg.t, semCfg.conv);
  chk('sem canal configurado, ainda PAUSA — só não tem para onde avisar',
    rNC.rows[0]?.pausada === true && rNC.rows[0]?.anomalia === true && rNC.rows[0]?.destino === null,
    JSON.stringify(rNC.rows[0] ?? null));

  console.log('\n-- 6b. O teto (C) --\n');
  const D = await semear(`${suf}-teto`, CONV + 60, [['oi', 2]], CFG);
  await c.query(`update public.mensagens_log set tokens_entrada = 2000000
                  where tenant_id = $1`, [D.t]);
  await comoSuper(`update public.tenants set teto_aviso_tokens_dia = 1000000, teto_corte_tokens_dia = null
                     where id = $1`, [D.t]);
  const rT = await portao(D.t, D.conv);
  chk('estourar o teto de AVISO não para o agente (corte desligado)',
    rT.rows[0]?.pausada === false, JSON.stringify(rT.rows[0] ?? null));
  const al = (await c.query(`select tipo, tokens_dia, teto from public.alertas_consumo where tenant_id = $1`, [D.t])).rows;
  chk('e grava UM alerta em `alertas_consumo`',
    al.length === 1 && al[0].tipo === 'aviso' && Number(al[0].tokens_dia) >= 2000000, JSON.stringify(al));
  await portao(D.t, D.conv);
  await portao(D.t, D.conv);
  chk('chamar de novo no mesmo dia NÃO duplica o alerta (a unicidade é o claim)',
    (await c.query(`select count(*)::int n from public.alertas_consumo where tenant_id = $1`, [D.t])).rows[0].n === 1);

  await comoSuper(`update public.tenants set teto_corte_tokens_dia = 1000000 where id = $1`, [D.t]);
  const rC = await portao(D.t, D.conv);
  chk('com o corte LIGADO, o portão para o agente no tenant inteiro',
    rC.rows[0]?.pausada === true && rC.rows[0]?.motivo === 'teto_consumo', JSON.stringify(rC.rows[0] ?? null));
  chk('e o corte NÃO pausa a conversa (é do tenant, e evapora à meia-noite)',
    (await estadoConversa(D.t, D.conv)).status === 'ativo');
  // Contraprova: outro tenant não é afetado pelo teto deste.
  const rBteto = await portao(B.t, B.conv);
  chk('o corte de um tenant não alcança outro',
    rBteto.rows[0]?.motivo !== 'teto_consumo', JSON.stringify(rBteto.rows[0] ?? null));
  await comoSuper(`update public.tenants set teto_corte_tokens_dia = null where id = $1`, [D.t]);

  /* -----------------------------------------------------------------------
   * 7. SABOTAGENS
   * --------------------------------------------------------------------- */
  console.log('\n-- 7. Sabotagens --\n');

  // Conversa parada há TRÊS DIAS com 5 entradas idênticas. Com a janela, não
  // dispara. É o falso positivo que a janela existe para evitar: sem ela, o
  // primeiro cliente de verdade a escrever nessa conversa seria pausado.
  const V = await semear(`${suf}-velha`, CONV + 80, rep(5, 60 * 24 * 3, 1), CFG);
  const rV = await portao(V.t, V.conv);
  chk('conversa com 5 idênticas de 3 DIAS atrás não dispara (a janela funciona)',
    rV.rows[0]?.anomalia === false, JSON.stringify(rV.rows[0] ?? null));

  {
    const ALVO = "c_janela      constant interval := interval '10 minutes';";
    sus('S1 o alvo existe no SQL', M53.includes(ALVO));
    const sab = M53.replace(ALVO, "c_janela      constant interval := interval '3650 days';");
    sus('S1 a mutação entrou (a janela virou 10 anos)', sab !== M53 && !sab.includes(ALVO));
    const r = await tentar(sab);
    sus('S1 a versão sabotada aplica', r.erro === null, r.erro ?? '');

    await c.query(`update public.conversas set status = 'ativo', motivo_pausa = null, pausado_em = null
                    where tenant_id = $1`, [V.t]);
    const rS = await portao(V.t, V.conv);
    chk('S1 sem a janela, a conversa parada há 3 dias É PAUSADA (o teste reprova)',
      rS.rows[0]?.anomalia === true,
      `anomalia=${rS.rows[0]?.anomalia} — se for false, a janela não está sendo medida`);
    await c.query(M53);
  }
  {
    const ALVO = 'c_repeticoes  constant integer  := 5;';
    sus('S2 o alvo existe no SQL', M53.includes(ALVO));
    const sab = M53.replace(ALVO, 'c_repeticoes  constant integer  := 2;');
    sus('S2 a mutação entrou (5 repetições viraram 2)', sab !== M53 && !sab.includes(ALVO));
    const r = await tentar(sab);
    sus('S2 a versão sabotada aplica', r.erro === null, r.erro ?? '');

    // MESMO arranjo da seção 4 — o alinhamento não conhece o limiar, então a
    // única coisa que mudou entre as duas medições é o 5 ter virado 2.
    const fp = (await dispararamSob(alvos)).filter((d) => d !== 'emporio#20');
    chk('S2 com 2 repetições, aparecem falsos positivos nas conversas reais (o teste reprova)',
      fp.length > 0,
      `falsos positivos sob sabotagem: ${fp.join(', ') || 'NENHUM'} — se for nenhum, o limiar não está sendo medido`);
    console.log(`        (com N=2, dispararia também em: ${fp.join(', ') || 'nada'})`);
    await c.query(M53);
  }
  {
    /*
     * S3 — a que mais importa. Tira `anomalia` do `pausa_vigente` e a pausa
     * volta a caducar pela janela do tenant, que é EXATAMENTE o que aconteceu
     * com a conversa 20 em 24/08: pausada às 08:12, vencida às 08:42, laço de
     * volta. É o modo de falha mais fácil de reintroduzir sem perceber, porque
     * quem mexer nesse `case` está pensando em outra coisa.
     */
    const ALVO = "when p_motivo_pausa in ('manual', 'anomalia')   then true";
    sus('S3 o alvo existe no SQL', M53.includes(ALVO));
    const sab = M53.replace(ALVO, "when p_motivo_pausa = 'manual'                  then true");
    sus('S3 a mutação entrou (`anomalia` saiu do predicado)', sab !== M53 && !sab.includes(ALVO));
    const r = await tentar(sab);
    sus('S3 a versão sabotada aplica', r.erro === null, r.erro ?? '');

    await c.query(`update public.conversas set status = 'pausado', motivo_pausa = 'anomalia',
                          pausado_em = now() - interval '31 minutes'
                    where tenant_id = $1 and conversation_id = $2`, [A.t, A.conv]);
    const est = await estadoConversa(A.t, A.conv);
    chk('S3 sem o tratamento, a pausa por anomalia CADUCA em 31 min (o teste reprova)',
      est.vigente === false,
      `vigente=${est.vigente} — se for true, este arquivo não mede a propriedade que motivou a migração`);
    const rVolta = await portao(A.t, A.conv);
    console.log(`        (e o portão volta a deixar passar: pausada=${rVolta.rows[0]?.pausada})`);
    await c.query(M53);
  }

  console.log('\n-- 8. Reexecutável e rollback --\n');
  const r2 = await tentar(M53);
  chk('aplicar duas vezes não quebra', r2.erro === null, r2.erro ?? '');

  // O rollback recusa enquanto houver conversa em `anomalia` — e recusar é o
  // comportamento certo, porque a alternativa seria reescrever em silêncio a
  // pausa de uma conversa que alguém precisa olhar.
  const comAnomalia = await tentar(R53);
  chk('o rollback FALHA se há conversa em `anomalia` (recusa é melhor que reescrever calado)',
    comAnomalia.erro !== null && comAnomalia.codigo === '23514', comAnomalia.erro ?? '(passou!)');

  await c.query(`update public.conversas set motivo_pausa = 'manual' where motivo_pausa = 'anomalia'`);
  const limpo = await tentar(R53);
  chk('e passa depois de as conversas em anomalia serem resolvidas à mão',
    limpo.erro === null, limpo.erro ?? '');
  chk('o rollback derruba o portão', (await existeFn('api_n8n_portao_mensagem')) === 0);
  chk('e NÃO leva `api_n8n_conversa_pausada` junto',
    (await existeFn('api_n8n_conversa_pausada')) === 1);
  chk('e devolve `pausa_vigente` ao corpo da 47 (anomalia volta a caducar)',
    (await c.query(`select public.pausa_vigente('pausado', now() - interval '5 days', 'anomalia', 30) v`)).rows[0].v === false);
} catch (e) {
  falhas.push(`exceção não prevista: ${e.message}`);
  console.log(`  FALHA exceção não prevista — ${e.message}`);
} finally {
  await c.query('rollback');
  const depois = await existeFn('api_n8n_portao_mensagem');
  console.log(`\n  (transação revertida; portão em produção: ${depois}` +
    ` — igual a antes: ${fnAntesDeTudo === depois ? 'sim' : 'NÃO'})`);
  if (fnAntesDeTudo !== depois) falhas.push('o teste mudou o schema de produção');
  const sobra = (await c.query(
    `select count(*)::int n from public.tenants where slug like 'zz-efem-loop53-%'`)).rows[0].n;
  console.log(`  (tenants efêmeros sobrando: ${sobra})`);
  if (sobra > 0) falhas.push(`${sobra} tenant(s) efêmero(s) sobraram`);
  const pausadasReais = (await c.query(
    `select count(*)::int n from public.conversas where motivo_pausa = 'anomalia'`)).rows[0].n;
  console.log(`  (conversas reais em anomalia: ${pausadasReais})`);
  if (pausadasReais > 0) falhas.push('o teste deixou conversa real pausada por anomalia');
  await c.end();
}

console.log('\n----------------------------------------------------------');
console.log(`  ${ok + okSus} passaram, ${falhas.length} falharam`);
console.log(`    ${ok} por motivo próprio (propriedade da migração)`);
console.log(`    ${okSus} de sustentação (~) — provam que o TESTE faz o que diz`);
falhas.forEach((f) => console.log(`  ! ${f}`));
console.log();
process.exit(falhas.length === 0 ? 0 : 1);
