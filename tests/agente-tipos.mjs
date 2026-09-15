#!/usr/bin/env node
/**
 * teste:agente-tipos — `tsc --noEmit` sobre `agente/src`, com o tsconfig do
 * serviço. Node 24 roda o TypeScript sem checar tipo nenhum; isto é o que
 * checa. O runner da suíte exige `node ...`, por isso o tsc é disparado daqui.
 *
 * Uso: npm run teste:agente-tipos
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AG = path.join(RAIZ, 'agente');
const tsc = path.join(AG, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tsc)) {
  console.log('  FALHA agente/node_modules sem typescript — rode `npm --prefix agente install`');
  process.exit(1);
}
const r = spawnSync(process.execPath, [tsc, '-p', path.join(AG, 'tsconfig.json')], { cwd: AG, encoding: 'utf8' });
const saida = (r.stdout + r.stderr).trim();
const arquivos = fs.readdirSync(path.join(AG, 'src'), { recursive: true }).filter((f) => String(f).endsWith('.ts')).length;
if (r.status === 0) {
  console.log(`  OK    tsc --noEmit sobre agente/src (${arquivos} arquivos .ts) sem erro`);
  console.log('\n  1 passaram, 0 falharam');
  process.exit(0);
}
console.log(`  FALHA tsc reprovou:\n${saida}`);
console.log('\n  0 passaram, 1 falharam');
process.exit(1);
