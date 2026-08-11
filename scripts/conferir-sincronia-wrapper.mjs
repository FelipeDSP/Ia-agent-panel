#!/usr/bin/env node
/**
 * Confere que o `System Message` do AI Agent e a constante `WRAPPER` do no
 * `Estima Tokens` sao o MESMO texto.
 *
 * Se divergirem, nada quebra visivelmente — o agente continua respondendo. O que
 * acontece e o rateio de custo por tenant mentir, em silencio, para sempre. Foi
 * o que ja aconteceu quando `resolver_conversa` entrou: a secao dela foi para o
 * AI Agent e nao para o WRAPPER.
 *
 * Uso: node scripts/conferir-sincronia-wrapper.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const w = JSON.parse(fs.readFileSync(path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json'), 'utf8'));

const sm = w.nodes.find((n) => n.name === 'AI Agent').parameters.options.systemMessage;
const code = w.nodes.find((n) => n.name === 'Estima Tokens').parameters.jsCode;

const ini = code.indexOf('const WRAPPER = `');
const fim = code.indexOf('`;', ini);
const wrapper = code
  .slice(ini + 'const WRAPPER = `'.length, fim)
  .replace(/\\`/g, '`')
  .replace(/\\\$\{/g, '${')
  .replace(/\\\\/g, '\\');

const fixo = sm.slice(1, sm.indexOf('{{'));

const mem = w.nodes.find((n) => n.name === 'Redis Chat Memory');
const tools = Object.entries(w.connections).filter(([, v]) => v.ai_tool).map(([k]) => k);
const tokens = (code.match(/TOKENS_FERRAMENTAS = (\d+)/) || [])[1];

console.log(`  systemMessage (parte fixa) : ${fixo.length} chars`);
console.log(`  WRAPPER (Estima Tokens)    : ${wrapper.length} chars`);
console.log(`  IDENTICOS                  : ${fixo === wrapper ? 'SIM' : 'NAO'}`);
console.log(`  contextWindowLength        : ${mem.parameters.contextWindowLength ?? '(default 5)'}`);
console.log(`  TOKENS_FERRAMENTAS         : ${tokens}`);
console.log(`  tools ligadas ao AI Agent  : ${tools.length}`);
tools.forEach((t) => console.log(`      - ${t}`));

if (fixo !== wrapper) {
  // Mostra onde comeca a divergir, senao o diff de 2 mil chars nao ajuda.
  let i = 0;
  while (i < Math.min(fixo.length, wrapper.length) && fixo[i] === wrapper[i]) i++;
  console.log(`\n  Divergem a partir do char ${i}:`);
  console.log(`    systemMessage: ${JSON.stringify(fixo.slice(i, i + 90))}`);
  console.log(`    WRAPPER      : ${JSON.stringify(wrapper.slice(i, i + 90))}`);
  process.exit(1);
}
console.log('\n  Sincronizados.');
