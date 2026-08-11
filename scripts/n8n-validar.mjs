#!/usr/bin/env node
/**
 * Valida um export do n8n contra os erros que ja mordreram este projeto.
 *
 * Checa:
 *   1. referencias $('Nome') a nos que nao existem      (o bug do $('Webhook1'))
 *   2. conexoes apontando para no inexistente
 *   3. queryReplacement em formato string               (o bug da virgula)
 *   4. query com multiplos statements + parametro       (extended query protocol)
 *   5. onError engolindo erro em no de log/billing
 *   6. tenant_id vindo de $fromAI                       (vazamento cross-tenant)
 *
 * Uso:  node scripts/n8n-validar.mjs n8n/workflows/*.json
 * Sai com codigo 1 se achar problema — da pra usar em CI.
 */

import { readFileSync } from 'node:fs';

const arquivos = process.argv.slice(2);
if (arquivos.length === 0) {
  console.error('uso: node scripts/n8n-validar.mjs <arquivo.json> [...]');
  process.exit(1);
}

let totalProblemas = 0;

for (const caminho of arquivos) {
  console.log(`\n${caminho}`);
  const problemas = [];

  let wf;
  try {
    wf = JSON.parse(readFileSync(caminho, 'utf8'));
  } catch (e) {
    console.log(`  ERRO: JSON invalido — ${e.message}`);
    totalProblemas++;
    continue;
  }

  const nodes = wf.nodes ?? [];
  const nomes = new Set(nodes.map((n) => n.name));
  const bruto = JSON.stringify(wf);

  // 1. referencias orfas
  const refs = new Set([...bruto.matchAll(/\$\('((?:[^'\\]|\\.)+)'\)/g)].map((m) => m[1]));
  for (const r of refs) {
    if (!nomes.has(r)) problemas.push(`referencia orfa: $('${r}') — no nao existe`);
  }

  // 2. conexoes quebradas
  for (const [origem, tipos] of Object.entries(wf.connections ?? {})) {
    if (!nomes.has(origem)) problemas.push(`conexao a partir de no inexistente: "${origem}"`);
    for (const ramos of Object.values(tipos)) {
      for (const ramo of ramos ?? []) {
        for (const c of ramo ?? []) {
          if (!nomes.has(c.node)) problemas.push(`conexao aponta para no inexistente: "${c.node}"`);
        }
      }
    }
  }

  for (const n of nodes) {
    const p = n.parameters ?? {};

    // 3. queryReplacement precisa ser array
    const qr = p.options?.queryReplacement;
    if (typeof qr === 'string' && qr.trim() && !/^=\{\{\s*\[/.test(qr.trim())) {
      problemas.push(`"${n.name}": queryReplacement em string — use array ={{ [ ... ] }}`);
    }

    // 4. multiplos statements com parametro
    if (typeof p.query === 'string' && qr) {
      const semComentario = p.query
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .trim()
        .replace(/;\s*$/, '');
      if (semComentario.includes(';')) {
        problemas.push(`"${n.name}": query com multiplos statements + parametro`);
      }
    }

    // 5. onError engolindo erro onde nao deve
    if (n.onError === 'continueRegularOutput' && /log|registra|billing|consumo/i.test(n.name)) {
      problemas.push(`"${n.name}": onError engolindo erro em no de log/billing`);
    }

    // 6. tenant_id vindo do modelo
    const inputs = p.workflowInputs?.value ?? {};
    for (const [campo, valor] of Object.entries(inputs)) {
      if (/tenant_id|conversation_id|account_id/.test(campo) && String(valor).includes('$fromAI')) {
        problemas.push(`"${n.name}": ${campo} vindo de $fromAI — vazamento cross-tenant`);
      }
    }
  }

  if (problemas.length === 0) {
    console.log(`  OK — ${nodes.length} nos, nenhum problema conhecido`);
  } else {
    for (const p of problemas) console.log(`  PROBLEMA  ${p}`);
    totalProblemas += problemas.length;
  }
}

console.log(
  totalProblemas === 0
    ? '\nTudo certo.'
    : `\n${totalProblemas} problema(s). Corrija antes de importar.`
);
process.exit(totalProblemas > 0 ? 1 : 0);
