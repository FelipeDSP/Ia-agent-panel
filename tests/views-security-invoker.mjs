#!/usr/bin/env node
/**
 * Toda view de `public` roda com `security_invoker = true` — ou está numa lista
 * de exceções declarada, com o motivo escrito ao lado.
 *
 * POR QUE EXISTE. View sem a opção roda com os privilégios do DONO, que é
 * `postgres`, e `postgres` tem `rolbypassrls = true` neste projeto. Ela lê a
 * base passando por cima da RLS. Medido em 2026-08-21 com duas views idênticas
 * lidas por `authenticated` com claims de um tenant: sem a opção, 89 linhas de 5
 * tenants; com ela, 16 de 1. E `FORCE ROW LEVEL SECURITY` na tabela não salva —
 * FORCE sujeita o dono à policy, não vence BYPASSRLS.
 *
 * O gatilho "lembre-se disso ao criar uma view" não sobrevive a seis meses:
 * quem escreve uma view de vagas não está pensando em BYPASSRLS. Este arquivo é
 * o gatilho mecânico. Varre por PADRÃO e não por lista, como o
 * `teste:grants-n8n`: view nova entra na vigilância sozinha, e o esquecimento
 * vira vermelho — que alguém nota — em vez de vazamento, que ninguém nota.
 *
 * ------------------------------------------------------------------------
 * O QUE ELE NÃO PEGA. Está escrito aqui porque uma rede grossa que se apresenta
 * como fina é pior do que rede nenhuma.
 *
 *   - O TESTE MEDE A OPÇÃO, NÃO O ISOLAMENTO. View com `security_invoker` sobre
 *     tabela SEM RLS passa neste arquivo e não protege nada: não há policy para
 *     respeitar. A `conversas_painel` é o contraexemplo do próprio teste — ela
 *     só isola porque `conversas` tem RLS com policy, e quem prova isso é o
 *     `teste:conversas-painel`, com três tenants e a sabotagem. A fina continua
 *     sendo por objeto;
 *   - não olha ACL. `podcast_vagas` tem `anon = arwdDxtm` e passaria aqui de
 *     qualquer jeito. Privilégio de coluna, `revoke`, grant indevido: nada disso
 *     é visto daqui;
 *   - não lê o texto do `select`. Uma view que expõe PII com a opção ligada
 *     passa;
 *   - MATERIALIZED VIEW entra na varredura por completude, mas `security_invoker`
 *     não se aplica a ela — matview é lida como dado já materializado. Hoje não
 *     há nenhuma em `public`. Se aparecer, este teste reprova e alguém decide o
 *     que fazer; reprovar é a resposta certa para "situação que ninguém pensou";
 *   - só `public`. Outros schemas não são varridos.
 *
 * ------------------------------------------------------------------------
 * COMO A LISTA DE EXCEÇÕES É MANTIDA. A asserção é DUPLA, e é a segunda metade
 * que impede a lista de apodrecer:
 *
 *   1. toda view sem a opção TEM de estar na lista;
 *   2. toda entrada da lista TEM de corresponder a uma view que existe e que de
 *      fato ainda não tem a opção.
 *
 * Sem (2) a lista só cresce: exceção resolvida fica lá para sempre, e daqui a um
 * ano ninguém sabe quais linhas ainda valem. Com (2), exceção obsoleta REPROVA e
 * força a poda. É o mesmo problema do `ROTAS_SEMPRE_VISIVEIS`.
 *
 * Uso: npm run teste:views-invoker
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/* -------------------------------------------------------------------------
 * A LISTA DE EXCEÇÕES.
 *
 * Entrar aqui é decisão, não conveniência: significa que a view roda com
 * BYPASSRLS de propósito e alguém escreveu por quê. `motivo` é obrigatório e
 * conferido — placeholder não passa.
 * ------------------------------------------------------------------------- */
const EXCECOES = [
  {
    nome: 'podcast_vagas',
    desde: '2026-08-24',
    motivo:
      'A base `podcast_agendamentos` tem RLS SEM POLICY NENHUMA, o que nega tudo. ' +
      'Com `security_invoker` a view passa a rodar como o invocador, que lê zero ' +
      'linhas, e a agregação vira zero: a página mostraria 6 vagas livres em TODO ' +
      'dia, incluindo o 01/08 que está lotado — medido, não deduzido. O conserto ' +
      'óbvio quebra a página em silêncio. Sai desta lista quando a saída A da ' +
      'docs/PENDENCIA-PODCAST-VAGAS.md for aplicada (grant por coluna na base + ' +
      'policy + security_invoker), e isso depende de falar com quem mantém a ' +
      'aplicação do podcast — o repo não tem o código dela.',
  },
];

/** Motivo curto é motivo que não foi escrito. */
const MOTIVO_MINIMO = 80;

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const env = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8');
const URL_BANCO = env
  .split(/\r?\n/)
  .find((l) => l.startsWith('SUPABASE_DB_URL='))
  ?.slice('SUPABASE_DB_URL='.length)
  .trim()
  .replace(/^["']|["']$/g, '');

if (!URL_BANCO) {
  console.error('\n  SUPABASE_DB_URL ausente no .env.local\n');
  process.exit(64);
}

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

const c = new Client({ connectionString: URL_BANCO, ssl: { rejectUnauthorized: false } });
await c.connect();

/**
 * A varredura, isolada numa função porque a SABOTAGEM precisa rodar a MESMA
 * varredura contra um banco adulterado. Se a sabotagem chamasse uma cópia da
 * lógica, ela provaria que a cópia funciona.
 */
async function varrer() {
  const { rows } = await c.query(`
    select cl.relname nome,
           cl.relkind tipo,
           coalesce(array_to_string(cl.reloptions, ','), '') opcoes,
           coalesce(cl.reloptions, '{}') @> array['security_invoker=true'] tem_invoker
      from pg_class cl
      join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname = 'public'
       and cl.relkind in ('v', 'm')
     order by cl.relname`);
  return rows;
}

try {
  console.log('\n== security_invoker em toda view de `public` ==\n');

  const objetos = await varrer();
  console.log(`  ${objetos.length} objeto(s) varrido(s):\n`);
  objetos.forEach((o) => console.log(
    `    ${o.tipo === 'm' ? 'matview' : 'view   '} ${o.nome.padEnd(28)}`
    + `${o.tem_invoker ? 'security_invoker=true' : '>>> SEM security_invoker'}`
    + `${o.opcoes ? `   [${o.opcoes}]` : ''}`));
  console.log();

  /*
   * ANTI-VACUIDADE. Se a query não achasse nada — schema errado, relkind errado,
   * conexão para o banco errado — as asserções abaixo passariam sem medir coisa
   * alguma. "Nenhuma view sem security_invoker" é verdade num banco vazio. Este
   * projeto tem view; se a varredura não achar nenhuma, ela está quebrada.
   */
  sus('a varredura achou views em `public` (asserção vazia não vale)',
    objetos.length > 0, `${objetos.length} objetos`);
  sus('e achou ao menos uma COM a opção (a query sabe reconhecê-la)',
    objetos.some((o) => o.tem_invoker),
    objetos.map((o) => `${o.nome}=${o.tem_invoker}`).join(' '));

  const nomesExcecao = EXCECOES.map((e) => e.nome);

  console.log('-- 1. Toda view sem a opção está declarada como exceção --\n');
  const semOpcao = objetos.filter((o) => !o.tem_invoker);
  const naoDeclaradas = semOpcao.filter((o) => !nomesExcecao.includes(o.nome));
  chk('nenhuma view de `public` roda com BYPASSRLS sem estar declarada',
    naoDeclaradas.length === 0,
    naoDeclaradas.length
      ? `sem security_invoker e fora da lista: ${naoDeclaradas.map((o) => o.nome).join(', ')}`
        + ' — acrescente a opção à view, ou declare a exceção em EXCECOES com o motivo'
      : '');

  console.log('\n-- 2. Toda exceção declarada ainda existe e ainda é exceção --\n');
  for (const e of EXCECOES) {
    const alvo = objetos.find((o) => o.nome === e.nome);
    chk(`exceção \`${e.nome}\` aponta para uma view que existe`,
      alvo !== undefined, 'a view sumiu — remova a linha de EXCECOES');
    if (alvo) {
      chk(`exceção \`${e.nome}\` ainda é necessária (a view segue sem a opção)`,
        !alvo.tem_invoker,
        'a view GANHOU `security_invoker` — a exceção virou mentira; remova a linha de EXCECOES');
    }
    chk(`exceção \`${e.nome}\` tem motivo escrito (>= ${MOTIVO_MINIMO} chars)`,
      typeof e.motivo === 'string' && e.motivo.trim().length >= MOTIVO_MINIMO,
      `${(e.motivo ?? '').trim().length} chars`);
    chk(`exceção \`${e.nome}\` tem data \`desde\` em AAAA-MM-DD`,
      /^\d{4}-\d{2}-\d{2}$/.test(e.desde ?? ''), String(e.desde));
  }
  const dup = nomesExcecao.filter((n, i) => nomesExcecao.indexOf(n) !== i);
  chk('a lista de exceções não tem nome repetido', dup.length === 0, dup.join(','));

  /* -----------------------------------------------------------------------
   * 3. SABOTAGEM.
   *
   * Tirar `security_invoker` de uma view que a TEM e exigir que a varredura
   * reprove. Sem isto, este arquivo poderia estar lendo `reloptions` errado — ou
   * não estar lendo nada — e imprimiria verde do mesmo jeito.
   *
   * Roda em transação e o rollback é incondicional. `alter view` é DDL e é
   * transacional no Postgres, então nada sobra em produção; o `sus` do fim mede
   * isso em vez de acreditar.
   * --------------------------------------------------------------------- */
  console.log('\n-- 3. Sabotagem: tira o `security_invoker` da conversas_painel --\n');
  const ALVO = 'conversas_painel';
  const antes = objetos.find((o) => o.nome === ALVO);
  sus(`S1 a \`${ALVO}\` TEM a opção antes da sabotagem (senão não há o que tirar)`,
    antes?.tem_invoker === true, JSON.stringify(antes ?? null));

  if (antes?.tem_invoker) {
    await c.query('begin');
    try {
      await c.query(`alter view public.${ALVO} reset (security_invoker)`);

      // Confirme que a MUTAÇÃO ENTROU antes de acreditar no resultado. Sabotagem
      // que não mutou nada já produziu falso verde duas vezes neste repo.
      const depois = await varrer();
      const alvoDepois = depois.find((o) => o.nome === ALVO);
      sus('S1 a mutação entrou (a view ficou sem a opção)',
        alvoDepois !== undefined && !alvoDepois.tem_invoker, JSON.stringify(alvoDepois ?? null));

      const naoDeclaradasSab = depois
        .filter((o) => !o.tem_invoker)
        .filter((o) => !nomesExcecao.includes(o.nome));
      chk('S1 com a opção removida, a varredura REPROVA (o teste sabe falhar)',
        naoDeclaradasSab.some((o) => o.nome === ALVO),
        `não declaradas sob sabotagem: [${naoDeclaradasSab.map((o) => o.nome).join(', ')}]`
        + ' — se a `conversas_painel` não aparecer aqui, este arquivo NÃO mede nada');
      console.log(`        (sob sabotagem a varredura acusou: ${naoDeclaradasSab.map((o) => o.nome).join(', ') || 'NADA'})`);
    } finally {
      await c.query('rollback');
    }

    const restaurado = (await varrer()).find((o) => o.nome === ALVO);
    sus('S1 o rollback devolveu a opção à view em produção',
      restaurado?.tem_invoker === true, JSON.stringify(restaurado ?? null));
  }
} catch (e) {
  falhas.push(`exceção não prevista: ${e.message}`);
  console.log(`  FALHA exceção não prevista — ${e.message}`);
} finally {
  await c.end();
}

console.log('\n----------------------------------------------------------');
console.log(`  ${ok + okSus} passaram, ${falhas.length} falharam`);
console.log(`    ${ok} por motivo próprio (a propriedade que o teste guarda)`);
console.log(`    ${okSus} de sustentação (~) — provam que o TESTE faz o que diz`);
falhas.forEach((f) => console.log(`  ! ${f}`));
console.log();
process.exit(falhas.length === 0 ? 0 : 1);
