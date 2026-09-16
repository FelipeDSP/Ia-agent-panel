/**
 * "Quem atende" no painel — a regra da troca de runtime e as URLs do bot.
 *
 * Propriedades: a troca exige confirmação (o painel não consegue conferir o
 * Chatwoot); trocar para o mesmo lado é recusado; as URLs vêm do ambiente e
 * nunca do form; sem token do serviço a URL sai com o marcador, não vazia; a
 * ordem do roteiro é a ensaiada em 16/09 (ida: bot antes; volta: coluna antes).
 *
 *   node --import ./tests/lib/ts.mjs tests/runtime-painel.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizarRuntime, urlsDoBot, roteiroDaTroca, podeTrocar } from '../src/lib/agente/runtime.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

console.log('\n== 1. URLs do bot ==\n');
{
  const u = urlsDoBot({ AGENTE_URL: 'https://hercules.chatyou.chat', AGENTE_WEBHOOK_TOKEN: 'tok123', N8N_WEBHOOK_BASE: 'https://webhook.chatyou.chat/webhook' }, 282);
  chk('código: <AGENTE_URL>/chatwoot/<token>/<inbox>', u.codigo === 'https://hercules.chatyou.chat/chatwoot/tok123/282', u.codigo);
  chk('n8n: <base>/<path do principal>', u.n8n === 'https://webhook.chatyou.chat/webhook/agente-lavanderia-chatwoot-teste-teste', u.n8n);
  const d = urlsDoBot({ AGENTE_LIMPEZA_URL: 'https://hercules.chatyou.chat/limpar-memoria', N8N_LIMPEZA_URL: 'https://webhook.chatyou.chat/webhook/limpar-memoria' }, 279, 'principal');
  chk('sem AGENTE_URL/N8N_WEBHOOK_BASE, deriva das URLs de limpeza; sem token, marca <WEBHOOK_TOKEN>', d.codigo === 'https://hercules.chatyou.chat/chatwoot/<WEBHOOK_TOKEN>/279' && d.n8n === 'https://webhook.chatyou.chat/webhook/principal', JSON.stringify(d));
  chk('sem caixa, a URL do código é null (o roteamento é por caixa)', urlsDoBot({ AGENTE_URL: 'https://x' }, null).codigo === null);
  chk('sem nada no ambiente, as duas são null (a tela diz o que falta)', JSON.stringify(urlsDoBot({}, 1)) === JSON.stringify({ codigo: null, n8n: null }));
}

console.log('\n== 2. A ordem da troca ==\n');
{
  const urls = { codigo: 'https://svc/chatwoot/t/1', n8n: 'https://n8n/webhook/p' };
  const ida = roteiroDaTroca('n8n', 'codigo', urls);
  chk('ida: o PRIMEIRO passo é apontar o bot para o serviço; a coluna só depois', /outgoing_url/.test(ida[0]) && /https:\/\/svc\/chatwoot\/t\/1/.test(ida[0]) && /Só depois confirme/.test(ida[1]));
  const volta = roteiroDaTroca('codigo', 'n8n', urls);
  chk('volta: o PRIMEIRO passo é confirmar aqui; a URL do n8n só depois', /Confirme aqui primeiro/.test(volta[0]) && /https:\/\/n8n\/webhook\/p/.test(volta[1]));
  chk('mesmo lado: roteiro vazio', roteiroDaTroca('codigo', 'codigo', urls).length === 0);
}

console.log('\n== 3. A regra da ação ==\n');
{
  chk('n8n -> codigo sem confirmar: recusado, citando mudo', !podeTrocar('n8n', 'codigo', false).ok && /mudo/.test(podeTrocar('n8n', 'codigo', false).motivo));
  chk('n8n -> codigo confirmando: ok', podeTrocar('n8n', 'codigo', true).ok === true);
  chk('codigo -> codigo: recusado (já está)', !podeTrocar('codigo', 'codigo', true).ok);
  chk('normalizarRuntime: null/lixo -> n8n; codigo -> codigo', normalizarRuntime(null) === 'n8n' && normalizarRuntime('x') === 'n8n' && normalizarRuntime('codigo') === 'codigo');
}

console.log('\n== 4. A tela ==\n');
{
  const lista = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/tenants/page.tsx'), 'utf8');
  const pagina = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/tenants/[id]/page.tsx'), 'utf8');
  const acoes = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/acoes.ts'), 'utf8');
  chk('a lista de clientes lê e mostra agente_runtime', /agente_runtime/.test(lista) && /<TableHead>Agente<\/TableHead>/.test(lista));
  chk('a página do cliente monta o card com urlsDoBot(process.env, …) — nunca do form', /urlsDoBot\(process\.env, tenant\.chatwoot_inbox_id\)/.test(pagina) && /<FormRuntime/.test(pagina));
  chk('a ação exige super_admin e passa por podeTrocar', /export async function definirRuntimeTenant[\s\S]{0,200}?await exigirSuperAdmin\(\)/.test(acoes) && /podeTrocar\(de, para, confirmou\)/.test(acoes));
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
