#!/usr/bin/env node
/**
 * Rotaciona o `chatwoot_token` de UM tenant, com verificação pelo mesmo caminho
 * que o agente usa.
 *
 * POR QUE EXISTE. Em 18/08/2026 seis funções `SECURITY DEFINER` estavam
 * executáveis por `anon`, e duas delas devolvem `chatwoot_token` — o token de
 * qualquer tenant saía por HTTPS com a chave publicável, sem sessão. A migração
 * 43 fechou o ACL; fechar impede vazamento novo e **não desfaz o antigo**. Daí a
 * rotação.
 *
 * O TOKEN NUNCA APARECE: entra por variável de ambiente (não por argumento, que
 * fica no histórico do shell e na lista de processos) e sai do script como
 * comprimento e md5 — nunca como valor. Nem no sucesso, nem no erro.
 *
 * A JANELA. Regenerar no Chatwoot invalida o token antigo na hora. Entre isso e
 * a gravação aqui, o agente daquele tenant não consegue responder. Por isso:
 * um tenant por vez, e este script grava e confere numa ida só.
 *
 * Uso:
 *   TOKEN_NOVO='<token>' node --env-file=.env.local scripts/rotacionar-credencial.mjs <slug>
 *   TOKEN_NOVO='<token>' node --env-file=.env.local scripts/rotacionar-credencial.mjs <slug> --ensaio
 *
 * `--ensaio` faz tudo dentro de uma transação que é revertida no fim: serve para
 * provar o caminho de gravação sem gastar um token de verdade.
 */

import crypto from 'node:crypto';
import pg from 'pg';

const slug = process.argv[2];
const ensaio = process.argv.includes('--ensaio');
const token = process.env.TOKEN_NOVO;

if (!slug || slug.startsWith('--')) {
  console.error('uso: TOKEN_NOVO=<token> node --env-file=.env.local scripts/rotacionar-credencial.mjs <slug> [--ensaio]');
  process.exit(1);
}
if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ausente. Rode com --env-file=.env.local');
  process.exit(1);
}
if (!token) {
  console.error('TOKEN_NOVO ausente. Passe por variável de ambiente, não por argumento.');
  process.exit(1);
}

// Guardas contra o erro mais provável: colar com espaço, quebra de linha, ou
// colar a coisa errada. Nenhuma delas dá erro no banco — dão agente quebrado.
const limpo = token.trim();
if (limpo !== token) {
  console.error('TOKEN_NOVO tem espaço ou quebra de linha nas pontas. Cole de novo, sem sobra.');
  process.exit(1);
}
if (!/^[A-Za-z0-9_\-]+$/.test(limpo)) {
  console.error('TOKEN_NOVO tem caractere fora do esperado — confira se colou o token e não outra coisa.');
  process.exit(1);
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex').slice(0, 8);
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

await c.connect();
await c.query('begin');
let ok = false;
try {
  const t = (await c.query(
    `select t.id, t.nome, t.chatwoot_account_id, t.chatwoot_url, t.agente_ativo,
            tc.chatwoot_token antigo
       from public.tenants t
       left join public.tenant_credenciais tc on tc.tenant_id = t.id
      where t.slug = $1 and t.deletado_em is null`, [slug])).rows[0];

  if (!t) throw new Error(`tenant '${slug}' não encontrado (ou soft-deletado)`);

  console.log(`\n  tenant     ${slug} — ${t.nome}`);
  console.log(`  conta      ${t.chatwoot_account_id ?? '(sem chatwoot_account_id)'}`);
  console.log(`  agente     ${t.agente_ativo ? 'ativo' : 'DESLIGADO'}`);
  console.log(`  antes      ${t.antigo ? `${t.antigo.length} chars, md5 ${md5(t.antigo)}` : '(sem credencial)'}`);
  console.log(`  depois     ${limpo.length} chars, md5 ${md5(limpo)}`);

  if (t.antigo && t.antigo === limpo) {
    throw new Error('o token novo é IGUAL ao atual — nada foi rotacionado. Regenere no Chatwoot antes.');
  }
  if (t.antigo && t.antigo.length !== limpo.length) {
    console.log(`  aviso      comprimento mudou (${t.antigo.length} -> ${limpo.length}). Não é erro, mas confira.`);
  }

  // upsert: tenant que ainda não tinha linha recebe a primeira.
  await c.query(
    `insert into public.tenant_credenciais (tenant_id, chatwoot_token)
     values ($1, $2)
     on conflict (tenant_id) do update set chatwoot_token = excluded.chatwoot_token,
                                           atualizado_em = now()`,
    [t.id, limpo]);

  // A CONFERÊNCIA VALE PELO CAMINHO DO AGENTE, não pela tabela: é
  // `api_n8n_credencial_chatwoot` que o n8n chama, e é ela que precisa devolver
  // o valor novo. Conferir a tabela provaria menos.
  const lido = (await c.query(
    `select chatwoot_token, chatwoot_url, chatwoot_account_id
       from public.api_n8n_credencial_chatwoot($1::uuid)`, [t.id])).rows[0];

  const bate = lido?.chatwoot_token === limpo;
  console.log(`  leitura    ${bate ? 'OK' : 'DIVERGE'} — o agente lê md5 ${lido?.chatwoot_token ? md5(lido.chatwoot_token) : '(nulo)'}`);
  if (!bate) throw new Error('o que o agente lê não é o que foi gravado — NÃO comite');
  if (!lido.chatwoot_url) console.log('  aviso      chatwoot_url vazio: o agente não tem para onde responder');
  if (!lido.chatwoot_account_id) console.log('  aviso      sem chatwoot_account_id: este tenant não recebe webhook');

  ok = true;
} catch (e) {
  console.error(`\n  ERRO  ${e.message}`);
} finally {
  if (ok && !ensaio) {
    await c.query('commit');
    console.log('\n  GRAVADO. O agente usa o token novo na próxima mensagem.\n');
  } else {
    await c.query('rollback');
    console.log(ensaio && ok
      ? '\n  ENSAIO: revertido. O caminho de gravação funciona.\n'
      : '\n  revertido — nada foi alterado.\n');
    if (!ok) process.exitCode = 1;
  }
  await c.end().catch(() => {});
}
