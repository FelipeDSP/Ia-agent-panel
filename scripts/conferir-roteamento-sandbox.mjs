#!/usr/bin/env node
/**
 * PASSO 0 — a conferência. "Uma mensagem no sendbox produz UMA execução, no
 * workflow certo."
 *
 * ---------------------------------------------------------------------------
 * O QUE ELE PROVA E O QUE ELE NÃO PROVA
 *
 * Ele NÃO fala com o n8n nem com o Chatwoot. O token dos três tenants
 * conectados é de Agent Bot, e a API do Chatwoot responde **401** em
 * `/accounts/{id}/inboxes` para bots — medido, e é o mesmo motivo pelo qual
 * `PENDENCIA-CAIXA-SEM-VALIDACAO.md` existe. Então não há como perguntar ao
 * Chatwoot para onde ele manda o webhook.
 *
 * O que dá para medir, e é o que importa, sai do BANCO:
 *
 *   PARTE A (roteia certo) — os dois pares (conta, caixa) resolvem para tenants
 *     DIFERENTES, pela mesma função que o workflow usa. Executando, não
 *     comparando texto.
 *
 *   PARTE B (uma execução só) — depois de você mandar UMA mensagem no sendbox,
 *     `mensagens_log` mostra a marca da duplicidade se ela existir: a MESMA
 *     mensagem gravada por execuções DIFERENTES. Dois workflows inscritos no
 *     mesmo par produzem exatamente isso.
 *
 * ---------------------------------------------------------------------------
 * SEM TRÁFEGO ELE FALHA, E ISSO É DE PROPÓSITO. Um verificador que devolve
 * verde num banco onde nada aconteceu é a asserção vácua contra a qual a seção
 * de testes do CLAUDE.md inteira existe — "o tenant A não vê o dado de B" é
 * verdadeiro quando B não tem dado. Aqui: "não houve execução dupla" é
 * verdadeiro quando não houve execução. Ele exige a contraprova.
 *
 * Uso:
 *   node --env-file=.env.local scripts/conferir-roteamento-sandbox.mjs [minutos]
 *
 * Roteiro:
 *   1. importe `n8n/workflows/pagamento-sandbox-passo0.json`, ative, copie a URL
 *      de produção do webhook;
 *   2. no Chatwoot da conta 57, aponte o webhook da caixa 282 para ela;
 *   3. mande UMA mensagem de cliente no sendbox e UMA no `emporio`;
 *   4. rode este script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINUTOS = Number(process.argv[2] ?? 30);

const PARES = [
  { slug: 'estudyou-sendbox', conta: 57, caixa: 282, onde: 'workflow de TESTE (passo 0)' },
  { slug: 'emporio', conta: 59, caixa: 279, onde: 'workflow PRINCIPAL' },
];

let problemas = 0;
const falha = (m) => { problemas++; console.log(`  ✗ ${m}`); };
const okk = (m) => console.log(`  ✓ ${m}`);

const url = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

try {
  console.log(`\n== Passo 0 — roteamento do sandbox (janela: ${MINUTOS} min) ==\n`);

  // -------------------------------------------------------------------------
  console.log('-- A. Os dois pares resolvem para tenants diferentes --\n');
  const resolvido = {};
  for (const p of PARES) {
    // A MESMA função que o workflow chama, EXECUTADA. Comparar o texto do nó
    // com o que eu espero mediria a minha expectativa; chamar mede o banco.
    const r = await c.query(
      `select t.slug from public.api_n8n_tenant_por_chatwoot($1::bigint, $2::bigint) f
         join public.tenants t on t.id = f.tenant_id`, [p.conta, p.caixa]);
    const slug = r.rows[0]?.slug ?? null;
    resolvido[p.slug] = slug;
    if (slug === p.slug) okk(`(${p.conta}, ${p.caixa}) -> ${slug}   [${p.onde}]`);
    else falha(`(${p.conta}, ${p.caixa}) resolveu para ${slug ?? 'NADA'}, esperava ${p.slug}`);
  }
  if (resolvido['estudyou-sendbox'] && resolvido['estudyou-sendbox'] === resolvido['emporio']) {
    falha('os DOIS pares resolvem para o MESMO tenant — o sandbox não está isolado');
  } else {
    okk('e são tenants distintos');
  }

  // Caixa nula tem de estourar, não escolher alguém. É o que impede um webhook
  // sem `inbox_id` de cair no tenant errado.
  {
    let err = null;
    try { await c.query(`select * from public.api_n8n_tenant_por_chatwoot(57, null)`); }
    catch (e) { err = e; }
    if (err && err.code === '22023') okk('caixa nula estoura 22023 (não escolhe ninguém)');
    else falha(`caixa nula devia estourar 22023, deu ${err ? err.code : 'nada'}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n-- B. Uma mensagem, uma execução --\n');
  const t = await c.query(`select id, slug from public.tenants where slug = 'estudyou-sendbox'`);
  const tid = t.rows[0].id;

  const linhas = (await c.query(
    `select conversation_id, direcao, execucao_id, criado_em,
            left(coalesce(conteudo,''), 120) as trecho
       from public.mensagens_log
      where tenant_id = $1
        and criado_em > now() - make_interval(mins => $2)
      order by criado_em`, [tid, MINUTOS])).rows;

  console.log(`     ${linhas.length} linha(s) de log no sendbox nos últimos ${MINUTOS} min`);
  for (const l of linhas) {
    console.log(`       ${l.criado_em.toISOString().slice(11, 19)}  ${l.direcao.padEnd(7)}`
      + `  conv=${l.conversation_id}  exec=${l.execucao_id ?? '-'}  ${JSON.stringify(l.trecho.slice(0, 50))}`);
  }

  if (linhas.length === 0) {
    // NÃO É VERDE. Ver o cabeçalho: sem tráfego, "não houve duplicidade" é
    // verdadeiro por vacuidade e não prova nada.
    falha(`NADA A MEDIR: nenhuma mensagem no sendbox nos últimos ${MINUTOS} min. `
      + 'Mande uma mensagem de cliente e rode de novo — passo 0 NÃO está provado.');
  } else {
    // A MARCA DA DUPLICIDADE: mesma mensagem, execuções diferentes.
    const dup = (await c.query(
      `select conversation_id, direcao, left(coalesce(conteudo,''),60) trecho,
              count(distinct execucao_id)::int execs, count(*)::int linhas
         from public.mensagens_log
        where tenant_id = $1
          and criado_em > now() - make_interval(mins => $2)
        group by 1,2,3
       having count(distinct execucao_id) > 1`, [tid, MINUTOS])).rows;

    if (dup.length === 0) {
      okk('nenhuma mensagem foi gravada por mais de uma execução');
    } else {
      for (const d of dup) {
        falha(`DUPLICADA: conv=${d.conversation_id} ${d.direcao} em ${d.execs} execuções `
          + `(${d.linhas} linhas) — ${JSON.stringify(d.trecho)}`);
      }
      falha('DOIS workflows estão atendendo o par (57, 282). Pare aqui: '
        + 'qualquer medição de pagamento feita agora mede outra coisa.');
    }

    // E o espelho: o `emporio` continua sendo atendido. Se o passo 0 tiver
    // roubado o webhook dele, o silêncio é o sintoma.
    const e = await c.query(`select id from public.tenants where slug = 'emporio'`);
    const nEmporio = (await c.query(
      `select count(*)::int n from public.mensagens_log
        where tenant_id = $1 and criado_em > now() - make_interval(mins => $2)`,
      [e.rows[0].id, MINUTOS])).rows[0].n;
    console.log(`\n     emporio: ${nEmporio} linha(s) na mesma janela`);
    console.log('     (zero aqui só é problema se você mandou mensagem no emporio também)');
  }
} finally {
  await c.end();
}

console.log(`\n${'-'.repeat(62)}`);
if (problemas) {
  console.log(`  ${problemas} problema(s). PASSO 0 NÃO PROVADO — não siga para pagamento.`);
  process.exit(1);
}
console.log('  Passo 0 provado: roteia certo e não duplica.');
