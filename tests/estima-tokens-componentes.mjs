#!/usr/bin/env node
/**
 * A DECOMPOSIÇÃO QUE O NÓ EMITE SOMA O TOTAL QUE ELE GRAVA?
 *
 * A migração 42 grava `tokens_entrada` e os seis componentes em colunas
 * separadas. Quem garante que eles fecham é este arquivo: a função em SQL
 * **não** valida a soma de propósito — levantar exceção no caminho quente
 * derrubaria a mensagem de um cliente real por causa de aritmética.
 *
 * Sem esta prova, a quebra seria silenciosa e só apareceria meses depois, na
 * primeira conta rateada por componente — quando já não houvesse como saber
 * quais linhas estavam certas.
 *
 * Não toca no banco e não chama o n8n: executa o corpo do nó Code com `$input`
 * e `$()` dublados, exatamente como o n8n o executa.
 *
 * Uso: npm run teste:componentes-no
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const FONTE = RAIZ + 'n8n/estima-tokens.js';

let ok = 0;
const falhas = [];
const chk = (n, c, d = '') => {
  if (c) { ok++; console.log(`  OK    ${n}`); }
  else { falhas.push(`${n}${d ? ' — ' + d : ''}`); console.log(`  FALHA ${n}${d ? ' — ' + d : ''}`); }
};

/**
 * Roda o corpo do nó. `nos` dubla o que `$('Nome')` devolve; um nome ausente
 * LEVANTA, como no n8n de verdade — é o que faz o `_faltou` do nó ter sentido.
 */
function rodar(src, { agent, nos }) {
  const $input = { first: () => ({ json: agent }) };
  const $ = (nome) => {
    if (!(nome in nos)) throw new Error(`No node named '${nome}'`);
    return { first: () => ({ json: nos[nome] }), all: () => [{ json: nos[nome] }] };
  };
  return new Function('$input', '$', src)($input, $)[0].json;
}

const preparar = (src) =>
  src
    .replace('__WRAPPERS__', JSON.stringify({ vendas: 'W'.repeat(3767), basico: 'W'.repeat(1952) }))
    .replace('__PERFIS_S__', JSON.stringify({ vendas: 622, basico: 266 }));

const SRC = preparar(fs.readFileSync(FONTE, 'utf8'));

// Cenário calcado no Empório medido em 17/08: perfil vendas, prompt de 12.206
// caracteres, dois turnos por chamada. Não é número inventado — é o caso que
// motivou a decomposição.
const CENARIO = {
  agent: { output: 'resposta ao cliente', intermediateSteps: [{ action: { tool: 'consultar_catalogo' }, observation: 'ok' }] },
  nos: {
    'Tools Ativas': { perfil: 'vendas' },
    'Resolve Tenant': { system_prompt: 'P'.repeat(12206) },
    'Lista Depois': { lista_depois: ['quero ver o catálogo'] },
    'Sync Conversa': { historico_chars: 3200 },
  },
};

console.log('\n== Componentes do nó Estima Tokens ==\n');

const r = rodar(SRC, CENARIO);
const comp = JSON.parse(r.componentes_json);

const soma = comp.wrapper + comp.system_prompt + comp.schema_tools
           + comp.mensagens + comp.memoria + comp.round_trip;

chk('o nó emite componentes_json como STRING (o $10::jsonb espera texto)',
  typeof r.componentes_json === 'string', typeof r.componentes_json);
chk('a soma dos componentes é EXATAMENTE tokens_entrada',
  soma === r.tokens_entrada, `soma ${soma} vs total ${r.tokens_entrada}`);
chk('chamadas = 1 + intermediateSteps', comp.chamadas === 2, String(comp.chamadas));
chk('a fonte não se diz da API', /^estimativa_/.test(comp.fonte) && !/api|fatura/.test(comp.fonte), comp.fonte);
chk('nenhuma classificação de rateio vaza para o nó',
  !Object.keys(comp).some((k) => /cliente|agencia|rateio|cobrav/i.test(k)), Object.keys(comp).join(','));

// O componente que motivou tudo: o prompt do tenant, multiplicado pelas chamadas.
chk('o system_prompt é o maior componente neste cenário',
  comp.system_prompt > comp.wrapper && comp.system_prompt > comp.memoria,
  JSON.stringify(comp));
chk('e ele escala com as chamadas (2x o de uma chamada só)',
  comp.system_prompt === 2 * Math.ceil(12206 / 3.11),
  `${comp.system_prompt} vs ${2 * Math.ceil(12206 / 3.11)}`);

// Turno sem tool: uma chamada, sem crescimento de round-trip.
const semTool = rodar(SRC, { ...CENARIO, agent: { output: 'oi', intermediateSteps: [] } });
const compST = JSON.parse(semTool.componentes_json);
chk('turno de 1 chamada não tem round_trip', compST.round_trip === 0, String(compST.round_trip));
chk('e a soma continua fechando',
  compST.wrapper + compST.system_prompt + compST.schema_tools + compST.mensagens
  + compST.memoria + compST.round_trip === semTool.tokens_entrada);
chk('1 chamada custa perto da metade de 2 (a multiplicidade é o dobro)',
  Math.abs(semTool.tokens_entrada * 2 - r.tokens_entrada) < 200,
  `${semTool.tokens_entrada} x2 vs ${r.tokens_entrada}`);

// -------------------------------------------------------------------------
console.log('\n-- Sabotagem --\n');

// A INVARIANTE DA SOMA NÃO BASTA, e as duas primeiras tentativas mostraram isso
// na prática: com o total DERIVADO das partes, encolher uma parte encolhe o
// total junto e a soma continua fechando. Ela pega componente EXCLUÍDO da soma
// e não pega componente com valor errado. Por isso cada sabotagem tem detector
// próprio, comparado com uma expectativa calculada aqui — independente da
// implementação, senão a asserção viraria tautologia.
const CHAMADAS = 2;
const sabotagens = [
  ['round_trip fora da soma',
    (s) => s.replace('comp_wrapper + comp_system_prompt + comp_mensagens + comp_schema_tools + comp_memoria + comp_round_trip',
                     'comp_wrapper + comp_system_prompt + comp_mensagens + comp_schema_tools + comp_memoria'),
    (x, c) => {
      const soma = c.wrapper + c.system_prompt + c.schema_tools + c.mensagens + c.memoria + c.round_trip;
      return soma !== x.tokens_entrada;
    },
    'a soma deixa de bater com o total'],
  ['memória contada uma vez em vez de por chamada',
    (s) => s.replace('const comp_memoria = chamadas * Math.ceil(historicoChars / 4);',
                     'const comp_memoria = Math.ceil(historicoChars / 4);'),
    (x, c) => c.memoria !== CHAMADAS * Math.ceil(3200 / 4),
    'a memória do turno fica pela metade'],
  ['prompt do tenant não multiplicado pelas chamadas',
    (s) => s.replace('const comp_system_prompt = chamadas * emTokens(systemPrompt);',
                     'const comp_system_prompt = emTokens(systemPrompt);'),
    (x, c) => c.system_prompt !== CHAMADAS * Math.ceil(12206 / 3.11),
    'o maior componente do Empório fica pela metade'],
];

let semEfeito = 0;
for (const [nome, mutar, detecta, oQue] of sabotagens) {
  const mutado = mutar(SRC);
  if (mutado === SRC) {
    semEfeito++;
    chk(`sabotagem "${nome}" MUTOU a fonte`, false, 'o replace não casou — não testou nada');
    continue;
  }
  let pegou = false;
  try {
    const x = rodar(mutado, CENARIO);
    pegou = detecta(x, JSON.parse(x.componentes_json));
  } catch {
    // Rejeição inesperada é detecção, não crash do processo.
    pegou = true;
  }
  chk(`sabotagem "${nome}" é detectada (${oQue})`, pegou);
}
chk('toda sabotagem realmente mutou a fonte', semEfeito === 0, `${semEfeito} não mutaram`);

console.log('\n' + '-'.repeat(58));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();
process.exitCode = falhas.length > 0 ? 1 : 0;
