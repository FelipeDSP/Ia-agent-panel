#!/usr/bin/env node
/**
 * Migração 46 (`saida_cortes`) numa TRANSAÇÃO ABORTADA contra produção. Nada é
 * gravado: o rollback no fim é incondicional.
 *
 * O QUE ELE PROVA, e ler o SQL não prova:
 *
 *   - que o ACL atravessa a migração INTACTO. A 46 é a primeira desta família
 *     que não mexe na assinatura, e essa é justamente a afirmação que precisa
 *     de prova: o teste tira um retrato do ACL antes e compara com o de depois,
 *     em vez de conferir contra a lista que eu escrevi — que foi exatamente
 *     como a 41 passou verde sem `n8n_agent`;
 *   - que continua existindo EXATAMENTE UMA assinatura viva, de 10 argumentos.
 *     Duas tornariam ambígua a chamada que o n8n faz (28, 32, 37);
 *   - que `n8n_agent` consegue CHAMAR depois da migração. Chamar, não
 *     `has_function_privilege`: um diz o que o ACL contém, o outro diz o que
 *     acontece;
 *   - que o corte chega na coluna, e que array vazio / chave ausente / tipo
 *     errado viram NULL **sem exceção**. É o caminho quente de toda mensagem de
 *     todo cliente: um campo de diagnóstico mal formado não pode derrubar o log
 *     de uma conversa real;
 *   - que aplicar a migração não INVENTA corte para ninguém (contagem antes ×
 *     depois), que é propriedade — e não "hoje ninguém tem corte", que seria
 *     estado do mundo e ficaria falso no primeiro vazamento real.
 *
 * A SABOTAGEM (seção 7) remove, uma por vez, as linhas que sustentam essas
 * propriedades, e exige que o teste reprove. Sem ela isto seria só uma lista de
 * coisas que passaram.
 *
 * Uso: npm run teste:saida-cortes
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const lim = (f) =>
  fs.readFileSync(RAIZ + 'supabase/migrations/' + f, 'utf8').replace(/^\s*(begin|commit)\s*;\s*$/gim, '');

const M46 = lim('20260820160000_46_saida_cortes.sql');
const R46 = lim('20260820160000_46_saida_cortes_rollback.sql');

if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(`${nome}${det ? ' — ' + det : ''}`); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

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

const assinaturas = async () => (await c.query(
  `select p.pronargs::int n, pg_get_function_identity_arguments(p.oid) tipos
     from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'api_n8n_registrar_mensagem'
    order by n`)).rows;

/** ACL como conjunto de roles com EXECUTE — é o diff que pega grant perdido. */
const rolesComExecute = async () => {
  const { rows } = await c.query(
    `select coalesce(p.proacl::text[], array[]::text[]) acl
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = 'api_n8n_registrar_mensagem'`);
  const acl = rows[0]?.acl ?? [];
  return acl.map((e) => (e.split('=')[0] === '' ? 'PUBLIC' : e.split('=')[0])).sort();
};

/** Chama COMO outro role, com os 10 argumentos que o n8n manda. */
async function chamarComoRole(role, tenantId, conv, execucaoId, componentes) {
  await c.query('savepoint sp_role');
  try {
    await c.query(`set local role ${role}`);
    const r = await c.query(
      `select public.api_n8n_registrar_mensagem($1::uuid, $2::bigint, 'saida', 'resposta limpa',
                                                10, 2, 'gpt-4.1-mini', null::numeric, $3::text, $4::jsonb) v`,
      [tenantId, conv, execucaoId, componentes]);
    await c.query('reset role');
    await c.query('release savepoint sp_role');
    return { erro: null, id: r.rows[0].v };
  } catch (e) {
    await c.query('rollback to savepoint sp_role');
    await c.query('reset role');
    return { erro: e.message, codigo: e.code, id: null };
  }
}

const cortesDaLinha = async (id) => (await c.query(
  `select saida_cortes from public.mensagens_log where id = $1`, [id])).rows[0]?.saida_cortes;

const CORTE = [{ tipo: 'used_tools', trecho: '[Used tools: Tool: Busca_Conhecimento, ...]' }];

await c.connect();
await c.query('begin');

try {
  console.log('\n== Migração 46: saida_cortes em mensagens_log ==\n');

  await c.query(`set local request.jwt.claims = '{"app_metadata":{"papel":"super_admin"}}'`);
  const slug = `zz-efem-cortes46-${Math.random().toString(16).slice(2, 10)}`;
  const tenant = (await c.query(
    `insert into public.tenants (slug, nome, ativo) values ($1, $2, true) returning id`,
    [slug, 'efêmero cortes 46'])).rows[0]?.id;
  if (!tenant) throw new Error('não consegui criar o tenant efêmero');
  const CONV = 970046n;

  // -------------------------------------------------------------------------
  console.log('-- 1. Retrato de antes --\n');

  const aclAntes = await rolesComExecute();
  const assinaturasAntes = await assinaturas();
  // Via `tentar`: a query FALHA de propósito (a coluna não existe ainda), e um
  // `catch` em cima de `c.query` cru deixaria a transação abortada — todo
  // comando seguinte morreria com 25P02 e o teste reportaria a propriedade
  // errada. Savepoint é o que torna o erro esperado um valor.
  const antesDaColuna = await tentar(
    `select count(*) n from public.mensagens_log where saida_cortes is not null`);
  const comCorteAntes = antesDaColuna.erro ? -1 : Number(antesDaColuna.rows[0].n);

  console.log(`  ACL antes: ${aclAntes.join(', ')}`);
  console.log(`  assinaturas antes: ${assinaturasAntes.map((a) => a.n).join(', ')}`);
  chk('a coluna ainda NÃO existe (senão a migração já foi aplicada e o teste mede outra coisa)',
    comCorteAntes === -1, `contagem devolveu ${comCorteAntes}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 2. Aplica a migração --\n');

  await c.query(M46);
  chk('a migração aplica sem erro', true);

  const aclDepois = await rolesComExecute();
  const assinaturasDepois = await assinaturas();

  // A asserção central desta migração.
  chk('o ACL é IDÊNTICO ao de antes (não houve drop, nada para reconceder)',
    JSON.stringify(aclAntes) === JSON.stringify(aclDepois),
    `antes: ${aclAntes.join(',')} | depois: ${aclDepois.join(',')}`);
  chk('`n8n_agent` continua no ACL', aclDepois.includes('n8n_agent'));
  chk('`anon` e `authenticated` continuam FORA',
    !aclDepois.includes('anon') && !aclDepois.includes('authenticated'), aclDepois.join(','));

  chk('existe EXATAMENTE UMA assinatura viva', assinaturasDepois.length === 1,
    assinaturasDepois.map((a) => `${a.n}: ${a.tipos}`).join(' | '));
  chk('e ela tem os mesmos 10 argumentos de antes',
    assinaturasDepois[0]?.n === 10 && assinaturasDepois[0]?.tipos === assinaturasAntes[0]?.tipos);

  // Propriedade, não estado do mundo: a migração não inventa corte para ninguém.
  const comCorteDepois = Number((await c.query(
    `select count(*) n from public.mensagens_log where saida_cortes is not null`)).rows[0].n);
  chk('aplicar a migração não cria corte para ninguém', comCorteDepois === 0, `${comCorteDepois} linha(s)`);

  const idx = (await c.query(
    `select 1 from pg_indexes where tablename='mensagens_log' and indexname='idx_mensagens_log_saida_cortes'`)).rowCount;
  chk('o índice parcial existe', idx === 1);

  // -------------------------------------------------------------------------
  console.log('\n-- 3. A chamada do n8n, como n8n_agent --\n');

  const comCorte = await chamarComoRole('n8n_agent', tenant, CONV, 'exec-46-a',
    JSON.stringify({ wrapper: 10, fonte: 'estimativa_nossa_com_multiplicidade', saida_cortes: CORTE }));
  chk('`n8n_agent` CHAMA a função depois da migração', comCorte.erro === null, comCorte.erro ?? '');
  chk('e o corte chega na coluna',
    JSON.stringify(await cortesDaLinha(comCorte.id)) === JSON.stringify(CORTE),
    JSON.stringify(await cortesDaLinha(comCorte.id)));

  const compAindaGrava = (await c.query(
    `select tokens_wrapper, fonte_tokens from public.mensagens_log where id = $1`, [comCorte.id])).rows[0];
  chk('os componentes de token continuam sendo gravados (a 42 não foi quebrada)',
    compAindaGrava.tokens_wrapper === 10 && compAindaGrava.fonte_tokens === 'estimativa_nossa_com_multiplicidade',
    JSON.stringify(compAindaGrava));

  // -------------------------------------------------------------------------
  console.log('\n-- 4. O que tem de virar NULL, e sem exceção --\n');

  const casos = [
    ['array vazio', JSON.stringify({ saida_cortes: [] })],
    ['chave ausente', JSON.stringify({ wrapper: 1 })],
    ['null JSON', JSON.stringify({ saida_cortes: null })],
    ['string em vez de array', JSON.stringify({ saida_cortes: 'cortei' })],
    ['objeto em vez de array', JSON.stringify({ saida_cortes: { tipo: 'x' } })],
    ['número em vez de array', JSON.stringify({ saida_cortes: 7 })],
    ['componentes nulo', null],
  ];
  for (const [nome, comp] of casos) {
    const r = await chamarComoRole('n8n_agent', tenant, CONV, `exec-46-${nome.replace(/\W+/g, '')}`, comp);
    if (r.erro) { chk(`${nome}: não estoura`, false, r.erro); continue; }
    chk(`${nome}: não estoura e grava NULL`, (await cortesDaLinha(r.id)) === null,
      JSON.stringify(await cortesDaLinha(r.id)));
  }

  // -------------------------------------------------------------------------
  console.log('\n-- 5. Reexecutável --\n');

  const r2 = await tentar(M46);
  chk('aplicar a migração duas vezes não quebra', r2.erro === null, r2.erro ?? '');
  chk('e o ACL continua o mesmo depois da segunda',
    JSON.stringify(await rolesComExecute()) === JSON.stringify(aclAntes));

  // -------------------------------------------------------------------------
  console.log('\n-- 6. Rollback --\n');

  await c.query(R46);
  const colDepoisRollback = (await c.query(
    `select 1 from information_schema.columns
      where table_name='mensagens_log' and column_name='saida_cortes'`)).rowCount;
  chk('o rollback derruba a coluna', colDepoisRollback === 0);
  chk('e o ACL continua intacto depois do rollback',
    JSON.stringify(await rolesComExecute()) === JSON.stringify(aclAntes),
    (await rolesComExecute()).join(','));

  const depoisRb = await chamarComoRole('n8n_agent', tenant, CONV, 'exec-46-pos-rollback',
    JSON.stringify({ wrapper: 3, saida_cortes: CORTE }));
  chk('e o n8n continua registrando mensagem depois do rollback', depoisRb.erro === null, depoisRb.erro ?? '');

  // Volta para o estado "migração aplicada" para as sabotagens rodarem em cima.
  await c.query(M46);

  // -------------------------------------------------------------------------
  console.log('\n-- 7. Sabotagem --\n');

  {
    // Tira a guarda de `jsonb_typeof`: o caso "string em vez de array" tem de
    // passar a ESTOURAR. Se continuar NULL, a guarda não estava fazendo nada e
    // a seção 4 seria decorativa.
    const sabotado = M46.replace(
      "when jsonb_typeof(p_componentes -> 'saida_cortes') = 'array'\n     and jsonb_array_length(p_componentes -> 'saida_cortes') > 0",
      "when jsonb_array_length(p_componentes -> 'saida_cortes') > 0");
    chk('mutação entrou (a guarda saiu do SQL)', sabotado !== M46 && !sabotado.includes("jsonb_typeof(p_componentes"));

    const r = await tentar(sabotado);
    chk('a versão sabotada aplica', r.erro === null, r.erro ?? '');
    const s = await chamarComoRole('n8n_agent', tenant, CONV, 'exec-46-sab1', JSON.stringify({ saida_cortes: 'cortei' }));
    chk('sem a guarda, tipo errado ESTOURA (o teste reprova)', s.erro !== null, `erro: ${s.erro ?? '(nenhum)'}`);
    await c.query(M46); // restaura
  }
  {
    // Tira a coluna do INSERT: o corte deixa de chegar, e a seção 3 tem de cair.
    const sabotado = M46
      .replace('chamadas, fonte_tokens,\n     saida_cortes)', 'chamadas, fonte_tokens)')
      .replace("nullif(p_componentes ->> 'fonte', ''),\n     v_cortes)", "nullif(p_componentes ->> 'fonte', ''))");
    chk('mutação entrou (a coluna saiu do insert)', sabotado !== M46 && !sabotado.includes('v_cortes)'));

    const r = await tentar(sabotado);
    chk('a versão sabotada aplica', r.erro === null, r.erro ?? '');
    const s = await chamarComoRole('n8n_agent', tenant, CONV, 'exec-46-sab2', JSON.stringify({ saida_cortes: CORTE }));
    chk('sem a coluna no insert, o corte NÃO chega (o teste reprova)',
      s.erro === null && (await cortesDaLinha(s.id)) === null,
      s.erro ?? JSON.stringify(await cortesDaLinha(s.id)));
    await c.query(M46); // restaura
  }
} catch (e) {
  falhas.push(`exceção não prevista: ${e.message}`);
  console.log(`  FALHA exceção não prevista — ${e.message}`);
} finally {
  await c.query('rollback');
  const sobrou = (await c.query(
    `select 1 from information_schema.columns
      where table_name='mensagens_log' and column_name='saida_cortes'`)).rowCount;
  console.log(`\n  (transação revertida; coluna em produção: ${sobrou ? 'EXISTE — algo vazou!' : 'não existe, como esperado'})`);
  if (sobrou) falhas.push('a coluna sobreviveu ao rollback da transação');
  await c.end();
}

console.log('\n----------------------------------------------------------');
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
falhas.forEach((f) => console.log(`  ! ${f}`));
console.log();
process.exit(falhas.length === 0 ? 0 : 1);
