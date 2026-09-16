/**
 * "Limpar memória" vai para o lado que ATENDE o tenant (§5.6 do desenho).
 *
 * Propriedade: o destino é função de `agente_runtime`, e um runtime sem as
 * suas duas variáveis dá ERRO nomeando-as — nunca cai em silêncio no outro
 * lado (mandar para o n8n a limpeza de um tenant em código responde 200 e
 * não limpa nada; é o falso "limpou" que o cliente não tem como notar).
 *
 * Também varre a Server Action: ela precisa LER `agente_runtime` e passar
 * `runtime` nas duas chamadas — uma chamada sem `runtime` compila (o tipo é
 * `unknown`) e cairia em `n8n` para todo mundo.
 *
 *   node tests/limpeza-destino.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolverDestinoLimpeza, normalizarRuntime } from '../src/lib/limpeza-memoria-destino.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

const ENV = {
  N8N_LIMPEZA_URL: 'https://n8n.teste/webhook/limpar', N8N_LIMPEZA_SECRET: 's-n8n',
  AGENTE_LIMPEZA_URL: 'https://agente.teste/limpar-memoria', AGENTE_LIMPEZA_SECRET: 's-agente',
};

console.log('\n== 1. O destino segue o runtime ==\n');
const n = resolverDestinoLimpeza('n8n', ENV);
chk('n8n -> URL e segredo do n8n', n.ok && n.url === ENV.N8N_LIMPEZA_URL && n.segredo === 's-n8n' && n.runtime === 'n8n');
const c = resolverDestinoLimpeza('codigo', ENV);
chk('codigo -> URL e segredo do AGENTE', c.ok && c.url === ENV.AGENTE_LIMPEZA_URL && c.segredo === 's-agente' && c.runtime === 'codigo');
chk('os dois destinos são DIFERENTES (contraprova: o teste não passaria com um só)', n.ok && c.ok && n.url !== c.url && n.segredo !== c.segredo);
chk('null / desconhecido -> n8n (default da coluna)', normalizarRuntime(null) === 'n8n' && normalizarRuntime('lua') === 'n8n' && normalizarRuntime(undefined) === 'n8n');

console.log('\n== 2. Runtime sem variáveis -> erro que NOMEIA as variáveis, nunca o outro lado ==\n');
const semAgente = resolverDestinoLimpeza('codigo', { N8N_LIMPEZA_URL: ENV.N8N_LIMPEZA_URL, N8N_LIMPEZA_SECRET: 's-n8n' });
chk('codigo sem AGENTE_* -> erro citando AGENTE_LIMPEZA_URL e AGENTE_LIMPEZA_SECRET (mesmo com N8N_* presentes)',
  !semAgente.ok && /AGENTE_LIMPEZA_URL/.test(semAgente.motivo) && /AGENTE_LIMPEZA_SECRET/.test(semAgente.motivo), semAgente.motivo);
const semN8n = resolverDestinoLimpeza('n8n', { AGENTE_LIMPEZA_URL: ENV.AGENTE_LIMPEZA_URL, AGENTE_LIMPEZA_SECRET: 's-agente' });
chk('n8n sem N8N_* -> erro citando N8N_LIMPEZA_URL e N8N_LIMPEZA_SECRET', !semN8n.ok && /N8N_LIMPEZA_URL/.test(semN8n.motivo) && /N8N_LIMPEZA_SECRET/.test(semN8n.motivo));
const vazio = resolverDestinoLimpeza('codigo', { AGENTE_LIMPEZA_URL: '   ', AGENTE_LIMPEZA_SECRET: 's' });
chk('URL só com espaços conta como ausente', !vazio.ok);

console.log('\n== 3. A Server Action lê o runtime e o passa em TODA chamada ==\n');
const acoes = fs.readFileSync(path.join(RAIZ, 'src/app/(app)/painel/conversas/acoes.ts'), 'utf8');
const chamadas = [...acoes.matchAll(/invocarLimparMemoria\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
chk('há pelo menos duas chamadas (todas / conversas) — lista vazia reprova', chamadas.length >= 2, String(chamadas.length));
chk('TODA chamada passa `runtime`', chamadas.length > 0 && chamadas.every((c) => /\bruntime\b/.test(c)), chamadas.map((c) => /\bruntime\b/.test(c)).join(','));
chk('o runtime vem de `tenants.agente_runtime` lido do banco', /from\('tenants'\)[\s\S]{0,80}select\('agente_runtime'\)/.test(acoes));
const n8nTs = fs.readFileSync(path.join(RAIZ, 'src/lib/n8n.ts'), 'utf8');
chk('`invocarLimparMemoria` decide por `resolverDestinoLimpeza` (não lê N8N_LIMPEZA_URL direto)',
  /resolverDestinoLimpeza\(params\.runtime/.test(n8nTs) && !/process\.env\.N8N_LIMPEZA_URL/.test(n8nTs));

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
