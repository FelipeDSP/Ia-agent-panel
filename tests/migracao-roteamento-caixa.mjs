#!/usr/bin/env node
/**
 * Migração 54 (roteamento por conta + caixa) numa TRANSAÇÃO ABORTADA contra
 * produção. Nada é gravado: o rollback do fim é incondicional.
 *
 * ELE COMEÇA RODANDO O PRÓPRIO ROLLBACK DA MIGRAÇÃO, e isso é o conserto do
 * nono defeito da contagem do CLAUDE.md. `tests/migracao-anti-loop.mjs`
 * afirmava "a 53 ainda não está em produção" — verdade quando foi escrita,
 * falsa quatro horas depois, pelo mesmo trabalho. Rodar o rollback primeiro põe
 * o banco no estado pré-migração tendo ela sido aplicada ou não, então este
 * arquivo não afirma o calendário em lugar nenhum e continua valendo depois do
 * apply.
 *
 * O QUE ELE PROVA, e nenhuma destas se lê no SQL:
 *
 *   1. dois agentes cabem na mesma conta — que é a fatia inteira;
 *   2. o `Tenant Valido?` recebe UMA linha, nunca duas. É o defeito que "tirar
 *      a trava sozinha" produziria, e ele não dá erro: dá sorteio;
 *   3. caixa DESCONHECIDA devolve zero linhas em silêncio (caso de negócio) e
 *      caixa NULA estoura 22023 (chamador quebrado). São casos diferentes e
 *      têm de se comportar diferente;
 *   4. a asserção 1 de `tests/desconectar-chatwoot.mjs` continua valendo — é
 *      ela que o único composto derruba, e foi o que mudou o desenho;
 *   5. o ACL fica IDÊNTICO ao das irmãs, comparado contra elas e não contra a
 *      lista que eu esperava (o erro da verificação da 41);
 *   6. e o `n8n_agent` CHAMA de verdade, porque ter grant e conseguir chamar
 *      são medidas diferentes.
 *
 * AS QUATRO SABOTAGENS (seção 4). Cada uma muta o SQL, CONFIRMA que a mutação
 * entrou (md5 antes/depois, e o trecho alvo tem de sumir), aplica e exige que a
 * asserção guardada fique VERMELHA:
 *
 *   S1  troca os dois índices parciais pelo composto  -> "B não toma a conta"
 *   S2  troca casamento estrito por coringa           -> duas linhas voltam
 *   S3  tira o `raise` de p_inbox_id nulo             -> silêncio no lugar de erro
 *   S4  tira o `grant ... to n8n_agent`               -> o agente não chama
 *
 * E cada sabotagem roda nos DOIS fins de linha (LF e CRLF). Em 2026-08-24 o
 * `teste:comparacoes-tipo` morreu porque o arquivo virou CRLF e `.` não casa
 * `\r` — a guarda estava certa e sumiu sem aparecer em diff. Aqui a cirurgia é
 * em texto de SQL, que é a mesma exposição.
 *
 * Uso: npm run teste:roteamento-caixa
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

if (!process.env.SUPABASE_DB_URL) {
  console.error('\n  SUPABASE_DB_URL ausente. Rode com --env-file=.env.local\n');
  process.exit(64);
}

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DIR = `${RAIZ}supabase/migrations/`;

function acharMigracao(sufixo) {
  const a = fs.readdirSync(DIR).filter((f) => f.endsWith(sufixo));
  if (a.length !== 1) throw new Error(`esperava 1 arquivo em "${sufixo}", achei ${a.length}`);
  // `\s*$` com flag `m`: `\r` é whitespace, então isto é CRLF-safe de propósito.
  return fs.readFileSync(DIR + a[0], 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
}

const MIGRACAO = acharMigracao('_54_roteamento_por_caixa.sql');
const ROLLBACK = acharMigracao('_54_roteamento_por_caixa_rollback.sql');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex').slice(0, 8);

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ` — ${det}` : ''}`); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

/**
 * Toda query num savepoint. Rejeição vira VALOR, nunca exceção que derruba o
 * processo — sem isto, uma sabotagem que estoura levaria embora as asserções
 * seguintes e você ficaria sem saber qual propriedade quebrou.
 */
const q = async (sql, params = []) => {
  await c.query('savepoint sp');
  try {
    const r = await c.query(sql, params);
    await c.query('release savepoint sp');
    return { ok: true, code: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sp');
    return { ok: false, code: e.code, err: e.message.split('\n')[0], rows: [] };
  }
};

const CLAIM = `set local request.jwt.claims = '{"app_metadata":{"papel":"super_admin"}}'`;
const inserir = (slug, conta, caixa) =>
  q(
    `insert into public.tenants (slug, nome, ativo, chatwoot_url, chatwoot_account_id, chatwoot_inbox_id)
     values ($1, $1, true, 'https://app.chatyou.chat', $2, $3)`,
    [slug, conta, caixa],
  );
const resolver = (conta, caixa) =>
  q(`select slug from public.api_n8n_tenant_por_chatwoot($1::bigint, $2::bigint)`, [conta, caixa]);

await c.connect();
await c.query('begin');

try {
  console.log('\n== Migração 54 — roteamento por (conta, caixa) ==\n');

  // -----------------------------------------------------------------------
  console.log('-- 1. Estado pré-migração, seja ela aplicada ou não --\n');

  const pre = await q(ROLLBACK);
  chk('o rollback aplica (é ele que dá o ponto de partida)', pre.ok, pre.ok ? '' : `${pre.code} ${pre.err}`);
  const temColuna = await q(
    `select count(*)::int n from information_schema.columns
      where table_schema='public' and table_name='tenants' and column_name='chatwoot_inbox_id'`,
  );
  chk('depois do rollback a coluna NÃO existe', temColuna.rows[0]?.n === 0, JSON.stringify(temColuna.rows));

  // -----------------------------------------------------------------------
  console.log('\n-- 2. A migração aplica, e prova o próprio backfill --\n');

  const ap = await q(MIGRACAO);
  chk('a migração aplica', ap.ok, ap.ok ? '' : `${ap.code} ${ap.err}`);
  if (!ap.ok) throw new Error('sem migração aplicada não há o que medir');

  const est = await q(
    `select slug, chatwoot_account_id::text conta, chatwoot_inbox_id::text caixa
       from public.tenants where chatwoot_account_id is not null order by 2`,
  );
  const porSlug = Object.fromEntries(est.rows.map((r) => [r.slug, r]));
  chk('emporio ficou em (59, 279)', porSlug.emporio?.conta === '59' && porSlug.emporio?.caixa === '279',
    JSON.stringify(porSlug.emporio));
  chk('estudyou-sendbox ficou em (1, 189)', porSlug['estudyou-sendbox']?.conta === '1' && porSlug['estudyou-sendbox']?.caixa === '189',
    JSON.stringify(porSlug['estudyou-sendbox']));
  chk('ceejaar foi SOLTO de propósito (não aparece conectado)', porSlug.ceejaar === undefined,
    JSON.stringify(porSlug.ceejaar));

  const meio = await q(
    `select count(*)::int n from public.tenants
      where (chatwoot_account_id is null) <> (chatwoot_inbox_id is null)`,
  );
  chk('nenhum tenant com o par pela metade', meio.rows[0]?.n === 0, JSON.stringify(meio.rows));

  // -----------------------------------------------------------------------
  console.log('\n-- 3. Roteamento: uma linha, e os dois silêncios diferentes --\n');

  let r = await resolver(59, 279);
  chk('(59,279) resolve o emporio, e UMA linha só',
    r.ok && r.rows.length === 1 && r.rows[0].slug === 'emporio', JSON.stringify(r));

  r = await resolver(59, 999999);
  chk('caixa DESCONHECIDA: zero linhas, sem erro (caso de negócio)',
    r.ok && r.rows.length === 0, JSON.stringify(r));

  r = await resolver(59, null);
  chk('caixa NULA: 22023, e não silêncio (chamador quebrado)',
    !r.ok && r.code === '22023', JSON.stringify(r));

  r = await q(`select * from public.api_n8n_tenant_por_chatwoot(59::bigint)`);
  chk('a assinatura de 1 argumento MORREU (42883, não ambiguidade 42725)',
    !r.ok && r.code === '42883', JSON.stringify(r));

  // -----------------------------------------------------------------------
  console.log('\n-- 4. Dois agentes na mesma conta — a fatia --\n');

  // As seções 4 e 5 plantam tenants extras na MESMA conta, que é justamente o
  // que o rollback se recusa a desfazer sozinho (`23505` no `unique
  // (chatwoot_account_id)`, e está certo: escolher qual agente perde a conta
  // não é decisão de script). A seção 7 roda o rollback a cada sabotagem, então
  // este cenário precisa sair antes — daí o savepoint.
  await c.query('savepoint cenario');
  await c.query(CLAIM);
  chk('um 2º agente entra em (59, 280)', (await inserir('zz-cx-2ag', 59, 280)).ok);

  r = await resolver(59, 280);
  chk('(59,280) resolve o novo, e só ele',
    r.ok && r.rows.length === 1 && r.rows[0].slug === 'zz-cx-2ag', JSON.stringify(r));
  r = await resolver(59, 279);
  chk('(59,279) continua no emporio — os dois convivem',
    r.ok && r.rows.length === 1 && r.rows[0].slug === 'emporio', JSON.stringify(r));

  chk('a MESMA caixa repetida na conta é barrada (23505)',
    (await inserir('zz-cx-3ag', 59, 280)).code === '23505');
  chk('par pela metade (59, null) é barrado pelo CHECK (23514)',
    (await inserir('zz-cx-4ag', 59, null)).code === '23514');
  chk('par pela metade (null, 279) é barrado pelo CHECK (23514)',
    (await inserir('zz-cx-5ag', null, 279)).code === '23514');
  chk('desconectado (null, null) continua entrando quantas vezes for',
    (await inserir('zz-cx-6ag', null, null)).ok && (await inserir('zz-cx-7ag', null, null)).ok);

  // AS DUAS CAMADAS, medidas separadas. Acima, o CHECK impede o par pela metade.
  // Aqui, com o CHECK fora, o `idx_tenants_chatwoot_sem_caixa` ainda impede que
  // dois cadastros reivindiquem a mesma conta sem caixa — que é o bug original
  // ("três tenants na conta 59"). Sem esta asserção o índice pareceria supérfluo,
  // porque com o CHECK de pé ele nunca é acionado.
  await c.query('savepoint sem_check');
  await q('alter table public.tenants drop constraint tenants_chatwoot_par_check');
  const cor = 920000 + Math.floor(Math.random() * 70000);
  const cor1 = await inserir('zz-cx-cor1', cor, null);
  const cor2 = await inserir('zz-cx-cor2', cor, null);
  chk('com o CHECK fora, o 1º coringa entra (contraprova)', cor1.ok, JSON.stringify(cor1));
  chk('com o CHECK fora, o 2º coringa na mesma conta é barrado (23505)',
    cor2.code === '23505', JSON.stringify(cor2));
  await c.query('rollback to savepoint sem_check');

  // -----------------------------------------------------------------------
  console.log('\n-- 5. A asserção 1 do desconectar-chatwoot continua valendo --\n');

  const conta = 900000 + Math.floor(Math.random() * 90000); // fora da faixa real
  await inserir('zz-cx-dA', conta, 1);
  const b = (await q(`insert into public.tenants (slug, nome, ativo) values ('zz-cx-dB','B',true) returning id`)).rows[0].id;
  chk('B NÃO toma a (conta, caixa) que A já tem',
    (await q(`update public.tenants set chatwoot_account_id=$2, chatwoot_inbox_id=1 where id=$1`, [b, conta])).code === '23505');
  chk('mas B TOMA outra caixa da mesma conta (é o objetivo da fatia)',
    (await q(`update public.tenants set chatwoot_account_id=$2, chatwoot_inbox_id=2 where id=$1`, [b, conta])).ok);

  await c.query('rollback to savepoint cenario');

  // -----------------------------------------------------------------------
  console.log('\n-- 6. ACL contra as IRMÃS, e chamada real como n8n_agent --\n');

  const acl = await q(
    `select proname, coalesce(array_to_string(proacl, ' | '), '<default>') a
       from pg_proc
      where proname in ('api_n8n_tenant_por_chatwoot', 'api_n8n_portao_mensagem', 'api_n8n_conversa_pausada')
      order by 1`,
  );
  const norm = (s) => s.split(' | ').sort().join(' | ');
  const minha = acl.rows.find((x) => x.proname === 'api_n8n_tenant_por_chatwoot');
  const irmas = acl.rows.filter((x) => x.proname !== 'api_n8n_tenant_por_chatwoot');
  chk('o ACL é idêntico ao das irmãs (não à minha expectativa)',
    irmas.length === 2 && irmas.every((i) => norm(i.a) === norm(minha?.a ?? '')),
    `\n     minha: ${minha?.a}\n     irmãs: ${irmas.map((i) => i.a).join('\n            ')}`);
  chk('e ninguém abriu para anon/authenticated/PUBLIC',
    !/(^|\| )(anon|authenticated)=/.test(minha?.a ?? '') && !/(^|\| )=X/.test(minha?.a ?? ''),
    minha?.a);

  await c.query('savepoint papel');
  await c.query('set local role n8n_agent');
  const real = await q(`select slug from public.api_n8n_tenant_por_chatwoot(59::bigint, 279::bigint)`);
  await c.query('reset role');
  await c.query('rollback to savepoint papel');
  chk('n8n_agent CHAMA de verdade (ter grant é outra medida)',
    real.ok && real.rows.length === 1, JSON.stringify(real));

  // -----------------------------------------------------------------------
  console.log('\n-- 7. Sabotagens: cada guarda tem de saber ficar vermelha --\n');

  /**
   * `troca` é uma função (texto -> texto). A sabotagem só conta se o md5 mudar
   * E o trecho alvo sumir: "rodou e não falhou" com a mutação que não aplicou
   * já produziu falso verde duas vezes neste repo.
   */
  const SABOTAGENS = [
    {
      id: 'S1',
      o_que: 'tira o índice parcial da conta-sem-caixa',
      guarda: 'sem o CHECK, dois coringas na mesma conta são barrados',
      // A PRIMEIRA VERSÃO DESTA SABOTAGEM ESTAVA ERRADA, e o que a pegou foi
      // rodá-la. Ela trocava os DOIS parciais pelo composto e esperava vermelho
      // em "B não toma a conta de A" — e ficou VERDE, porque com o
      // `tenants_chatwoot_par_check` validado a linha `(conta, null)` é
      // impossível, e o composto passa a ser equivalente aos dois parciais.
      //
      // Ou seja: o `idx_tenants_chatwoot_sem_caixa` guarda um estado que o CHECK
      // já proíbe. Ele é SEGUNDA CAMADA, e a sabotagem honesta é a que mede
      // segunda camada — derruba a primeira (o CHECK) e exige que a segunda
      // ainda segure. Manter a versão antiga seria creditar ao índice uma
      // proteção que quem dá é a constraint.
      //
      // Corta `drop index`, `create` e `comment on index` juntos: recortar só o
      // `create` deixaria o `comment` órfão e a migração morreria em 42P01 antes
      // de medir nada — vermelho pelo motivo errado.
      troca: (s) =>
        s.replace(
          /drop index if exists public\.idx_tenants_chatwoot_sem_caixa;[\s\S]*?(?=-- O CHECK e BICONDICIONAL)/,
          '',
        ),
      // O marcador precisa ser único no ARQUIVO INTEIRO. `idx_tenants_chatwoot_sem_caixa`
      // sozinho não serve: o cabeçalho cita o nome ao explicar o desenho, então
      // ele sobrevive à mutação e a conferência acusaria mutação-não-entrou numa
      // que entrou. É o mesmo auto-casamento comentário-x-código que derrubou o
      // `teste:comparacoes-tipo` — só que do outro lado.
      sumiu: 'create unique index idx_tenants_chatwoot_sem_caixa',
      medir: async () => {
        await c.query(CLAIM);
        await q('alter table public.tenants drop constraint tenants_chatwoot_par_check');
        const ct = 910000 + Math.floor(Math.random() * 80000);
        const primeiro = await inserir('zz-sb-cor1', ct, null);
        if (!primeiro.ok) return true; // sem o 1º coringa a medição é vácua: reprova
        const segundo = await inserir('zz-sb-cor2', ct, null);
        return segundo.code === '23505';
      },
    },
    {
      id: 'S2',
      o_que: 'troca o casamento estrito pelo coringa (inbox nula casa tudo)',
      guarda: '(59,279) resolve o emporio, e UMA linha só',
      troca: (s) =>
        s.replace(
          'and t.chatwoot_inbox_id  = p_inbox_id',
          'and (t.chatwoot_inbox_id is null or t.chatwoot_inbox_id = p_inbox_id)',
        ),
      sumiu: 'and t.chatwoot_inbox_id  = p_inbox_id',
      medir: async () => {
        // O coringa só se manifesta se EXISTIR um coringa. Sem plantar um, a
        // asserção passaria por vacuidade — que é a contraprova exigida.
        //
        // E plantar um exige derrubar o CHECK antes, o que é achado e não
        // obstáculo: o `tenants_chatwoot_par_check` sozinho JÁ torna a linha
        // coringa impossível de criar. São duas camadas independentes contra o
        // mesmo bug, e a asserção "par pela metade (59, null) é barrado (23514)"
        // lá em cima é quem mede a outra. Aqui derrubo o CHECK de propósito para
        // medir o CASAMENTO isolado — senão eu estaria creditando ao corpo da
        // função uma proteção que quem dá é a constraint.
        await c.query(CLAIM);
        await q('alter table public.tenants drop constraint tenants_chatwoot_par_check');
        const plantou = await q(
          `insert into public.tenants (slug, nome, ativo, chatwoot_url, chatwoot_account_id, chatwoot_inbox_id)
           values ('zz-sb-coringa','c',true,'https://x',59,null)`,
        );
        if (!plantou.ok) return true; // sem coringa plantado a medição é vácua: reprova
        const t = await resolver(59, 279);
        return t.ok && t.rows.length === 1 && t.rows[0].slug === 'emporio';
      },
    },
    {
      id: 'S3',
      o_que: 'tira o `raise` de p_inbox_id nulo',
      guarda: 'caixa NULA: 22023, e não silêncio',
      troca: (s) =>
        s.replace(
          /if p_inbox_id is null then[\s\S]*?using errcode = '22023';\r?\n  end if;/,
          '-- sabotado',
        ),
      sumiu: "p_inbox_id e obrigatorio",
      medir: async () => {
        const t = await resolver(59, null);
        return !t.ok && t.code === '22023';
      },
    },
    {
      id: 'S4',
      o_que: 'tira o `grant ... to n8n_agent`',
      guarda: 'n8n_agent CHAMA de verdade',
      troca: (s) =>
        s.replace(
          'grant execute on function public.api_n8n_tenant_por_chatwoot(bigint, bigint) to n8n_agent;',
          '-- sabotado',
        ),
      sumiu: 'api_n8n_tenant_por_chatwoot(bigint, bigint) to n8n_agent;',
      medir: async () => {
        await c.query('savepoint pp');
        await c.query('set local role n8n_agent');
        const t = await resolver(59, 279);
        await c.query('reset role');
        await c.query('rollback to savepoint pp');
        return t.ok && t.rows.length === 1;
      },
    },
  ];

  // Os dois fins de linha. `\r` só some do texto do SQL; a semântica não muda,
  // mas a cirurgia de string muda — e foi exatamente isso que matou uma guarda
  // de verdade em 24/08.
  const FINS = [
    ['LF', (s) => s.replace(/\r\n/g, '\n')],
    ['CRLF', (s) => s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')],
  ];

  for (const s of SABOTAGENS) {
    for (const [rotulo, fim] of FINS) {
      const base = fim(MIGRACAO);
      const mutado = s.troca(base);

      const entrou = md5(base) !== md5(mutado) && base.includes(fim(s.sumiu)) && !mutado.includes(fim(s.sumiu));
      chk(`${s.id}/${rotulo} a mutação ENTROU (${md5(base)} -> ${md5(mutado)})`, entrou);
      if (!entrou) continue;

      await c.query('savepoint sab');
      const volta = await q(fim(ROLLBACK));
      const aplic = await q(mutado);
      if (!volta.ok || !aplic.ok) {
        // Sabotagem que nem aplica não mede nada — e é falha, não "tudo bem".
        chk(`${s.id}/${rotulo} o SQL sabotado aplica`, false,
          `rollback ${volta.code ?? 'ok'} / migração ${aplic.code} ${aplic.err}`);
        await c.query('rollback to savepoint sab');
        continue;
      }

      const guardaPassou = await s.medir();
      chk(`${s.id}/${rotulo} "${s.guarda}" fica VERMELHA (${s.o_que})`, guardaPassou === false,
        guardaPassou ? 'a guarda passou com o SQL sabotado — ela não mede nada' : '');
      await c.query('rollback to savepoint sab');
    }
  }
} catch (e) {
  falhas.push(`execução interrompida: ${e.message}`);
  console.log(`  FALHA execução interrompida — ${e.message}`);
} finally {
  try { await c.query('rollback'); } catch { /* conexão já perdida */ }
  await c.end().catch(() => {});
}

console.log('\n' + '-'.repeat(60));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();
process.exit(falhas.length ? 1 : 0);
