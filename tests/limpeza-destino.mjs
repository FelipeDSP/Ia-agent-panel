/**
 * "Limpar memória" vai para o serviço `agente/` — e SÓ para ele (21/09: o n8n
 * foi desligado; até então o destino seguia `agente_runtime`).
 *
 * Propriedade: sem as duas variáveis o resultado é ERRO nomeando-as — nunca
 * um "limpou" em silêncio. E a Server Action não decide destino por conta
 * própria: toda chamada passa por `invocarLimparMemoria`, que passa por
 * `resolverDestinoLimpeza`, que lê só `AGENTE_LIMPEZA_*` (nada de `N8N_*`).
 *
 *   node --import ./tests/lib/ts.mjs tests/limpeza-destino.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolverDestinoLimpeza } from '../src/lib/limpeza-memoria-destino.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

console.log('\n== 1. Um destino: o serviço ==\n');
const c = resolverDestinoLimpeza({ AGENTE_LIMPEZA_URL: 'https://agente.teste/limpar-memoria', AGENTE_LIMPEZA_SECRET: 's-agente' });
chk('AGENTE_LIMPEZA_URL + SECRET -> ok com os dois', c.ok && c.url === 'https://agente.teste/limpar-memoria' && c.segredo === 's-agente');
const soN8n = resolverDestinoLimpeza({ N8N_LIMPEZA_URL: 'https://n8n.teste/webhook/limpar', N8N_LIMPEZA_SECRET: 's-n8n' });
chk('variáveis N8N_* sozinhas NÃO servem (o lado morto não é destino)', !soN8n.ok);

console.log('\n== 2. Sem variáveis -> erro que NOMEIA as variáveis ==\n');
const sem = resolverDestinoLimpeza({});
chk('erro cita AGENTE_LIMPEZA_URL e AGENTE_LIMPEZA_SECRET', !sem.ok && /AGENTE_LIMPEZA_URL/.test(sem.motivo) && /AGENTE_LIMPEZA_SECRET/.test(sem.motivo), sem.motivo);
const vazio = resolverDestinoLimpeza({ AGENTE_LIMPEZA_URL: '   ', AGENTE_LIMPEZA_SECRET: 's' });
chk('URL só com espaços conta como ausente', !vazio.ok);
chk('só o segredo faltando também é erro', !resolverDestinoLimpeza({ AGENTE_LIMPEZA_URL: 'https://x' }).ok);

console.log('\n== 3. A Server Action passa pelo destino único ==\n');
const acoes = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/painel/conversas/acoes.ts'), 'utf8');
const chamadas = [...acoes.matchAll(/invocarLimparMemoria\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
chk('há pelo menos duas chamadas (todas / conversas) — lista vazia reprova', chamadas.length >= 2, String(chamadas.length));
chk('a ação não lê `agente_runtime` (não há mais lado a escolher)', !/agente_runtime/.test(acoes));
const lib = fs.readFileSync(path.join(RAIZ, 'src/lib/limpar-memoria.ts'), 'utf8');
chk('`invocarLimparMemoria` decide por `resolverDestinoLimpeza(process.env)` e não cita N8N_*', /resolverDestinoLimpeza\(process\.env\)/.test(lib) && !/N8N_/.test(lib));
chk('src/lib/n8n.ts não existe mais', !fs.existsSync(path.join(RAIZ, 'src/lib/n8n.ts')));

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
