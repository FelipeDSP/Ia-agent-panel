/**
 * A URL do Agent Bot no painel (21/09: sem "quem atende" — o n8n foi
 * desligado e todo cliente é atendido pelo serviço).
 *
 * Propriedades: a URL vem do ambiente e nunca do form; sem token sai com o
 * marcador, não vazia; a tela não expõe `agente_runtime` nem oferece troca;
 * cliente novo nasce explicitamente em `codigo` (o serviço descarta o resto);
 * e nada em src/ lê variável N8N_* nem mostra "n8n" em texto de tela.
 *
 *   node --import ./tests/lib/ts.mjs tests/runtime-painel.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { urlDoBot } from '../src/lib/agente/runtime.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

console.log('\n== 1. URL do bot ==\n');
{
  const u = urlDoBot({ AGENTE_URL: 'https://hercules.chatyou.chat', AGENTE_WEBHOOK_TOKEN: 'tok123' });
  chk('<AGENTE_URL>/chatwoot/<token> — UMA URL para todos (18/09), sem inbox', u === 'https://hercules.chatyou.chat/chatwoot/tok123', u);
  const d = urlDoBot({ AGENTE_LIMPEZA_URL: 'https://hercules.chatyou.chat/limpar-memoria' });
  chk('sem AGENTE_URL, deriva da origem de AGENTE_LIMPEZA_URL; sem token, marca <WEBHOOK_TOKEN>', d === 'https://hercules.chatyou.chat/chatwoot/<WEBHOOK_TOKEN>', d);
  chk('barra final da base não duplica', urlDoBot({ AGENTE_URL: 'https://x/', AGENTE_WEBHOOK_TOKEN: 't' }) === 'https://x/chatwoot/t');
  chk('sem nada no ambiente, null (a tela diz o que falta)', urlDoBot({}) === null);
  chk('N8N_WEBHOOK_BASE sozinho não produz URL nenhuma', urlDoBot({ N8N_WEBHOOK_BASE: 'https://n8n/webhook' }) === null);
}

console.log('\n== 2. A tela ==\n');
{
  const lista = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/tenants/page.tsx'), 'utf8');
  const pagina = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/tenants/[id]/page.tsx'), 'utf8');
  const comps = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/tenants/[id]/componentes.tsx'), 'utf8');
  const acoes = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/admin/acoes.ts'), 'utf8');
  chk('a lista de clientes não mostra mais agente_runtime', !/agente_runtime/.test(lista));
  chk('a página do cliente monta a URL com urlDoBot(process.env) — nunca do form', /urlDoBot\(process\.env\)/.test(pagina) && /<UrlDoBot/.test(pagina));
  chk('não há mais ação de troca de runtime nem form dela', !/definirRuntimeTenant/.test(acoes) && !/FormRuntime/.test(comps));
  chk('cliente novo nasce em codigo, explícito no insert', /\.from\('tenants'\)[\s\S]{0,600}?agente_runtime: 'codigo'/.test(acoes));
}

console.log('\n== 3. Nada do painel remete ao n8n como coisa viva ==\n');
{
  // Comentários de "por quê" (a forma de um jsonb, o nome de uma função) podem
  // citar a origem; o que não pode é TEXTO DE TELA ou variável N8N_* em src/.
  const arquivos = [];
  const varrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (/\.(ts|tsx)$/.test(e.name)) arquivos.push(p);
    }
  };
  varrer(path.join(RAIZ, 'src'));
  chk('varredura não está vazia (lista vazia aprovaria qualquer coisa)', arquivos.length > 50, String(arquivos.length));
  const comN8nEnv = arquivos.filter((a) => /N8N_/.test(fs.readFileSync(a, 'utf8')));
  chk('nenhum arquivo de src/ lê variável N8N_*', comN8nEnv.length === 0, comN8nEnv.map((a) => path.relative(RAIZ, a)).join(', '));
  // Texto de tela: "n8n" numa string ou entre tags JSX, fora de comentário.
  // Nomes `api_n8n_*` são identificadores de função do banco, não texto — ficam.
  const semComentario = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/api_n8n_\w+/g, 'api_fn');
  // `}` também abre texto: `{t.slug} (n8n)` é texto JSX depois de uma expressão.
  const comTexto = arquivos.filter((a) => /(['"`>}])[^'"`<\r\n]*\bn8n\b/i.test(semComentario(fs.readFileSync(a, 'utf8'))));
  chk('nenhum texto de tela cita n8n', comTexto.length === 0, comTexto.map((a) => path.relative(RAIZ, a)).join(', '));
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
