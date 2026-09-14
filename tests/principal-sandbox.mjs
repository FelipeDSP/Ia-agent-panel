#!/usr/bin/env node
/**
 * teste:principal-sandbox — a variante do principal para a cópia do sendbox é
 * DERIVADA, e difere do principal em exatamente dois campos.
 *
 * O que ele mede:
 *   1. o arquivo gravado é byte a byte o que `derivar(principal)` devolve — se
 *      o principal mudar e ninguém regerar, fica vermelho (é o par
 *      fonte↔derivado, e a guarda é a comparação, não a memória);
 *   2. a diferença é SÓ `Webhook.parameters.path` e `name`; qualquer outro
 *      campo diferente é edição à mão na variante;
 *   3. o path é o que o bot Hércules chama, e não o do principal — importar
 *      com o path do principal faz o n8n recusar ativar a cópia;
 *   4. sabotagem: mudar um parâmetro só na variante (mesmo comprimento) e exigir
 *      que 1 e 2 reprovem, com md5 antes/depois.
 *
 * Uso: npm run teste:principal-sandbox
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DESTINO, ORIGEM, PATH_SANDBOX, SUFIXO_NOME, derivar, serializar } from '../scripts/derivar-principal-sandbox.mjs';

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 12);

/** Caminhos (nó.campo) em que dois workflows diferem, fora posição/id. */
function diferencas(a, b) {
  const out = [];
  if (a.name !== b.name) out.push('name');
  const na = new Map(a.nodes.map((n) => [n.name, n]));
  const nb = new Map(b.nodes.map((n) => [n.name, n]));
  for (const k of new Set([...na.keys(), ...nb.keys()])) {
    const x = na.get(k); const y = nb.get(k);
    if (!x || !y) { out.push(`nó ${k}`); continue; }
    for (const campo of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (campo === 'parameters') {
        for (const p of new Set([...Object.keys(x.parameters ?? {}), ...Object.keys(y.parameters ?? {})])) {
          if (JSON.stringify(x.parameters?.[p]) !== JSON.stringify(y.parameters?.[p])) out.push(`${k}.parameters.${p}`);
        }
      } else if (JSON.stringify(x[campo]) !== JSON.stringify(y[campo])) out.push(`${k}.${campo}`);
    }
  }
  if (JSON.stringify(a.connections) !== JSON.stringify(b.connections)) out.push('connections');
  return out;
}

console.log('\n== 1. A variante gravada é a derivação do principal ==\n');
const principal = JSON.parse(fs.readFileSync(ORIGEM, 'utf8'));
const gravado = fs.readFileSync(DESTINO, 'utf8');
const esperado = serializar(derivar(principal));
chk('agente-principal.sandbox.json == derivar(agente-principal.json), byte a byte',
  gravado === esperado, `md5 gravado ${md5(gravado)} vs derivado ${md5(esperado)} — rode node scripts/derivar-principal-sandbox.mjs`);

console.log('\n== 2. Difere em exatamente dois campos ==\n');
const variante = JSON.parse(gravado);
const difs = diferencas(principal, variante);
chk('as diferenças são SÓ name e Webhook.parameters.path',
  JSON.stringify([...difs].sort()) === JSON.stringify(['Webhook.parameters.path', 'name']), difs.join(', '));
const wh = variante.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
chk(`o path é /${PATH_SANDBOX} (o que o Hércules chama), não o do principal`,
  wh.parameters.path === PATH_SANDBOX && wh.parameters.path !== principal.nodes.find((n) => n.type === 'n8n-nodes-base.webhook').parameters.path);
chk('o name tem o sufixo de sandbox (para o n8n:diff não confundir as duas)',
  variante.name === principal.name + SUFIXO_NOME);
chk('mesmas credenciais nos mesmos nós (o import por cima resolve pelo id)',
  JSON.stringify(principal.nodes.map((n) => [n.name, n.credentials ?? null])) === JSON.stringify(variante.nodes.map((n) => [n.name, n.credentials ?? null])));

console.log('\n== 3. SABOTAGEM: edição à mão na variante ==\n');
{
  const alvo = '"maxItems": 1';
  const n = gravado.split(alvo).length - 1;
  if (n !== 1) chk('S1 localizou o alvo', false, `${n}x`);
  else {
    // mesmo comprimento: o que prova é o md5
    const mutado = gravado.split(alvo).join('"maxItems": 2');
    console.log(`     [mutou "maxItems 1 -> 2" só na variante: md5 ${md5(gravado)} -> ${md5(mutado)}]`);
    const v2 = JSON.parse(mutado);
    chk('S1: a comparação byte a byte reprova', mutado !== esperado);
    const d2 = diferencas(principal, v2);
    chk('S1: a lista de diferenças acusa o campo editado', d2.includes('Volta a Um Item.parameters.maxItems'), d2.join(', '));
  }
}

console.log(`\n${'-'.repeat(62)}`);
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
if (falhas.length) { for (const f of falhas) console.log(`    - ${f}`); process.exit(1); }
