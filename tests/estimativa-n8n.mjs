/**
 * A estimativa que o código calcula ao lado do real (§5.8) é a do nó
 * `Estima Tokens` — mesmas constantes, mesma fórmula.
 *
 * Fonte ↔ derivado: as constantes são LIDAS do corpo do nó no JSON do
 * workflow (`S_POR_PERFIL`, `CRESCIMENTO_POR_CHAMADA`, `CHARS_POR_TOKEN`) e
 * comparadas com `agente/src/turno/estimativa.ts`. Se o gerador mudar o
 * número lá, este teste acusa aqui — não há segunda lista para esquecer.
 *
 * A fórmula é conferida por caso conhecido, calculado à mão a partir do
 * corpo do nó (seção 2b), não pela própria função.
 *
 *   node tests/estimativa-n8n.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S_POR_PERFIL, CRESCIMENTO_POR_CHAMADA, CHARS_POR_TOKEN, estimarComoN8n, desvioPct } from '../agente/src/turno/estimativa.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};

console.log('\n== 1. Constantes: lidas do nó, não de memória ==\n');
const w = JSON.parse(fs.readFileSync(path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json'), 'utf8'));
const no = w.nodes.find((n) => n.name === 'Estima Tokens');
chk('o nó Estima Tokens existe no JSON', !!no);
const corpo = String(no?.parameters?.jsCode ?? '');
const constante = (nome) => {
  const m = corpo.match(new RegExp(`const ${nome} = ([^;]+);`));
  return m ? m[1].trim() : null;
};
const sNo = constante('S_POR_PERFIL');
chk('S_POR_PERFIL do nó foi encontrado e não está vazio (lista vazia reprova)', !!sNo && sNo.length > 5, sNo);
let sObj = null;
try { sObj = Function(`return (${sNo})`)(); } catch { /* fica null */ }
chk('S_POR_PERFIL do código == do nó (basico E vendas)',
  sObj && Object.keys(sObj).length >= 2 && Object.keys(sObj).every((k) => S_POR_PERFIL[k] === sObj[k]) && Object.keys(S_POR_PERFIL).length === Object.keys(sObj).length,
  JSON.stringify({ no: sObj, codigo: S_POR_PERFIL }));
chk('CRESCIMENTO_POR_CHAMADA == do nó', Number(constante('CRESCIMENTO_POR_CHAMADA')) === CRESCIMENTO_POR_CHAMADA, constante('CRESCIMENTO_POR_CHAMADA'));
chk('CHARS_POR_TOKEN == do nó', Number(constante('CHARS_POR_TOKEN')) === CHARS_POR_TOKEN, constante('CHARS_POR_TOKEN'));
chk('o nó divide a memória por 4 (divergência herdada, mantida nos dois lados)', /historicoChars \/ 4\)/.test(corpo));

console.log('\n== 2. Fórmula: caso calculado à mão pela seção 2b do nó ==\n');
// wrapper 311 chars -> ceil(100.0)=100; system 62 -> ceil(19.94)=20; mensagens 10 -> ceil(3.22)=4;
// vendas 778; memória 400 chars -> 100; 2 chamadas -> tudo x2 e round_trip = 55*1 = 55.
const e = estimarComoN8n({
  perfil: 'vendas', chamadas: 2, wrapper: 'x'.repeat(311), systemPrompt: 'y'.repeat(62), mensagens: 'z'.repeat(10),
  historicoChars: 400, textoSaida: 'w'.repeat(31), // ceil(31/3.11)=ceil(9.97)=10
});
chk('componentes: wrapper 200, system 40, mensagens 8, schema 1556, memória 200, round_trip 55',
  JSON.stringify(e.componentes) === JSON.stringify({ wrapper: 200, system_prompt: 40, mensagens: 8, schema_tools: 1556, memoria: 200, round_trip: 55 }), JSON.stringify(e.componentes));
chk('entrada = soma das partes (2059); saída 10', e.entrada === 2059 && e.saida === 10, `${e.entrada}/${e.saida}`);
const b = estimarComoN8n({ perfil: 'basico', chamadas: 1, wrapper: '', systemPrompt: '', mensagens: '', historicoChars: 0, textoSaida: '' });
chk('perfil basico, 1 chamada, tudo vazio: só o schema (266), round_trip 0', b.entrada === 266 && b.componentes.round_trip === 0);
chk('perfil desconhecido cai em basico (como o nó: `?? S_POR_PERFIL.basico`)', estimarComoN8n({ ...b, perfil: 'lua', chamadas: 1, wrapper: '', systemPrompt: '', mensagens: '', historicoChars: 0, textoSaida: '' }).entrada === 266);
chk('desvioPct: 110 estimado sobre 100 real = +10.0; real 0 -> null', desvioPct(110, 100) === 10 && desvioPct(50, 0) === null);

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
