#!/usr/bin/env node
/**
 * Migração 59 (a busca separa RESULTADO de MENÇÃO) em TRANSAÇÃO ABORTADA contra
 * produção. Nada é gravado.
 *
 * COMEÇA PELO ROLLBACK da própria migração — põe o banco no estado pré-59 tendo
 * ela sido aplicada ou não, então este arquivo não afirma o calendário.
 *
 * ---------------------------------------------------------------------------
 * O CASO QUE ESTE TESTE EXISTE PARA NÃO SER:
 *
 *   "um teste que afirme «NR 01 devolve 1 resultado» PASSA numa implementação
 *    que quebrou a busca inteira e devolve 1 para tudo."
 *
 * Três coisas fecham essa porta, e nenhuma delas sozinha basta:
 *
 *   1. cada termo é afirmado NOS DOIS LADOS — quantos no bloco RESULTADO **e**
 *      quantos no bloco MENÇÃO. A busca que devolve 1 para tudo falha na segunda
 *      metade de cada par;
 *   2. o TOTAL de cada termo é medido ANTES da migração e comparado com o de
 *      DEPOIS. O número esperado não é escrito à mão: sai do banco pré-59. Se
 *      "curso" cair de 19, alguma coisa se perdeu no caminho — que não é o que
 *      esta correção deveria fazer;
 *   3. o caso do cliente é afirmado NOMINALMENTE, produto a produto: o de
 *      R$ 69,90 no RESULTADO, os dois de NR 10 na MENÇÃO — presentes, não
 *      sumidos.
 *
 * ---------------------------------------------------------------------------
 * O TETO DE 5 E O QUE "APARECE SEMPRE" QUER DIZER
 *
 * `v_n_result` e `v_n_mencao` contam sobre a AMOSTRA (os 5 que cabem), não sobre
 * o conjunto todo. Então um termo com 13 casamentos no nome enche a amostra de
 * resultado e não sobra linha de menção para rotular — e o bloco não aparece.
 *
 * Isso NÃO é a "regra condicional" que o enunciado proíbe: não há `if` nenhum
 * sobre proporção, é o teto cortando pela ordem (`casou_nome desc`). Os casos
 * `curso`, `queijo` e `treinamentos` abaixo medem exatamente esse limite, para
 * ninguém no futuro ler a ausência do bloco como defeito.
 *
 * Uso: npm run teste:busca-resultado-mencao
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const MIGRACAO = leia('20260910190000_59_busca_resultado_x_mencao.sql');
const ROLLBACK = leia('20260910190000_59_busca_resultado_x_mencao_rollback.sql');
// `begin`/`commit` saem: tudo roda dentro da transação que será abortada.
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

const TETO = 5; // `c_amostra` da função

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

const url = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('begin');

const TENANT = {};
const buscar = async (slug, termo) => {
  const r = await c.query(
    `select * from public.api_n8n_buscar_produtos($1::uuid, $2::text)`, [TENANT[slug], termo]);
  return r.rows[0];
};
const aclDe = async () => (await c.query(
  `select coalesce(p.proacl::text, '(NULO)') as acl
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_n8n_buscar_produtos'`)).rows[0].acl;

// Quantas linhas de produto o texto mostra num trecho. É o TEXTO que o agente
// lê: contar só as variáveis internas deixaria passar um texto que não mostra a
// divisão que elas conhecem.
const linhasDeProduto = (txt) => txt.split('\n').filter((l) => / — R\$ /.test(l)).length;

/**
 * `nome` = casamentos no NOME sobre o conjunto todo (medido em 10/09).
 * `total` = o que a busca encontra hoje, e tem de continuar encontrando.
 * O que cada bloco mostra é DERIVADO do teto, não escrito à mão.
 */
const CASOS = [
  { slug: 'estudyou-sendbox', termo: 'NR 01', total: 3, nome: 1 },
  { slug: 'estudyou-sendbox', termo: 'NR 10', total: 4, nome: 2 },
  { slug: 'estudyou-sendbox', termo: 'primeiros socorros', total: 4, nome: 1 },
  { slug: 'estudyou-sendbox', termo: 'brigada', total: 2, nome: 1 },
  // os três que enchem a amostra de RESULTADO e por isso NÃO mostram menção
  { slug: 'estudyou-sendbox', termo: 'curso', total: 19, nome: 13 },
  { slug: 'estudyou-sendbox', termo: 'treinamentos', total: 15, nome: 5 },
  { slug: 'emporio', termo: 'queijo', total: 8, nome: 8 },
];
for (const cs of CASOS) {
  cs.mostrando = Math.min(cs.total, TETO);
  cs.expRes = Math.min(cs.nome, cs.mostrando);
  cs.expMen = cs.mostrando - cs.expRes;
}

try {
  console.log('\n== Migração 59 — a busca separa RESULTADO de MENÇÃO ==\n');

  for (const slug of ['estudyou-sendbox', 'emporio']) {
    const r = await c.query(`select id from public.tenants where slug = $1`, [slug]);
    if (!r.rows.length) throw new Error(`tenant ${slug} não existe`);
    TENANT[slug] = r.rows[0].id;
  }

  // -----------------------------------------------------------------------
  console.log('-- 1. Estado pré-migração: o defeito existe, e o total de cada termo --\n');
  await c.query(semTx(ROLLBACK));
  const aclAntes = await aclDe();

  const antes = {};
  for (const cs of CASOS) {
    const r = await buscar(cs.slug, cs.termo);
    antes[`${cs.slug}|${cs.termo}`] = r.total_encontrado;
    console.log(`     ${cs.termo.padEnd(20)} total=${r.total_encontrado}`);
  }

  // CONTRAPROVA de que há defeito: os dois cursos de NR 10 vêm na busca por
  // "NR 01" sem nada que os distinga do produto que o cliente pediu. Sem esta
  // asserção, tudo abaixo seria verdadeiro por vacuidade num banco onde a
  // migração não mudasse nada.
  {
    const r = await buscar('estudyou-sendbox', 'NR 01');
    chk('ANTES: "NR 01" traz os 3 numa lista só, e um NR 10 está nela',
      r.total_encontrado === 3 && /NR 10/.test(r.texto));
    chk('ANTES: não existe rótulo nenhum separando os dois',
      !/MENÇÃO/.test(r.texto) && !/RESULTADO/.test(r.texto));
  }

  // -----------------------------------------------------------------------
  console.log('\n-- 2. Depois: os DOIS lados de cada termo --\n');
  await c.query(semTx(MIGRACAO));

  for (const cs of CASOS) {
    const r = await buscar(cs.slug, cs.termo);
    const txt = r.texto;
    const rot = `["${cs.termo}"]`;

    chk(`${rot} total_encontrado ${cs.total} (conta os DOIS blocos)`,
      r.total_encontrado === cs.total, `${r.total_encontrado}`);
    chk(`${rot} mostrando ${cs.mostrando} — o teto vale para a SOMA`,
      r.mostrando === cs.mostrando && linhasDeProduto(txt) === cs.mostrando,
      `mostrando=${r.mostrando} linhas=${linhasDeProduto(txt)}`);

    const iRes = txt.indexOf('RESULTADO');
    const iMen = txt.indexOf('MENÇÃO');

    if (cs.expMen > 0) {
      chk(`${rot} o bloco MENÇÃO existe`, iMen > 0, 'rótulo ausente');
      chk(`${rot} RESULTADO vem ANTES de MENÇÃO`, iRes >= 0 && iRes < iMen,
        `res=${iRes} men=${iMen}`);
      const nRes = linhasDeProduto(txt.slice(iRes, iMen));
      const nMen = linhasDeProduto(txt.slice(iMen));
      chk(`${rot} ${cs.expRes} no RESULTADO e ${cs.expMen} na MENÇÃO`,
        nRes === cs.expRes && nMen === cs.expMen, `res=${nRes} men=${nMen}`);
      chk(`${rot} o rótulo diz para NÃO oferecer como o item pedido`,
        /NÃO ofereça como se fosse o item pedido/.test(txt));
      chk(`${rot} e cada bloco diz quantos são`,
        txt.includes(`(${cs.expRes}):`) && txt.includes(`MENÇÃO (${cs.expMen})`),
        txt.split('\n').filter((l) => !/ — R\$ /.test(l)).join(' / '));
    } else {
      // O teto encheu de resultado: não sobra menção para rotular. Ausência
      // esperada, medida, e não defeito — ver o cabeçalho.
      chk(`${rot} sem menção NA AMOSTRA, o bloco não aparece`, iMen < 0,
        txt.split('\n')[0]);
    }
  }

  // -----------------------------------------------------------------------
  console.log('\n-- 2b. O caso do cliente, produto a produto --\n');
  {
    const r = await buscar('estudyou-sendbox', 'NR 01');
    const iMen = r.texto.indexOf('MENÇÃO');
    const blocoRes = r.texto.slice(0, iMen);
    const blocoMen = r.texto.slice(iMen);
    chk('o Treinamento de NR 01 (R$ 69,90) está no RESULTADO',
      /Treinamento de NR 01/.test(blocoRes) && /R\$ 69,90/.test(blocoRes), blocoRes);
    chk('o Curso de NR 10 BÁSICO (R$ 199,90) está na MENÇÃO — e NÃO sumiu',
      /NR 10 BÁSICO/.test(blocoMen) && /R\$ 199,90/.test(blocoMen), blocoMen);
    chk('o Curso de Reciclagem NR 10 (R$ 149,90) está na MENÇÃO — e NÃO sumiu',
      /Reciclagem/.test(blocoMen) && /R\$ 149,90/.test(blocoMen), blocoMen);
    chk('nenhum NR 10 vazou para o bloco RESULTADO', !/NR 10/.test(blocoRes),
      blocoRes.replace(/\n/g, ' | '));
    chk('e o id continua em cada linha (o agente precisa dele para montar pedido)',
      (r.texto.match(/\(id: [0-9a-f-]{36}\)/g) || []).length === 3);
  }

  // -----------------------------------------------------------------------
  console.log('\n-- 3. Nenhum recall perdido: total idêntico ao medido ANTES --\n');
  for (const cs of CASOS) {
    const r = await buscar(cs.slug, cs.termo);
    const a = antes[`${cs.slug}|${cs.termo}`];
    chk(`["${cs.termo}"] ${a} antes, ${r.total_encontrado} depois`,
      r.total_encontrado === a, `${a} -> ${r.total_encontrado}`);
  }

  // -----------------------------------------------------------------------
  console.log('\n-- 4. O que NÃO podia mudar --\n');
  {
    const zero = await buscar('emporio', 'xyzzy-nao-existe-no-catalogo');
    chk('termo sem nada continua em 0 encontrados', zero.total_encontrado === 0,
      `${zero.total_encontrado}`);
    chk('e a camada 2 (parecidos/SUGESTÃO) continua sendo a resposta ali',
      !/MENÇÃO/.test(zero.texto) && /0 encontrados/.test(zero.texto));

    const semTermo = await buscar('emporio', '');
    chk('sem termo, `houve_busca` é falso', semTermo.houve_busca === false);
    chk('e o texto continua dizendo que é amostra sem busca', /sem busca/.test(semTermo.texto));
    chk('sem termo não existe bloco de menção', !/MENÇÃO/.test(semTermo.texto));

    const assinaturas = await c.query(
      `select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'api_n8n_buscar_produtos'`);
    chk('uma assinatura viva (a 28/32/37 nasceram de duas)',
      assinaturas.rows[0].n === 1, `${assinaturas.rows[0].n}`);

    const aclDepois = await aclDe();
    // DIFF, não lista esperada. Conferir contra a lista que eu escrevi foi
    // exatamente como a 41 passou verde sem `n8n_agent`.
    chk('o ACL ficou IDÊNTICO ao de antes', aclDepois === aclAntes,
      `${aclAntes}  ->  ${aclDepois}`);
    chk('e o n8n_agent está nele', /n8n_agent=X/.test(aclDepois), aclDepois);
    chk('anon e authenticated NÃO estão', !/\banon=X/.test(aclDepois)
      && !/\bauthenticated=X/.test(aclDepois), aclDepois);
  }

  // Ter grant e conseguir chamar são medidas diferentes — e nenhuma das duas
  // substitui a outra (ver CLAUDE.md, a nota da 54).
  {
    await c.query('savepoint sp_role');
    await c.query('set local role n8n_agent');
    const r = await c.query(
      `select total_encontrado, texto from public.api_n8n_buscar_produtos($1::uuid, 'NR 01')`,
      [TENANT['estudyou-sendbox']]);
    await c.query('rollback to savepoint sp_role');
    chk('n8n_agent CHAMA de verdade e recebe os dois blocos',
      r.rows[0].total_encontrado === 3 && /MENÇÃO/.test(r.rows[0].texto));
  }

  // Isolamento: o termo de um tenant não alcança o catálogo do outro.
  {
    const r = await buscar('emporio', 'NR 01');
    chk('o emporio não enxerga os cursos do sendbox', r.total_encontrado === 0,
      `${r.total_encontrado}`);
  }

  // -----------------------------------------------------------------------
  console.log('\n-- 5. O rollback devolve o comportamento anterior --\n');
  await c.query(semTx(ROLLBACK));
  {
    const r = await buscar('estudyou-sendbox', 'NR 01');
    chk('depois do rollback, "NR 01" volta a misturar (sem rótulo)',
      r.total_encontrado === 3 && !/MENÇÃO/.test(r.texto));
    chk('e o ACL segue intacto depois do vai-e-volta', (await aclDe()) === aclAntes);
  }
  await c.query(semTx(ROLLBACK));
  await c.query(semTx(MIGRACAO));
  await c.query(semTx(MIGRACAO));
  {
    const r = await buscar('estudyou-sendbox', 'NR 01');
    chk('migração e rollback são reexecutáveis, e o fim é o estado pós-59',
      /MENÇÃO/.test(r.texto) && r.total_encontrado === 3);
  }

  // -----------------------------------------------------------------------
  console.log('\n-- 6. SABOTAGEM --\n');
  const sabotar = (de, para, rotulo) => {
    const n = MIGRACAO.split(de).length - 1;
    if (n !== 1) {
      falhas.push(`sabotagem "${rotulo}" não localizou o alvo`);
      console.log(`  FALHA sabotagem "${rotulo}" casa ${n}x, esperava 1 — o alvo mudou de forma`);
      return null;
    }
    const mut = MIGRACAO.split(de).join(para);
    // Confirma que a MUTAÇÃO ENTROU antes de acreditar em qualquer resultado.
    if (mut === MIGRACAO) {
      falhas.push(`sabotagem "${rotulo}" não mutou`);
      console.log(`  FALHA sabotagem "${rotulo}" não mudou o texto`);
      return null;
    }
    console.log(`     [mutou "${rotulo}": ${MIGRACAO.length} -> ${mut.length} chars]`);
    return semTx(mut);
  };
  // Rejeição inesperada vira FALHA de asserção, não crash: `await` cru aqui
  // derrubaria o processo antes das sabotagens seguintes.
  const comSabotagem = async (sql, slug, termo) => {
    await c.query('savepoint sab');
    try {
      await c.query(sql);
      return await buscar(slug, termo);
    } catch (e) {
      return { erro: e.code ?? e.message, texto: '' };
    } finally {
      await c.query('rollback to savepoint sab');
    }
  };

  // S1 — TIRAR O RÓTULO. É a sabotagem que prova a tese da migração: sem o
  //      rótulo os dois blocos são a lista de hoje com uma quebra de linha no
  //      meio, e o agente volta a oferecer os três como iguais.
  {
    const s = sabotar(
      "|| 'NÃO ofereça como se fosse o item pedido; confirme com o cliente antes de usar:',",
      "|| '',",
      'rótulo da menção');
    if (s) {
      const r = await comSabotagem(s, 'estudyou-sendbox', 'NR 01');
      chk('SABOTAGEM sem o rótulo -> o texto deixa de instruir a não oferecer',
        !/NÃO ofereça como se fosse o item pedido/.test(r.texto), r.erro ?? '');
      chk('  ...e os três produtos continuam lá, indistinguíveis (é esse o defeito)',
        /NR 10/.test(r.texto) && /Treinamento de NR 01/.test(r.texto), r.erro ?? '');
    }
  }

  // S2 — CLASSIFICAR SÓ POR `ilike`, sem o FTS do nome. Medido: dos 5
  //      casamentos no nome de "treinamentos", os 5 vêm da flexão
  //      (`treinamentos` -> `Treinamento`) e nenhum do `ilike`. Sem esse ramo o
  //      RESULTADO fica VAZIO e a função diz "NENHUM item tem no nome".
  {
    const s = sabotar(
      "\n             or to_tsvector('portuguese', p.nome) @@ plainto_tsquery('portuguese', v_termo)",
      '',
      'classificação sem o FTS do nome');
    if (s) {
      const r = await comSabotagem(s, 'estudyou-sendbox', 'treinamentos');
      chk('SABOTAGEM sem FTS do nome -> "treinamentos" perde os 5 resultados',
        /RESULTADO: NENHUM item/.test(r.texto), r.erro ?? r.texto.split('\n')[0]);
      const bom = await buscar('estudyou-sendbox', 'treinamentos');
      chk('  ...e sem a sabotagem ele NÃO diz isso', !/RESULTADO: NENHUM/.test(bom.texto));
    }
  }

  // S3 — CONDICIONAR o bloco de menção a "só quando o nome traz poucos", que é
  //      exatamente a regra condicional que o enunciado proíbe.
  {
    const s = sabotar('elsif v_busca and v_n_mencao > 0 then',
      'elsif v_busca and v_n_mencao > 0 and v_n_result < 2 then',
      'menção condicional');
    if (s) {
      const r = await comSabotagem(s, 'estudyou-sendbox', 'NR 10'); // 2 result, 2 menção
      chk('SABOTAGEM menção condicional -> "NR 10" volta a esconder as 2 menções',
        !/MENÇÃO/.test(r.texto), r.erro ?? r.texto.split('\n')[0]);
      const bom = await buscar('estudyou-sendbox', 'NR 10');
      chk('  ...e sem a sabotagem as 2 menções aparecem', /MENÇÃO \(2\)/.test(bom.texto));
    }
  }

  // S4 — ORDENAR sem `casou_nome desc`: o teto passa a cortar por nome, e a
  //      regra "se cortar, corta a menção" — que não é código, é a ordem —
  //      deixa de valer.
  {
    const s = sabotar('row_number() over (order by f.casou_nome desc, f.nome) as pos',
      'row_number() over (order by f.nome) as pos',
      'ordem sem casou_nome');
    if (s) {
      const r = await comSabotagem(s, 'estudyou-sendbox', 'curso');
      chk('SABOTAGEM ordem sem casou_nome -> menção entra na amostra de "curso"',
        /MENÇÃO/.test(r.texto), r.erro ?? r.texto.split('\n')[0]);
      const bom = await buscar('estudyou-sendbox', 'curso');
      chk('  ...e sem a sabotagem "curso" mostra 5 resultados e nenhuma menção',
        !/MENÇÃO/.test(bom.texto));
    }
  }
} catch (err) {
  falhas.push('exceção');
  console.log(`\n  EXCEÇÃO: ${err.code ?? ''} ${err.message}`);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${'-'.repeat(62)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
