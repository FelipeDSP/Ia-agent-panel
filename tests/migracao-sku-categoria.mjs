#!/usr/bin/env node
/**
 * Migração 57 (sku gerado + categoria por tenant) em TRANSAÇÃO ABORTADA contra
 * produção. Nada é gravado: o rollback do fim é incondicional.
 *
 * COMEÇA RODANDO O PRÓPRIO ROLLBACK DA MIGRAÇÃO, que é o que impede este arquivo
 * de afirmar o calendário: ele põe o banco no estado pré-migração tendo ela sido
 * aplicada ou não, e continua valendo depois do apply.
 *
 * OS TRÊS CASOS QUE O ENUNCIADO MARCOU COMO VALENDO MAIS, e onde eles estão:
 *
 *   1. "todo produto tem sku" passa mesmo se todos tiverem o MESMO sku.
 *      → seção 3 confere UNICIDADE e o VALOR, produto a produto, contra o
 *        prefixo que estava no nome. Não há nenhuma asserção de contagem
 *        sozinha.
 *   2. unicidade que ignora deletados aprova reuso.
 *      → seção 5 apaga um produto, cria outro, e exige que o novo NÃO receba o
 *        número do apagado.
 *   3. fonte muda, derivado não acompanha, verificação olha um lado só.
 *      → seção 6: a regex do prefixo e a de token vivem em UM lugar (a
 *        migração), e o teste as LÊ DE LÁ em vez de repetir. Uma cópia aqui
 *        divergiria em silêncio, que é a família que mordeu três vezes esta
 *        semana.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'supabase', 'migrations');
const F_MIG = path.join(DIR, '20260910140000_57_sku_e_categoria.sql');
const F_RBK = path.join(DIR, '20260910140000_57_sku_e_categoria_rollback.sql');

const MIGRACAO = fs.readFileSync(F_MIG, 'utf8');
const ROLLBACK = fs.readFileSync(F_RBK, 'utf8');
// begin/commit próprios atrapalham dentro da transação do teste
const semTx = (s) => s.replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

const url = fs.readFileSync(path.join(RAIZ, '.env.local'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DB_URL='))
  .slice('SUPABASE_DB_URL='.length).replace(/^["']|["']$/g, '');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

// ---------------------------------------------------------------------------
// AS REGEX SAEM DA MIGRAÇÃO, NÃO DE UMA CÓPIA AQUI
// ---------------------------------------------------------------------------
// Terceiro caso do enunciado. Se eu escrevesse `^[0-9]+[ ]*-[ ]*` neste arquivo,
// mudar a migração deixaria o teste medindo a regra antiga e passando.
function regexDaMigracao(rotulo, re) {
  const m = MIGRACAO.match(re);
  if (!m) {
    console.log(`  FALHA nao achei a regex de ${rotulo} na migracao — o teste mediria uma copia`);
    process.exit(1);
  }
  return m[1];
}
const RE_PREFIXO = regexDaMigracao('prefixo', /regexp_replace\(p\.nome, '(\^\[0-9\]\+\[ \]\*-\[ \]\*)'/);
const RE_TOKEN = regexDaMigracao('token', /regexp_match\(p\.nome, '(\[\[:alnum:\]\]\[\[:alnum:\]\]\*)'\)/);

await c.connect();
await c.query('begin');

try {
  console.log('\n== Migração 57 — sku gerado e categoria por tenant ==\n');
  console.log(`  (regex lidas da migração: prefixo ${RE_PREFIXO} | token ${RE_TOKEN})`);

  // -----------------------------------------------------------------------
  console.log('\n-- 1. Estado pré-migração, seja ela aplicada ou não --\n');
  await c.query(semTx(ROLLBACK));
  const pre = await c.query(
    `select count(*)::int n from information_schema.columns
      where table_schema='public' and table_name='produtos' and column_name='categoria_id'`);
  chk('depois do rollback a coluna categoria_id NÃO existe', pre.rows[0].n === 0);
  const preTab = await c.query(`select to_regclass('public.categorias') is null as sumiu`);
  chk('depois do rollback a tabela categorias NÃO existe', preTab.rows[0].sumiu === true);

  // o retrato de ANTES é o que a seção 3 compara, produto a produto
  const antes = await c.query(
    `select p.id, t.slug, p.nome, p.sku,
            case when p.nome ~ '${RE_PREFIXO}' then (regexp_match(p.nome, '^([0-9]+)'))[1] end as prefixo
       from public.produtos p join public.tenants t on t.id = p.tenant_id
      where p.deletado_em is null order by t.slug, p.criado_em`);
  const porTenantAntes = {};
  for (const r of antes.rows) (porTenantAntes[r.slug] ??= []).push(r);
  console.log('  retrato de antes:');
  for (const [slug, v] of Object.entries(porTenantAntes)) {
    console.log(`    ${slug.padEnd(20)} ${v.length} vivos, ` +
      `${v.filter((x) => x.prefixo).length} com prefixo, ${v.filter((x) => x.sku).length} com sku`);
  }
  chk('há produto com prefixo para medir (senão a seção 3 seria vácua)',
    antes.rows.filter((x) => x.prefixo).length >= 60,
    `${antes.rows.filter((x) => x.prefixo).length}`);

  // -----------------------------------------------------------------------
  console.log('\n-- 2. A migração aplica --\n');
  await c.query(semTx(MIGRACAO));
  chk('a migração aplica', true);

  const depoisIdx = await c.query(
    `select indexdef from pg_indexes where schemaname='public' and indexname='uq_produtos_tenant_sku'`);
  chk('o índice único NÃO filtra mais por deletado_em',
    !/deletado_em/i.test(depoisIdx.rows[0]?.indexdef ?? ''), depoisIdx.rows[0]?.indexdef);

  // -----------------------------------------------------------------------
  console.log('\n-- 3. O sku, produto a produto (valor E unicidade) --\n');
  const depois = await c.query(
    `select p.id, t.slug, p.nome, p.sku
       from public.produtos p join public.tenants t on t.id = p.tenant_id
      where p.deletado_em is null`);
  const mapa = new Map(depois.rows.map((r) => [r.id, r]));

  // 3a. VALOR: quem tinha prefixo manteve EXATAMENTE aquele número
  const comPrefixo = antes.rows.filter((x) => x.prefixo);
  const errados = comPrefixo.filter((a) => mapa.get(a.id)?.sku !== a.prefixo);
  chk(`os ${comPrefixo.length} produtos com prefixo mantiveram o número que tinham no nome`,
    errados.length === 0,
    errados.slice(0, 3).map((e) => `${e.nome} -> sku ${mapa.get(e.id)?.sku}`).join(' ; '));

  // e o nome perdeu o prefixo
  const naoLimpos = comPrefixo.filter((a) => new RegExp(`^${a.prefixo}[ ]*-`).test(mapa.get(a.id)?.nome ?? ''));
  chk('e o nome deles perdeu o prefixo', naoLimpos.length === 0,
    naoLimpos.slice(0, 3).map((e) => mapa.get(e.id)?.nome).join(' ; '));

  // 3b. sku de TEXTO preexistente não foi tocado
  const textoAntes = antes.rows.filter((x) => x.sku && !/^[0-9]+$/.test(x.sku));
  chk('há sku de texto legado para medir', textoAntes.length === 3, `${textoAntes.length}`);
  const textoMudou = textoAntes.filter((a) => mapa.get(a.id)?.sku !== a.sku);
  chk('sku de texto legado NÃO foi sobrescrito', textoMudou.length === 0,
    textoMudou.map((e) => `${e.sku} -> ${mapa.get(e.id)?.sku}`).join(' ; '));

  // 3c. TODO produto vivo tem sku, e ele é ÚNICO por tenant
  const semSku = depois.rows.filter((r) => !r.sku || !String(r.sku).trim());
  chk('todo produto vivo tem sku', semSku.length === 0, `${semSku.length} sem`);

  let duplicados = 0;
  for (const slug of Object.keys(porTenantAntes)) {
    const skus = depois.rows.filter((r) => r.slug === slug).map((r) => r.sku);
    const unicos = new Set(skus);
    if (unicos.size !== skus.length) duplicados++;
    chk(`[${slug}] os ${skus.length} sku são distintos entre si`, unicos.size === skus.length,
      `${skus.length} produtos, ${unicos.size} sku distintos`);
  }
  // a contraprova do caso 1 do enunciado: se todos tivessem o MESMO sku, a
  // asserção acima falharia. Confirmado abaixo pela sabotagem S1.
  chk('nenhum tenant com sku repetido', duplicados === 0);

  // -----------------------------------------------------------------------
  console.log('\n-- 4. Categoria: uma por produto, isolada por tenant --\n');
  const cats = await c.query(
    `select t.slug, c.nome, count(p.id)::int as produtos
       from public.categorias c
       join public.tenants t on t.id = c.tenant_id
       left join public.produtos p on p.categoria_id = c.id and p.deletado_em is null
      group by 1,2 order by 1, 3 desc, 2`);
  const porTenantCat = {};
  for (const r of cats.rows) (porTenantCat[r.slug] ??= []).push(r);
  for (const [slug, v] of Object.entries(porTenantCat)) {
    console.log(`    ${slug.padEnd(20)} ${v.length} categorias: ` +
      v.slice(0, 6).map((x) => `${x.nome} ${x.produtos}`).join(', ') + (v.length > 6 ? ' …' : ''));
  }
  chk('emporio ficou com 13 categorias', (porTenantCat['emporio'] ?? []).length === 13,
    `${(porTenantCat['emporio'] ?? []).length}`);
  chk('sendbox ficou com 7 categorias', (porTenantCat['estudyou-sendbox'] ?? []).length === 7,
    `${(porTenantCat['estudyou-sendbox'] ?? []).length}`);

  const semCat = await c.query(
    `select count(*)::int n from public.produtos where deletado_em is null and categoria_id is null`);
  chk('todo produto vivo ficou com categoria', semCat.rows[0].n === 0, `${semCat.rows[0].n} sem`);

  // "CURSO" e "Curso" viraram UMA categoria — o que a lista por tenant existe para impedir
  const curso = await c.query(
    `select c.nome, count(p.id)::int n from public.categorias c
       join public.tenants t on t.id=c.tenant_id
       left join public.produtos p on p.categoria_id=c.id and p.deletado_em is null
      where t.slug='estudyou-sendbox' and lower(c.nome)='curso' group by 1`);
  chk('"CURSO" e "Curso" caíram numa categoria só', curso.rows.length === 1, `${curso.rows.length}`);
  chk('e ela ficou com os 13 produtos', curso.rows[0]?.n === 13, `${curso.rows[0]?.n}`);

  // os dois nomes sujos: sku certo, categoria Polpa, nome NÃO consertado
  const sujos = await c.query(
    `select p.nome, p.sku, c.nome as categoria
       from public.produtos p join public.tenants t on t.id=p.tenant_id
       left join public.categorias c on c.id=p.categoria_id
      where t.slug='emporio' and p.nome like '- Polpa%' order by p.sku`);
  console.log('    casos reportados (nome NÃO consertado, de propósito):');
  sujos.rows.forEach((r) => console.log(`      sku ${r.sku}  categoria ${r.categoria}  nome ${JSON.stringify(r.nome)}`));
  chk('os dois nomes com hífen sobrando mantiveram o número do prefixo',
    sujos.rows.length === 2 && sujos.rows.map((r) => r.sku).join(',') === '29,32',
    sujos.rows.map((r) => r.sku).join(','));
  chk('e caíram em Polpa, não numa categoria "-"',
    sujos.rows.every((r) => r.categoria === 'Polpa'),
    sujos.rows.map((r) => r.categoria).join(','));

  const morango = await c.query(
    `select p.sku, p.nome from public.produtos p join public.tenants t on t.id=p.tenant_id
      where t.slug='emporio' and p.nome='Polpa de Morango' order by p.sku`);
  chk('os dois "Polpa de Morango" continuam existindo, com sku distintos',
    morango.rows.length === 2 && morango.rows[0].sku !== morango.rows[1].sku,
    morango.rows.map((r) => r.sku).join(','));

  // ISOLAMENTO: categoria de um tenant não é usável por outro (FK composta)
  const t2 = await c.query(`select id from public.tenants where slug='emporio'`);
  const t3 = await c.query(`select id from public.tenants where slug='estudyou-sendbox'`);
  const catEmporio = await c.query(
    `select id from public.categorias where tenant_id=$1 limit 1`, [t2.rows[0].id]);
  await c.query('savepoint sp_iso');
  let barrou = null;
  try {
    await c.query(
      `insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel, categoria_id)
       values ($1, 'Sonda de isolamento', 100, 'un', true, $2)`,
      [t3.rows[0].id, catEmporio.rows[0].id]);
  } catch (e) { barrou = e.code; }
  await c.query('rollback to savepoint sp_iso');
  chk('produto NÃO aceita categoria de outro tenant (FK composta, 23503)',
    barrou === '23503', `codigo=${barrou}`);

  // -----------------------------------------------------------------------
  console.log('\n-- 5. O número NÃO volta a circular (caso 2 do enunciado) --\n');
  const tid = t2.rows[0].id;
  const criado = await c.query(
    `insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel)
     values ($1,'Sonda A',100,'un',true) returning id, sku`, [tid]);
  const skuA = criado.rows[0].sku;
  chk('produto novo recebe sku da sequência automaticamente', /^[0-9]+$/.test(skuA ?? ''), `sku=${skuA}`);

  // O esperado é DERIVADO do estado, não escrito à mão. A primeira versão deste
  // teste cravou 41 e ficou vermelha com 42 — e a migração estava certa: o
  // emporio tem 41 vivos, 40 com prefixo (1..40), então o 41 foi consumido pelo
  // produto sem prefixo e o próximo é o 42. Cravar o número aqui é a mesma
  // família de "lista escrita à mão que diverge da fonte".
  const maiorAntes = await c.query(
    `select max((p.sku)::integer) as maior from public.produtos p
      where p.tenant_id = $1 and p.sku ~ '^[0-9]+$' and p.id <> $2`, [tid, criado.rows[0].id]);
  chk('e o número é o seguinte ao maior que o backfill produziu',
    Number(skuA) === Number(maiorAntes.rows[0].maior) + 1,
    `maior=${maiorAntes.rows[0].maior} novo=${skuA}`);

  await c.query(`update public.produtos set deletado_em = now() where id = $1`, [criado.rows[0].id]);
  const criado2 = await c.query(
    `insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel)
     values ($1,'Sonda B',100,'un',true) returning id, sku`, [tid]);
  chk('depois de APAGAR o anterior, o novo NÃO recebe o número do apagado',
    criado2.rows[0].sku !== skuA, `apagado=${skuA} novo=${criado2.rows[0].sku}`);
  chk('e o novo é o seguinte da sequência', criado2.rows[0].sku === String(Number(skuA) + 1),
    `${criado2.rows[0].sku}`);

  // e o índice recusa reusar o número do apagado, na marra
  await c.query('savepoint sp_reuso');
  let colidiu = null;
  try {
    await c.query(
      `insert into public.produtos (tenant_id, nome, preco_centavos, unidade, disponivel, sku)
       values ($1,'Sonda C',100,'un',true,$2)`, [tid, skuA]);
  } catch (e) { colidiu = e.code; }
  await c.query('rollback to savepoint sp_reuso');
  chk('o índice RECUSA reusar o sku de um produto apagado (23505)', colidiu === '23505', `codigo=${colidiu}`);

  // -----------------------------------------------------------------------
  console.log('\n-- 6. O rollback devolve o nome COM o prefixo --\n');
  await c.query(semTx(ROLLBACK));
  const volta = await c.query(
    `select p.id, p.nome, p.sku from public.produtos p where p.deletado_em is null`);
  const mapaVolta = new Map(volta.rows.map((r) => [r.id, r]));
  const naoVoltou = antes.rows.filter((a) => mapaVolta.get(a.id)?.nome !== a.nome);
  chk(`os ${antes.rows.length} nomes voltaram EXATAMENTE ao que eram`, naoVoltou.length === 0,
    naoVoltou.slice(0, 3).map((e) => `${JSON.stringify(e.nome)} -> ${JSON.stringify(mapaVolta.get(e.id)?.nome)}`).join(' ; '));

  const skuVolta = antes.rows.filter((a) => (mapaVolta.get(a.id)?.sku ?? null) !== (a.sku ?? null));
  chk('e os sku voltaram ao que eram (texto legado preservado, gerados limpos)',
    skuVolta.length === 0,
    skuVolta.slice(0, 3).map((e) => `${e.sku} -> ${mapaVolta.get(e.id)?.sku}`).join(' ; '));

  const semTabela = await c.query(`select to_regclass('public.backfill_57_nome_original') is null as sumiu`);
  chk('o registro do backfill foi dropado pelo rollback', semTabela.rows[0].sumiu === true);

  const idxVolta = await c.query(
    `select indexdef from pg_indexes where schemaname='public' and indexname='uq_produtos_tenant_sku'`);
  chk('o índice voltou ao predicado anterior (com deletado_em)',
    /deletado_em/i.test(idxVolta.rows[0]?.indexdef ?? ''), idxVolta.rows[0]?.indexdef);

  // reexecutável nos dois sentidos
  await c.query(semTx(ROLLBACK));
  await c.query(semTx(MIGRACAO));
  await c.query(semTx(MIGRACAO));
  chk('migração e rollback são reexecutáveis', true);

  // -----------------------------------------------------------------------
  console.log('\n-- 7. SABOTAGEM — as asserções sabem reprovar --\n');
  // Cada uma MUTA o SQL, confirma que a mutação entrou, aplica e exige vermelho.
  const sabotar = (de, para, rotulo) => {
    const n = MIGRACAO.split(de).length - 1;
    if (n !== 1) { falhas.push(`sabotagem ${rotulo}`); console.log(`  FALHA sabotagem "${rotulo}" casa ${n}x, esperava 1`); return null; }
    const mut = MIGRACAO.split(de).join(para);
    if (mut === MIGRACAO) { falhas.push(`sabotagem ${rotulo}`); console.log(`  FALHA sabotagem "${rotulo}" nao mutou`); return null; }
    return semTx(mut);
  };

  // S1 — todos com o MESMO sku. É o caso 1 do enunciado: um teste de "todo
  //      produto tem sku" passaria; o de unicidade tem de reprovar.
  const s1 = sabotar("set sku = (b.inicio + ss.n - 1)::text", "set sku = '999'", 'sku igual para todos');
  if (s1) {
    await c.query('savepoint s1');
    await c.query(semTx(ROLLBACK));
    let erro = null;
    try { await c.query(s1); } catch (e) { erro = e.code; }
    await c.query('rollback to savepoint s1');
    chk('SABOTAGEM sku igual para todos -> o índice único REPROVA (23505)', erro === '23505', `codigo=${erro}`);
  }

  // S2 — índice com `deletado_em is null`, que é o defeito de hoje. O caso 2
  //      do enunciado: com ele, o reuso passa a ser aceito.
  const s2 = sabotar(
    "create unique index uq_produtos_tenant_sku\n  on public.produtos (tenant_id, sku)\n  where sku is not null;",
    "create unique index uq_produtos_tenant_sku on public.produtos (tenant_id, sku) where sku is not null and deletado_em is null;",
    'indice ignorando deletados');
  if (s2) {
    await c.query('savepoint s2');
    await c.query(semTx(ROLLBACK));
    await c.query(s2);
    const p1 = await c.query(
      `insert into public.produtos (tenant_id,nome,preco_centavos,unidade,disponivel)
       values ($1,'Sonda S2',100,'un',true) returning id, sku`, [tid]);
    await c.query(`update public.produtos set deletado_em=now() where id=$1`, [p1.rows[0].id]);
    let reusou = false;
    try {
      await c.query(
        `insert into public.produtos (tenant_id,nome,preco_centavos,unidade,disponivel,sku)
         values ($1,'Sonda S2b',100,'un',true,$2)`, [tid, p1.rows[0].sku]);
      reusou = true;
    } catch { reusou = false; }
    await c.query('rollback to savepoint s2');
    chk('SABOTAGEM índice ignorando deletados -> o número VOLTA a circular', reusou === true,
      'o reuso deveria ter sido aceito com o índice antigo');
  }

  // S3 — o `lower()` do JOIN que liga produto a categoria.
  //
  // A primeira versão desta sabotagem trocava `lower(token) as chave` por
  // `token as chave` no AGRUPAMENTO e esperava duas categorias. Medido: sai UMA
  // dos dois jeitos. O agrupamento não é quem colapsa "CURSO" e "Curso" — quem
  // colapsa é o índice `(tenant_id, lower(nome))` mais o `lower()` do join do
  // update. Sabotar o agrupamento media uma peça que não sustenta nada sozinha,
  // e teria ficado verde por motivo errado.
  //
  // Esta versão sabota a peça que SUSTENTA: sem o `lower()` no join, o produto
  // escrito "CURSO DE PRIMEIROS SOCORROS" não casa com a categoria "Curso" e
  // fica órfão — que é o defeito visível.
  const s3 = sabotar(
    'and lower(c.nome) = lower((regexp_match(p.nome',
    'and c.nome = ((regexp_match(p.nome',
    'join de categoria sem lower');
  if (s3) {
    await c.query('savepoint s3');
    await c.query(semTx(ROLLBACK));
    await c.query(s3);
    const orfaos = await c.query(
      `select count(*)::int n from public.produtos p join public.tenants t on t.id=p.tenant_id
        where t.slug='estudyou-sendbox' and p.deletado_em is null and p.categoria_id is null`);
    await c.query('rollback to savepoint s3');
    chk('SABOTAGEM join sem lower -> produto com grafia divergente fica SEM categoria',
      orfaos.rows[0].n > 0, `${orfaos.rows[0].n} órfãos`);
  }

  // S4 — rollback sem o registro de nomes: os nomes NÃO voltam.
  const s4de = 'update public.produtos p\n       set nome = b.nome_antes';
  if (ROLLBACK.split(s4de).length - 1 === 1) {
    const rbkMut = semTx(ROLLBACK.split(s4de).join('update public.produtos p\n       set nome = p.nome'));
    await c.query('savepoint s4');
    await c.query(semTx(ROLLBACK));
    await c.query(semTx(MIGRACAO));
    await c.query(rbkMut);
    const v = await c.query(`select id, nome from public.produtos where deletado_em is null`);
    const m = new Map(v.rows.map((r) => [r.id, r.nome]));
    const perdidos = antes.rows.filter((a) => a.prefixo && m.get(a.id) !== a.nome).length;
    await c.query('rollback to savepoint s4');
    chk('SABOTAGEM rollback sem o registro -> os nomes NÃO voltam (prova que o registro faz o trabalho)',
      perdidos >= 60, `${perdidos} nomes ficariam sem o prefixo`);
  } else {
    falhas.push('sabotagem rollback sem registro');
    console.log('  FALHA sabotagem "rollback sem registro" nao localizou o trecho');
  }
} catch (err) {
  falhas.push('exceção');
  console.log(`\n  EXCEÇÃO: ${err.code ?? ''} ${err.message}`);
} finally {
  await c.query('rollback');
  await c.end();
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
