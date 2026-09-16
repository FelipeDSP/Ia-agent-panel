/**
 * A credencial Asaas por tenant no painel da agência — a parte pura e a
 * garantia de que a CHAVE nunca chega ao browser.
 *
 *   node --import ./tests/lib/ts.mjs tests/asaas-tenant-painel.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validarAsaasTenant, ambienteDaChave, baseUrlDoAmbiente, urlDoWebhookNoAgente, gerarTokenWebhook, corpoDoWebhookAsaas } from '../src/lib/pagamento/asaas-tenant.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
const form = (o) => { const fd = new FormData(); for (const [k, v] of Object.entries(o)) fd.set(k, v); return fd; };
const SB = '$aact_hmlg_' + 'x'.repeat(40);
const PR = '$aact_' + 'y'.repeat(40);

console.log('\n== 1. Chave x ambiente ==\n');
chk('ambienteDaChave: hmlg -> sandbox; $aact_ sem hmlg -> producao; outra coisa -> null', ambienteDaChave(SB) === 'sandbox' && ambienteDaChave(PR) === 'producao' && ambienteDaChave('abc') === null);
chk('base URL derivada do ambiente (nunca guardada)', baseUrlDoAmbiente('sandbox') === 'https://api-sandbox.asaas.com' && baseUrlDoAmbiente('producao') === 'https://api.asaas.com');
{
  const r = validarAsaasTenant(form({ asaas_ambiente: 'sandbox', asaas_api_key: SB }));
  chk('sandbox + chave hmlg -> ok', r.ok && r.valor.chave === SB && r.valor.ambiente === 'sandbox');
  const r2 = validarAsaasTenant(form({ asaas_ambiente: 'producao', asaas_api_key: SB }));
  chk('producao + chave de SANDBOX -> recusada (o estado impossível)', !r2.ok && /SANDBOX/.test(r2.erros.asaas_api_key ?? ''));
  const r3 = validarAsaasTenant(form({ asaas_ambiente: 'sandbox', asaas_api_key: PR }));
  chk('sandbox + chave de PRODUÇÃO -> recusada', !r3.ok && /PRODUÇÃO/.test(r3.erros.asaas_api_key ?? ''));
  const r4 = validarAsaasTenant(form({ asaas_ambiente: 'producao', asaas_api_key: '' }));
  chk('chave em branco = manter (null), ambiente válido', r4.ok && r4.valor.chave === null && r4.valor.ambiente === 'producao');
  const r5 = validarAsaasTenant(form({ asaas_ambiente: 'lua', asaas_api_key: SB }));
  chk('ambiente desconhecido -> erro', !r5.ok && 'asaas_ambiente' in r5.erros);
  const r6 = validarAsaasTenant(form({ asaas_ambiente: 'sandbox', asaas_api_key: 'senha123' }));
  chk('texto que não é chave -> erro', !r6.ok && /\$aact_/.test(r6.erros.asaas_api_key ?? ''));
}

console.log('\n== 2. Token e webhook ==\n');
chk('token: 24 bytes -> 48 hex (atende o CHECK 32..255)', /^[0-9a-f]{48}$/.test(gerarTokenWebhook(new Uint8Array(24).fill(255))));
chk('URL do webhook: AGENTE_URL vence; senão deriva de AGENTE_LIMPEZA_URL; senão null',
  urlDoWebhookNoAgente({ AGENTE_URL: 'https://hercules.chatyou.chat/' }) === 'https://hercules.chatyou.chat/asaas'
  && urlDoWebhookNoAgente({ AGENTE_LIMPEZA_URL: 'https://hercules.chatyou.chat/limpar-memoria' }) === 'https://hercules.chatyou.chat/asaas'
  && urlDoWebhookNoAgente({}) === null);
const corpo = corpoDoWebhookAsaas('https://x/asaas', 'tok', 'a@b.c');
chk('corpo do webhook: url, authToken, os dois eventos, enabled', corpo.url === 'https://x/asaas' && corpo.authToken === 'tok' && corpo.enabled === true && JSON.stringify(corpo.events) === JSON.stringify(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED']));

console.log('\n== 3. A chave NÃO chega ao browser ==\n');
{
  const pagina = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/tenants/[id]/page.tsx'), 'utf8');
  const comp = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/tenants/[id]/componentes.tsx'), 'utf8');
  chk("a página passa só Boolean(...) das chaves ao componente cliente", /temChaveSandbox=\{Boolean\(credAsaas\?\.asaas_api_key_sandbox\)\}/.test(pagina) && /temChaveProducao=\{Boolean\(credAsaas\?\.asaas_api_key_producao\)\}/.test(pagina));
  chk('o componente cliente não recebe prop com a chave (só booleanos e a URL)', /temChaveSandbox: boolean;/.test(comp) && !/asaas_api_key_sandbox|asaas_api_key_producao/.test(comp));
  chk("componentes.tsx é 'use client' (por isso a regra acima importa)", /^'use client';/m.test(comp));
  chk('o campo da chave é type=password e sem defaultValue', /name="asaas_api_key"[\s\S]{0,120}type="password"/.test(comp) && !/name="asaas_api_key"[\s\S]{0,200}defaultValue/.test(comp));
  const acoes = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/acoes.ts'), 'utf8');
  chk('as duas ações exigem super_admin', (acoes.match(/export async function (salvarAsaasTenant|registrarWebhookAsaas)[\s\S]{0,200}?await exigirSuperAdmin\(\)/g) ?? []).length === 2);
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
