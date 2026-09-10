#!/usr/bin/env node
/**
 * A busca do catálogo: RESULTADO x MENÇÃO — a CADEIA 59 -> 60, em TRANSAÇÃO
 * ABORTADA contra produção. Nada é gravado.
 *
 * COMEÇA PELOS ROLLBACKS, NA ORDEM INVERSA (60, depois 59): põe o banco no
 * estado pré-59 tendo qualquer uma das duas sido aplicada ou não. Este arquivo
 * não afirma o calendário.
 *
 * ---------------------------------------------------------------------------
 * POR QUE UM ARQUIVO SÓ, E NÃO UM POR MIGRAÇÃO
 *
 * A 59 fez "NR 01" mostrar bloco de MENÇÃO; a 60 fez "NR 01" NÃO mostrar. Dois
 * arquivos verdes, um afirmando cada coisa, é uma armadilha para quem for
 * procurar depois. Aqui a cadeia inteira está num lugar só, na ordem em que
 * produção a viu, e cada asserção diz de qual degrau ela fala.
 *
 * ---------------------------------------------------------------------------
 * O QUE A 60 CONSERTA
 *
 * A 59 funcionou: o agente ENTENDEU a separação. Só que repassou a ESTRUTURA ao
 * cliente — "tem menção à NR 01 na descrição" — e terminou oferecendo NR 10 a
 * quem pediu NR 01. O modelo recita o que a ferramenta devolve.
 *
 * A 60 não instrui: ela deixa de MONTAR o bloco de menção quando há resultado.
 * O agente não pode citar o que não recebeu.
 *
 * ---------------------------------------------------------------------------
 * O RISCO QUE A CONDIÇÃO CRIA, E POR QUE OS DOIS SENTIDOS SÃO OBRIGATÓRIOS
 *
 * Se `casou_nome` quebrar e devolver falso para tudo, o RESULTADO fica vazio, a
 * MENÇÃO vira a resposta inteira e o texto continua bem formado — ninguém vê.
 *
 *   sentido 1: HAVENDO resultado, MENÇÃO não aparece **e** o resultado aparece
 *   sentido 2: NÃO havendo, MENÇÃO aparece, com o rótulo íntegro
 *
 * Só (1) passa numa implementação que apagou o bloco de menção do código.
 * Só (2) passa numa que nunca classifica nada como nome.
 *
 * As sabotagens S5 e S6 **provam** isso em vez de afirmá-lo: cada uma quebra um
 * dos sentidos e deixa o OUTRO verde, e o teste exige as duas coisas.
 *
 * ---------------------------------------------------------------------------
 * OS TERMOS SÃO REAIS, INCLUSIVE OS SÓ-MENÇÃO. Varrendo as palavras das
 * descrições dos dois tenants em 10/09: 685 termos só-menção no
 * `estudyou-sendbox` e 3 no `emporio`. Os dois usados aqui são perguntas
 * plausíveis de cliente — `certificado` e `torra` —, não caso construído.
 *
 * Uso: npm run teste:busca-resultado-mencao
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const leia = (n) => fs.readFileSync(path.join(DIR, n), 'utf8').replace(/\r\n/g, '\n');
const M59 = leia('20260910190000_59_busca_resultado_x_mencao.sql');
const R59 = leia('20260910190000_59_busca_resultado_x_mencao_rollback.sql');
const M60 = leia('20260910213000_60_mencao_so_sem_resultado.sql');
const R60 = leia('20260910213000_60_mencao_so_sem_resultado_rollback.sql');
// `begin`/`commit` saem: tudo roda dentro da transação que será abortada.
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 12);

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
const buscar = async (slug, termo) => (await c.query(
  `select * from public.api_n8n_buscar_produtos($1::uuid, $2::text)`,
  [TENANT[slug], termo])).rows[0];
const aclDe = async () => (await c.query(
  `select coalesce(p.proacl::text, '(NULO)') as acl
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_n8n_buscar_produtos'`)).rows[0].acl;

// Quantas linhas de produto o texto lista. É o TEXTO que o agente lê: contar as
// variáveis internas deixaria passar um texto que não mostra o que elas sabem.
const nLinhas = (txt) => txt.split('\n').filter((l) => / — R\$ /.test(l)).length;

const ROTULO = 'NÃO ofereça como se fosse o item pedido';

/**
 * `total` nunca muda em nenhum degrau — o filtro é idêntico nas duas migrações.
 * `mostra59` / `mostra60` são as linhas que cada degrau lista.
 * `tipo` é o que a 60 produz: 'resultado' (bloco único) ou 'mencao'.
 */
const CASOS = [
  // há resultado -> depois da 60, MENÇÃO some
  { slug: 'estudyou-sendbox', termo: 'NR 01',              total: 3,  mostra59: 3, mostra60: 1, tipo: 'resultado' },
  { slug: 'estudyou-sendbox', termo: 'NR 10',              total: 4,  mostra59: 4, mostra60: 2, tipo: 'resultado' },
  { slug: 'estudyou-sendbox', termo: 'primeiros socorros', total: 4,  mostra59: 4, mostra60: 1, tipo: 'resultado' },
  // o teto já era preenchido por resultado: a 60 não muda nada aqui
  { slug: 'estudyou-sendbox', termo: 'curso',              total: 19, mostra59: 5, mostra60: 5, tipo: 'resultado' },
  { slug: 'estudyou-sendbox', termo: 'treinamentos',       total: 15, mostra59: 5, mostra60: 5, tipo: 'resultado' },
  { slug: 'emporio',          termo: 'queijo',             total: 8,  mostra59: 5, mostra60: 5, tipo: 'resultado' },
  // NENHUM nome casa: a menção é a única informação, e continua saindo
  { slug: 'estudyou-sendbox', termo: 'certificado',        total: 10, mostra59: 5, mostra60: 5, tipo: 'mencao' },
  { slug: 'emporio',          termo: 'torra',              total: 1,  mostra59: 1, mostra60: 1, tipo: 'mencao' },
];

try {
  console.log('\n== A busca do catálogo: a cadeia 59 -> 60 ==\n');

  for (const slug of ['estudyou-sendbox', 'emporio']) {
    const r = await c.query(`select id from public.tenants where slug = $1`, [slug]);
    if (!r.rows.length) throw new Error(`tenant ${slug} não existe`);
    TENANT[slug] = r.rows[0].id;
  }

  // =======================================================================
  console.log('-- 0. Pré-59 (rollbacks na ORDEM INVERSA) --\n');
  await c.query(semTx(R60));
  await c.query(semTx(R59));
  const aclAntes = await aclDe();

  const totalPre = {};
  for (const cs of CASOS) {
    const r = await buscar(cs.slug, cs.termo);
    totalPre[`${cs.slug}|${cs.termo}`] = r.total_encontrado;
    console.log(`     ${cs.termo.padEnd(20)} total=${r.total_encontrado}`);
  }

  // CONTRAPROVA de que havia defeito. Sem ela, tudo abaixo seria verdadeiro por
  // vacuidade num banco em que nenhuma das duas migrações mudasse nada.
  {
    const r = await buscar('estudyou-sendbox', 'NR 01');
    chk('PRÉ-59: "NR 01" traz os 3 numa lista só, com um NR 10 dentro',
      r.total_encontrado === 3 && /NR 10/.test(r.texto));
    chk('PRÉ-59: nenhum rótulo separa os dois',
      !/MENÇÃO/.test(r.texto) && !/RESULTADO/.test(r.texto));
  }

  // =======================================================================
  console.log('\n-- 1. Degrau 59: a distinção passa a ser DITA (dois blocos) --\n');
  await c.query(semTx(M59));
  {
    const r = await buscar('estudyou-sendbox', 'NR 01');
    const iMen = r.texto.indexOf('MENÇÃO');
    chk('59: "NR 01" ganha os dois blocos, RESULTADO antes de MENÇÃO',
      iMen > 0 && r.texto.indexOf('RESULTADO') >= 0 && r.texto.indexOf('RESULTADO') < iMen);
    chk('59: o Treinamento de NR 01 (R$ 69,90) fica no RESULTADO',
      /Treinamento de NR 01/.test(r.texto.slice(0, iMen))
      && /R\$ 69,90/.test(r.texto.slice(0, iMen)));
    chk('59: os dois cursos de NR 10 ficam na MENÇÃO',
      /R\$ 199,90/.test(r.texto.slice(iMen)) && /R\$ 149,90/.test(r.texto.slice(iMen)));
    // ...E É ISTO QUE A 60 CONSERTA: o agente recebeu os NR 10 e os ofereceu.
    chk('59: e o agente RECEBE os NR 10 — a causa da mensagem que motivou a 60',
      /R\$ 199,90/.test(r.texto) && nLinhas(r.texto) === 3);
  }
  for (const cs of CASOS) {
    const r = await buscar(cs.slug, cs.termo);
    chk(`59: ["${cs.termo}"] lista ${cs.mostra59} linha(s)`,
      r.mostrando === cs.mostra59 && nLinhas(r.texto) === cs.mostra59,
      `mostrando=${r.mostrando} linhas=${nLinhas(r.texto)}`);
  }

  // =======================================================================
  console.log('\n-- 2. Degrau 60, SENTIDO 1: havendo resultado, a MENÇÃO não sai --\n');
  await c.query(semTx(M60));

  for (const cs of CASOS.filter((x) => x.tipo === 'resultado')) {
    const r = await buscar(cs.slug, cs.termo);
    const rot = `["${cs.termo}"]`;

    // as DUAS metades do sentido 1. A primeira sozinha passaria numa
    // implementação que apagou o bloco de menção do código; a segunda sozinha
    // passaria numa que nunca classifica nada como nome.
    chk(`${rot} a MENÇÃO NÃO aparece`, !/MENÇÃO/.test(r.texto), r.texto.split('\n')[0]);
    chk(`${rot} e o RESULTADO aparece: ${cs.mostra60} linha(s)`,
      nLinhas(r.texto) === cs.mostra60, `${nLinhas(r.texto)}`);

    chk(`${rot} nenhum rótulo de estrutura sobrou no texto`,
      !/RESULTADO/.test(r.texto) && !new RegExp(ROTULO).test(r.texto),
      r.texto.split('\n')[0]);
    chk(`${rot} \`mostrando\` = as linhas que o texto lista (${cs.mostra60})`,
      r.mostrando === cs.mostra60, `${r.mostrando}`);
    chk(`${rot} \`total_encontrado\` continua contando os DOIS: ${cs.total}`,
      r.total_encontrado === cs.total, `${r.total_encontrado}`);
    if (cs.total > cs.mostra60) {
      chk(`${rot} e o texto DIZ que escondeu: "${cs.total} encontrados, mostrando ${cs.mostra60}"`,
        r.texto.startsWith(`Busca "${cs.termo}": ${cs.total} encontrados, mostrando ${cs.mostra60}:`),
        r.texto.split('\n')[0]);
    }
  }

  // O caso do cliente, nominal: é a mensagem real que motivou a migração.
  {
    const r = await buscar('estudyou-sendbox', 'NR 01');
    chk('o cliente que pediu NR 01 recebe o Treinamento de NR 01 (R$ 69,90)',
      /Treinamento de NR 01/.test(r.texto) && /R\$ 69,90/.test(r.texto));
    chk('e NENHUM curso de NR 10 chega ao agente — nem para ele citar',
      !/NR 10/.test(r.texto) && !/199,90/.test(r.texto) && !/149,90/.test(r.texto),
      r.texto.replace(/\n/g, ' | '));
    chk('nem a palavra "descrição", que foi o vocabulário vazado',
      !/descri/i.test(r.texto));
  }

  // =======================================================================
  console.log('\n-- 3. Degrau 60, SENTIDO 2: sem resultado, a MENÇÃO sai íntegra --\n');
  for (const cs of CASOS.filter((x) => x.tipo === 'mencao')) {
    const r = await buscar(cs.slug, cs.termo);
    const rot = `["${cs.termo}"]`;

    chk(`${rot} a MENÇÃO aparece`, /MENÇÃO/.test(r.texto), r.texto.split('\n')[0]);
    chk(`${rot} com o rótulo ÍNTEGRO`, new RegExp(ROTULO).test(r.texto));
    chk(`${rot} e diz que nenhum nome casou`,
      r.texto.includes(`RESULTADO: NENHUM item tem "${cs.termo}" no nome.`),
      r.texto.split('\n')[1]);
    chk(`${rot} lista ${cs.mostra60} item(ns), e \`mostrando\` concorda`,
      nLinhas(r.texto) === cs.mostra60 && r.mostrando === cs.mostra60,
      `linhas=${nLinhas(r.texto)} mostrando=${r.mostrando}`);
    chk(`${rot} \`total_encontrado\` ${cs.total}`, r.total_encontrado === cs.total,
      `${r.total_encontrado}`);
    chk(`${rot} o rótulo conta os mesmos que lista`,
      r.texto.includes(`MENÇÃO (${cs.mostra60})`), r.texto.split('\n')[2]);
  }
  {
    // nominal, no tenant pequeno: o único achado de "torra" é o café, e ele vem
    // rotulado — não como se fosse "o café torra escura" que o cliente pediu.
    const r = await buscar('emporio', 'torra');
    chk('"torra" no emporio devolve o Café Cujubi Coffe rotulado como menção',
      /Café Cujubi/.test(r.texto) && /MENÇÃO \(1\)/.test(r.texto));
  }

  // =======================================================================
  console.log('\n-- 4. Nenhum recall perdido em NENHUM degrau --\n');
  for (const cs of CASOS) {
    const r = await buscar(cs.slug, cs.termo);
    const a = totalPre[`${cs.slug}|${cs.termo}`];
    chk(`["${cs.termo}"] ${a} pré-59, ${r.total_encontrado} pós-60`,
      r.total_encontrado === a && a === cs.total, `${a} -> ${r.total_encontrado}`);
  }

  // =======================================================================
  console.log('\n-- 5. O que não podia mudar --\n');
  {
    const zero = await buscar('emporio', 'xyzzy-nao-existe-no-catalogo');
    chk('termo sem nada continua em 0 encontrados', zero.total_encontrado === 0,
      `${zero.total_encontrado}`);
    chk('e a camada 2 (parecidos/SUGESTÃO) continua sendo a resposta ali',
      !/MENÇÃO/.test(zero.texto) && /0 encontrados/.test(zero.texto));

    const semTermo = await buscar('emporio', '');
    chk('sem termo, `houve_busca` é falso', semTermo.houve_busca === false);
    chk('e continua dizendo que é amostra sem busca', /sem busca/.test(semTermo.texto));
    chk('sem termo, `mostrando` = as linhas listadas',
      semTermo.mostrando === nLinhas(semTermo.texto),
      `${semTermo.mostrando} vs ${nLinhas(semTermo.texto)}`);

    const n = (await c.query(
      `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and p.proname = 'api_n8n_buscar_produtos'`)).rows[0].n;
    chk('uma assinatura viva (a 28/32/37 nasceram de duas)', n === 1, `${n}`);

    const aclDepois = await aclDe();
    // DIFF, não lista esperada: foi conferindo contra a própria lista que a 41
    // passou verde sem `n8n_agent`.
    chk('o ACL ficou IDÊNTICO ao pré-59', aclDepois === aclAntes,
      `${aclAntes}  ->  ${aclDepois}`);
    chk('e o n8n_agent está nele', /n8n_agent=X/.test(aclDepois), aclDepois);
    chk('anon e authenticated NÃO estão',
      !/\banon=X/.test(aclDepois) && !/\bauthenticated=X/.test(aclDepois), aclDepois);
  }
  {
    // Ter grant e conseguir chamar são medidas diferentes, e nenhuma substitui
    // a outra (CLAUDE.md, a nota da 54).
    await c.query('savepoint sp_role');
    await c.query('set local role n8n_agent');
    const r = (await c.query(
      `select total_encontrado, texto from public.api_n8n_buscar_produtos($1::uuid, 'NR 01')`,
      [TENANT['estudyou-sendbox']])).rows[0];
    await c.query('rollback to savepoint sp_role');
    chk('n8n_agent CHAMA de verdade e recebe o texto da 60',
      r.total_encontrado === 3 && !/MENÇÃO/.test(r.texto));
  }
  {
    const r = await buscar('emporio', 'NR 01');
    chk('o emporio não enxerga os cursos do sendbox', r.total_encontrado === 0,
      `${r.total_encontrado}`);
  }

  // =======================================================================
  console.log('\n-- 6. Rollbacks, na ordem inversa --\n');
  await c.query(semTx(R60));
  {
    const r = await buscar('estudyou-sendbox', 'NR 01');
    chk('rollback da 60 -> volta ao mundo da 59 (dois blocos), NÃO ao pré-59',
      /MENÇÃO/.test(r.texto) && nLinhas(r.texto) === 3);
  }
  await c.query(semTx(R59));
  {
    const r = await buscar('estudyou-sendbox', 'NR 01');
    chk('rollback da 59 -> volta ao pré-59 (lista sem rótulo)',
      !/MENÇÃO/.test(r.texto) && !/RESULTADO/.test(r.texto) && r.total_encontrado === 3);
    chk('e o ACL segue intacto depois de todo o vai-e-volta', (await aclDe()) === aclAntes);
  }
  await c.query(semTx(M59));
  await c.query(semTx(M60));
  await c.query(semTx(M60));
  {
    const r = await buscar('estudyou-sendbox', 'NR 01');
    chk('a cadeia é reexecutável e termina no estado pós-60',
      !/MENÇÃO/.test(r.texto) && r.mostrando === 1 && r.total_encontrado === 3);
  }

  // =======================================================================
  console.log('\n-- 7. SABOTAGEM --\n');
  // Aqui o banco está no estado pós-60. Cada sabotagem volta ao 59 e aplica uma
  // 60 mutada por cima, dentro de savepoint.
  const sabotar = (de, para, rotulo) => {
    const n = M60.split(de).length - 1;
    if (n !== 1) {
      falhas.push(`sabotagem "${rotulo}" não localizou o alvo`);
      console.log(`  FALHA sabotagem "${rotulo}" casa ${n}x, esperava 1 — o alvo mudou de forma`);
      return null;
    }
    const mut = M60.split(de).join(para);
    // Confirma que a MUTAÇÃO ENTROU antes de acreditar em qualquer resultado.
    if (mut === M60) {
      falhas.push(`sabotagem "${rotulo}" não mutou`);
      console.log(`  FALHA sabotagem "${rotulo}" não mudou o texto`);
      return null;
    }
    // md5, não tamanho: a S7 troca 37 caracteres por outros 37 e o comprimento
    // fica idêntico. Imprimir só o tamanho pareceria "a mutação não entrou"
    // exatamente no caso em que ela entrou.
    console.log(`     [mutou "${rotulo}": md5 ${md5(M60)} -> ${md5(mut)}]`);
    return semTx(mut);
  };
  // Rejeição inesperada vira FALHA de asserção, não crash: `await` cru derrubaria
  // o processo antes das sabotagens seguintes.
  const sob = async (sql, alvos) => {
    await c.query('savepoint sab');
    try {
      await c.query(semTx(R60));
      await c.query(sql);
      const out = {};
      for (const [slug, termo] of alvos) out[termo] = await buscar(slug, termo);
      return out;
    } catch (e) {
      return { erro: e.code ?? e.message };
    } finally {
      await c.query('rollback to savepoint sab');
    }
  };
  const ALVOS = [['estudyou-sendbox', 'NR 01'], ['estudyou-sendbox', 'certificado']];

  // ---------------------------------------------------------------------
  // S5 e S6 SÃO O PAR. Elas não medem a migração: medem O TESTE. Cada uma
  // quebra um sentido e deixa o outro verde, que é exatamente o motivo pelo
  // qual afirmar um só não bastaria.
  // ---------------------------------------------------------------------
  const CASOU = "             extensions.unaccent(p.nome) ilike '%' || extensions.unaccent(v_termo) || '%'\n"
    + "             or to_tsvector('portuguese', p.nome) @@ plainto_tsquery('portuguese', v_termo)\n"
    + '           ) as casou_nome';

  {
    // S5 — `casou_nome` FALSO para tudo. É o modo de falha silencioso que a
    //      condição nova introduz: o RESULTADO fica vazio e a MENÇÃO vira a
    //      resposta inteira, com o texto bem formado.
    const s = sabotar(CASOU, '             false\n           ) as casou_nome',
      'casou_nome falso para tudo');
    if (s) {
      const r = await sob(s, ALVOS);
      chk('S5 QUEBRA o sentido 1: "NR 01" volta a entregar os NR 10, agora como menção',
        !r.erro && /MENÇÃO/.test(r['NR 01'].texto) && /R\$ 199,90/.test(r['NR 01'].texto),
        r.erro ?? r['NR 01'].texto.split('\n')[0]);
      chk('S5 e o sentido 2 fica VERDE nela — sozinho ele não pegaria isto',
        !r.erro && /MENÇÃO/.test(r['certificado'].texto)
        && new RegExp(ROTULO).test(r['certificado'].texto), r.erro ?? '');
    }
  }
  {
    // S6 — o espelho: `casou_nome` VERDADEIRO para tudo. Nada é menção nunca, e
    //      o bloco de menção deixa de existir na prática.
    const s = sabotar(CASOU, '             true\n           ) as casou_nome',
      'casou_nome verdadeiro para tudo');
    if (s) {
      const r = await sob(s, ALVOS);
      chk('S6 QUEBRA o sentido 2: "certificado" perde a MENÇÃO e vira lista crua',
        !r.erro && !/MENÇÃO/.test(r['certificado'].texto),
        r.erro ?? r['certificado'].texto.split('\n')[0]);
      chk('S6 e o sentido 1 fica VERDE nela — sozinho ele não pegaria isto',
        !r.erro && !/MENÇÃO/.test(r['NR 01'].texto), r.erro ?? '');
    }
  }

  {
    // S7 — desfazer a condição da 60 (voltar à da 59).
    const s = sabotar('elsif v_busca and v_n_result = 0 then',
      'elsif v_busca and v_n_mencao > 0 then', 'condição da 60 desfeita');
    if (s) {
      const r = await sob(s, ALVOS);
      chk('S7 condição desfeita -> "NR 01" volta a receber os cursos de NR 10',
        !r.erro && /MENÇÃO/.test(r['NR 01'].texto), r.erro ?? r['NR 01'].texto.split('\n')[0]);
    }
  }
  {
    // S8 — `mostrando` mente: fica com a contagem da amostra em vez das linhas
    //      que o texto lista. Nada no texto muda, só o número.
    const s = sabotar('    v_mostrando := v_n_result;', '    v_mostrando := v_mostrando + 0;',
      '`mostrando` volta a ser o teto');
    if (s) {
      const r = await sob(s, ALVOS);
      chk('S8 `mostrando` mente -> 3 contra 1 linha listada em "NR 01"',
        !r.erro && r['NR 01'].mostrando === 3 && nLinhas(r['NR 01'].texto) === 1,
        r.erro ?? `mostrando=${r['NR 01']?.mostrando}`);
    }
  }
  {
    // S9 — tirar o rótulo do bloco que sobrou. Sem ele, o único caso em que a
    //      menção sai vira uma lista de produtos que o agente vai oferecer.
    const s = sabotar(
      `|| '${ROTULO}; confirme com o cliente antes de usar:',`, "|| '',", 'rótulo da menção');
    if (s) {
      const r = await sob(s, ALVOS);
      chk('S9 sem o rótulo -> "certificado" entrega 5 produtos sem ressalva',
        !r.erro && !new RegExp(ROTULO).test(r['certificado'].texto)
        && nLinhas(r['certificado'].texto) === 5, r.erro ?? '');
    }
  }
  {
    // S10 — classificar só por `ilike`, sem o FTS do nome. Os 5 casamentos de
    //       "treinamentos" vêm todos da flexão; sem ela, ele cai no ramo de
    //       menção — que é o sentido 1 quebrando por outra porta.
    const s = sabotar(
      "\n             or to_tsvector('portuguese', p.nome) @@ plainto_tsquery('portuguese', v_termo)",
      '', 'classificação sem o FTS do nome');
    if (s) {
      const r = await sob(s, [['estudyou-sendbox', 'treinamentos']]);
      chk('S10 sem FTS do nome -> "treinamentos" vira menção inteira',
        !r.erro && /RESULTADO: NENHUM item/.test(r['treinamentos'].texto),
        r.erro ?? r['treinamentos'].texto.split('\n')[0]);
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
