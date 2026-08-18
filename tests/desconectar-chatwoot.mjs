#!/usr/bin/env node
/**
 * Desconectar o Chatwoot faz o que promete — e NÃO faz o que não promete.
 *
 * Roda numa TRANSAÇÃO ABORTADA contra produção, com tenants efêmeros criados
 * aqui dentro. Nada é gravado.
 *
 * O QUE PROVA, e nenhuma destas é óbvia lendo a Server Action:
 *
 *  - que o `trg_tenants_guard_colunas` DEIXA zerar `chatwoot_account_id` com
 *    claim de super_admin. `chatwoot_account_id` é coluna de agência: com
 *    contexto errado o guard recusa, e o botão falharia só em produção;
 *  - que a conta liberada PODE ser ligada a outro tenant. É o objetivo do
 *    botão — o `UNIQUE` da coluna é o que impedia, e zerar tem de soltá-lo;
 *  - que o token SOBREVIVE. É a promessa que a tela faz ("reconectar não exige
 *    gerar token novo"), e uma promessa de tela que o banco não cumpre é pior
 *    que não ter feito;
 *  - que `chatwoot_url` fica. É a instância, não a conta.
 *
 * Uso: npm run teste:desconectar-chatwoot
 */

import pg from 'pg';

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

async function tentar(sql, params = []) {
  await c.query('savepoint sp');
  try {
    const r = await c.query(sql, params);
    await c.query('release savepoint sp');
    return { erro: null, codigo: null, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint sp');
    return { erro: e.message, codigo: e.code, rows: [] };
  }
}

await c.connect();
await c.query('begin');

try {
  console.log('\n== Desconectar Chatwoot ==\n');

  const sufixo = Math.random().toString(16).slice(2, 10);
  const conta = 900000 + Math.floor(Math.random() * 90000); // fora da faixa real

  await c.query(`set local request.jwt.claims = '{"app_metadata":{"papel":"super_admin"}}'`);

  const a = (await c.query(
    `insert into public.tenants (slug, nome, ativo, chatwoot_account_id, chatwoot_url)
     values ($1, 'efêmero A', true, $2, 'https://app.chatyou.chat') returning id`,
    [`zz-efem-desconn-a-${sufixo}`, conta])).rows[0].id;
  const b = (await c.query(
    `insert into public.tenants (slug, nome, ativo) values ($1, 'efêmero B', true) returning id`,
    [`zz-efem-desconn-b-${sufixo}`])).rows[0].id;

  await c.query(
    `insert into public.tenant_credenciais (tenant_id, chatwoot_token) values ($1, $2)`,
    [a, 'token-de-teste-24-chars']);

  // -------------------------------------------------------------------------
  console.log('-- 1. A conta está presa a A (é o que o botão existe para soltar) --\n');

  const presa = await tentar(
    `update public.tenants set chatwoot_account_id = $2 where id = $1`, [b, conta]);
  chk('B NÃO consegue tomar a conta enquanto A a tem', presa.codigo === '23505',
    `veio ${presa.codigo ?? 'sem erro'}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 2. Desconectar A --\n');

  const desconectou = await tentar(
    `update public.tenants set chatwoot_account_id = null where id = $1`, [a]);
  chk('o guard DEIXA zerar com claim de super_admin', desconectou.erro === null,
    `veio ${desconectou.codigo} ${desconectou.erro}`);

  const depoisA = (await c.query(
    `select chatwoot_account_id, chatwoot_url from public.tenants where id = $1`, [a])).rows[0];
  chk('conta zerada', depoisA.chatwoot_account_id === null, String(depoisA.chatwoot_account_id));
  chk('chatwoot_url FICA (é a instância, não a conta)',
    depoisA.chatwoot_url === 'https://app.chatyou.chat', String(depoisA.chatwoot_url));

  const cred = (await c.query(
    `select chatwoot_token from public.tenant_credenciais where tenant_id = $1`, [a])).rows[0];
  chk('o token SOBREVIVE — a promessa da tela', cred?.chatwoot_token === 'token-de-teste-24-chars',
    cred ? `${String(cred.chatwoot_token).length} chars` : '(linha sumiu)');

  // -------------------------------------------------------------------------
  console.log('\n-- 3. E agora a conta vai para B, que é o objetivo --\n');

  const mudou = await tentar(
    `update public.tenants set chatwoot_account_id = $2 where id = $1`, [b, conta]);
  chk('B assume a conta liberada', mudou.erro === null, `veio ${mudou.codigo} ${mudou.erro}`);
  // `chatwoot_account_id` e BIGINT, e o driver devolve bigint como STRING (não
  // cabe em Number com segurança). Comparar com `===` contra número falha
  // sempre — a primeira versão deste teste caiu nisso e acusou defeito onde não
  // havia.
  const contaB = (await c.query(
    `select chatwoot_account_id from public.tenants where id = $1`, [b])).rows[0].chatwoot_account_id;
  chk('e a conta aponta mesmo para B', String(contaB) === String(conta), `veio ${contaB}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 4. O que NÃO acontece (a terceira frase da confirmação) --\n');

  // Semeia dado de A e confere que desconectar de novo não o toca. Sem semear,
  // "nada foi apagado" seria verdade por vacuidade — a contraprova é o ponto.
  await c.query(
    // 'ativo', não 'aberta': o CHECK aceita ativo|pausado|resolvido.
    `insert into public.conversas (tenant_id, conversation_id, status) values ($1, $2, 'ativo')`,
    [a, 970055]);
  const antesConv = (await c.query(
    `select count(*)::int n from public.conversas where tenant_id = $1`, [a])).rows[0].n;
  chk('a conversa semeada existe (contraprova)', antesConv === 1, String(antesConv));

  await tentar(`update public.tenants set chatwoot_account_id = null where id = $1`, [a]);
  const depoisConv = (await c.query(
    `select count(*)::int n from public.conversas where tenant_id = $1`, [a])).rows[0].n;
  chk('desconectar NÃO apaga conversa', depoisConv === antesConv, `${antesConv} -> ${depoisConv}`);

  // -------------------------------------------------------------------------
  console.log('\n-- 5. A excecao: desconectar E apagar a credencial --\n');

  // O caminho padrao preserva o token; este apaga. Existe porque token guardado
  // so ajuda enquanto VALE: com o bot trocado, o guardado nao da erro ao
  // reconectar — o agente processa o turno e falha no ENVIO, calado.
  const credAntes = (await c.query(
    `select count(*)::int n from public.tenant_credenciais where tenant_id = $1`, [a])).rows[0].n;
  chk('a credencial de A existe antes (contraprova)', credAntes === 1, String(credAntes));

  // B ganha credencial ANTES, para o delete de A ter em quem errar. Sem isso,
  // "so a de A sumiu" seria verdade por vacuidade.
  await c.query(
    `insert into public.tenant_credenciais (tenant_id, chatwoot_token) values ($1, $2)`,
    [b, 'token-do-B-nao-tocar-24']);

  const apagou = await tentar(`delete from public.tenant_credenciais where tenant_id = $1`, [a]);
  chk('apagar a credencial de A funciona', apagou.erro === null, `veio ${apagou.codigo} ${apagou.erro}`);

  const credDepois = (await c.query(
    `select count(*)::int n from public.tenant_credenciais where tenant_id = $1`, [a])).rows[0].n;
  chk('a credencial de A sumiu', credDepois === 0, String(credDepois));

  const credB = (await c.query(
    `select chatwoot_token from public.tenant_credenciais where tenant_id = $1`, [b])).rows[0];
  chk('a credencial de B sobrevive ao delete escopado em A',
    credB?.chatwoot_token === 'token-do-B-nao-tocar-24', credB ? 'outro valor' : '(sumiu)');

  const convDepoisApagar = (await c.query(
    `select count(*)::int n from public.conversas where tenant_id = $1`, [a])).rows[0].n;
  chk('apagar credencial NAO apaga conversa', convDepoisApagar === antesConv,
    `${antesConv} -> ${convDepoisApagar}`);

  // -------------------------------------------------------------------------

  console.log('\n-- 6. Sem claim de super_admin, o guard recusa --\n');

  // Contraprova do primeiro item: se passasse com qualquer contexto, a asserção
  // "o guard deixa com super_admin" não estaria medindo o guard.
  await c.query('savepoint sp_papel');
  await c.query(`set local request.jwt.claims = '{"user_metadata":{"papel":"super_admin"}}'`);
  const semPapel = await tentar(
    `update public.tenants set chatwoot_account_id = $2 where id = $1`, [b, conta + 1]);
  chk('claim em user_metadata (lugar errado) é RECUSADO pelo guard',
    semPapel.erro !== null, 'passou — o guard não está olhando o papel');
  await c.query('rollback to savepoint sp_papel');
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

process.exitCode = falhas.length > 0 ? 1 : 0;
