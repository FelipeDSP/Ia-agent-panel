#!/usr/bin/env node
/**
 * Limpa exports do n8n antes do commit.
 *
 * Remove pinData (payload real de webhook: telefone, nome, avatar do contato),
 * meta.instanceId e campos de runtime que so poluem o diff.
 *
 * Uso:  node scripts/n8n-limpar-export.mjs n8n/workflows/*.json
 */

import { readFileSync, writeFileSync } from 'node:fs';

const arquivos = process.argv.slice(2);

if (arquivos.length === 0) {
  console.error('uso: node scripts/n8n-limpar-export.mjs <arquivo.json> [...]');
  process.exit(1);
}

const CAMPOS_RAIZ = ['pinData', 'staticData', 'versionId', 'triggerCount', 'shared', 'tags'];

let erros = 0;

for (const caminho of arquivos) {
  let wf;
  try {
    wf = JSON.parse(readFileSync(caminho, 'utf8'));
  } catch (e) {
    console.error(`  ERRO  ${caminho}: JSON invalido — ${e.message}`);
    erros++;
    continue;
  }

  const removidos = [];

  for (const campo of CAMPOS_RAIZ) {
    if (campo in wf) {
      removidos.push(campo);
      delete wf[campo];
    }
  }

  if (wf.meta?.instanceId) {
    removidos.push('meta.instanceId');
    delete wf.meta.instanceId;
  }

  // Ordem estavel das chaves de topo: diff limpo entre exports
  const ordenado = {};
  for (const k of ['name', 'nodes', 'connections', 'settings', 'meta']) {
    if (k in wf) ordenado[k] = wf[k];
  }
  for (const k of Object.keys(wf)) {
    if (!(k in ordenado)) ordenado[k] = wf[k];
  }

  writeFileSync(caminho, JSON.stringify(ordenado, null, 2) + '\n');

  const nos = wf.nodes?.length ?? 0;
  console.log(
    `  OK    ${caminho} (${nos} nos)` +
      (removidos.length ? ` — removido: ${removidos.join(', ')}` : '')
  );
}

process.exit(erros > 0 ? 1 : 0);
