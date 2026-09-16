/**
 * Arranjo do PAGAMENTO no `estudyou-sendbox` — o que a fatia 3 precisa no
 * banco e no Asaas para o link de pagamento funcionar no sandbox.
 *
 *   1. `tenant_credenciais` do sendbox: `asaas_ambiente='sandbox'`, a chave de
 *      sandbox (ASAAS_SANDBOX_KEY do .env.local) e um token de webhook (gerado
 *      aqui, 48 hex; guardado só no banco — o Asaas o manda de volta no header
 *      `asaas-access-token`);
 *   2. `tenant_tools`: `pagamento` contratada e ativa;
 *   3. webhook no Asaas sandbox apontando para `<URL do serviço>/asaas`, com
 *      `authToken` = o token acima, eventos PAYMENT_RECEIVED e PAYMENT_CONFIRMED.
 *      Idempotente: se já existir webhook com essa URL, atualiza em vez de criar.
 *
 * Só sandbox: recusa qualquer chave que não comece com `$aact_hmlg_`.
 * Reexecutável. Não toca em nenhum outro tenant.
 *
 *   node --env-file=.env.local scripts/pagamento-sendbox-arranjo.mjs https://hercules.chatyou.chat
 */
import crypto from 'node:crypto';
import pg from 'pg';

const URL_SERVICO = (process.argv[2] ?? '').replace(/\/+$/, '');
const KEY = process.env.ASAAS_SANDBOX_KEY;
const DB = process.env.SUPABASE_DB_URL;
if (!URL_SERVICO.startsWith('https://')) { console.error('uso: ... <https://url-do-servico>'); process.exit(2); }
if (!KEY || !KEY.startsWith('$aact_hmlg_')) { console.error('ASAAS_SANDBOX_KEY ausente ou NÃO é de sandbox — este script só roda no sandbox.'); process.exit(2); }
if (!DB) { console.error('SUPABASE_DB_URL ausente'); process.exit(2); }

const c = new pg.Client({ connectionString: DB, ssl: { rejectUnauthorized: false } });
await c.connect();
const asaas = async (metodo, caminho, corpo) => {
  const r = await fetch(`https://api-sandbox.asaas.com${caminho}`, { method: metodo, headers: { access_token: KEY, 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

try {
  await c.query('begin');
  const t = (await c.query(`select id from public.tenants where slug='estudyou-sendbox' and deletado_em is null`)).rows[0];
  if (!t) throw new Error('sendbox não encontrado');

  // 1. credencial (mantém o token se já houver um; gera se não)
  const atual = (await c.query(`select asaas_webhook_token_sandbox tok from public.tenant_credenciais where tenant_id=$1`, [t.id])).rows[0];
  const token = atual?.tok ?? crypto.randomBytes(24).toString('hex');
  await c.query(`insert into public.tenant_credenciais (tenant_id, asaas_ambiente, asaas_api_key_sandbox, asaas_webhook_token_sandbox)
                 values ($1, 'sandbox', $2, $3)
                 on conflict (tenant_id) do update set asaas_ambiente='sandbox', asaas_api_key_sandbox=excluded.asaas_api_key_sandbox, asaas_webhook_token_sandbox=excluded.asaas_webhook_token_sandbox`, [t.id, KEY, token]);
  // 2. contrato
  await c.query(`insert into public.tenant_tools (tenant_id, tool_nome, ativo, contratado) values ($1, 'pagamento', true, true)
                 on conflict (tenant_id, tool_nome) do update set ativo=true, contratado=true`, [t.id]);
  const cred = (await c.query(`select ativa, ambiente, base_url, length(api_key) k, length(webhook_token) w, expira_minutos, minimo_centavos from public.api_n8n_credencial_asaas($1)`, [t.id])).rows[0];
  await c.query('commit');
  console.log('banco:', JSON.stringify(cred));
  if (!cred.ativa || cred.ambiente !== 'sandbox') throw new Error('credencial não ficou ativa em sandbox');

  // 3. webhook no Asaas
  const url = `${URL_SERVICO}/asaas`;
  const lista = await asaas('GET', '/v3/webhooks');
  const existente = (lista.json?.data ?? []).find((w) => w.url === url);
  const corpo = { name: 'agente chatyou (sandbox)', url, email: 'edicao@estudyou.com', enabled: true, interrupted: false, authToken: token, sendType: 'SEQUENTIALLY', apiVersion: 3, events: ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'] };
  const r = existente ? await asaas('PUT', `/v3/webhooks/${existente.id}`, corpo) : await asaas('POST', '/v3/webhooks', corpo);
  console.log(existente ? 'webhook ATUALIZADO' : 'webhook CRIADO', r.status, JSON.stringify({ id: r.json?.id, url: r.json?.url, enabled: r.json?.enabled, interrupted: r.json?.interrupted, events: r.json?.events }));
  if (r.status >= 300) throw new Error(`Asaas recusou o webhook: ${JSON.stringify(r.json).slice(0, 300)}`);
} catch (e) {
  await c.query('rollback').catch(() => {});
  console.error('FALHOU:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
