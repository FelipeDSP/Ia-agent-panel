#!/usr/bin/env node
/**
 * Injeta n8n/busca-kb-consolida.js no no "Consolida Resultado" do
 * "Tool - Busca KB Multi-Tenant", e confere que o codigo resultante ao menos
 * PARSEIA antes de gravar.
 *
 * POR QUE ESTE SCRIPT EXISTE. Em 12/08/2026 escrevi esse corpo direto no JSON,
 * por dentro de template literal aninhado, e o escapamento se perdeu: os `\n`
 * viraram quebra de linha real e o no morreu com "Unterminated string constant".
 * Como `busca_conhecimento` e tool BASELINE, a busca na base parou para TODOS os
 * tenants ao mesmo tempo.
 *
 * O `new Function` no fim e a rede: um corpo que nao parseia nao chega ao JSON.
 * Ele nao executa nada — so compila.
 *
 * Uso: node scripts/gerar-tool-kb.mjs   (npm run n8n:tool-kb)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const ARQ = path.join(RAIZ, 'n8n', 'workflows', 'Tool - Busca KB Multi-Tenant.json');
const FONTE = path.join(RAIZ, 'n8n', 'busca-kb-consolida.js');

const w = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
const codigo = fs.readFileSync(FONTE, 'utf8');

const no = w.nodes.find((n) => n.name === 'Consolida Resultado');
if (!no) {
  console.error('ERRO: no "Consolida Resultado" nao existe no workflow.');
  process.exit(1);
}

// Compila o corpo como funcao para pegar erro de sintaxe — inclusive o de
// escapamento que motivou este script. `$input` e injetado como parametro so
// para o parse nao reclamar de identificador desconhecido.
try {
  // eslint-disable-next-line no-new-func
  new Function('$input', codigo);
} catch (e) {
  console.error('ERRO: busca-kb-consolida.js nao compila — ' + e.message);
  process.exit(1);
}

// O CAMINHO PRINCIPAL precisa devolver alguma coisa. Procurar "existe algum
// return" nao serve: este corpo tem um return de saida antecipada (o
// NENHUM_RESULTADO), entao apagar o return final passava na checagem — foi o que
// uma sabotagem mostrou. O que importa e a ULTIMA instrucao executavel.
const ultimaLinha = codigo
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('//'))
  .pop();

if (!/^return\s/.test(ultimaLinha ?? '')) {
  console.error(`ERRO: a ultima instrucao nao e um return — o caminho principal devolveria vazio.`);
  console.error(`      ultima instrucao: ${ultimaLinha}`);
  process.exit(1);
}

const mudou = no.parameters.jsCode !== codigo;
no.parameters.jsCode = codigo;
fs.writeFileSync(ARQ, JSON.stringify(w, null, 2) + '\n');

console.log(`Consolida Resultado ${mudou ? 'atualizado' : 'ja estava em dia'} a partir de n8n/busca-kb-consolida.js`);
console.log(`  ${codigo.split('\n').length} linhas, compila, tem return`);
