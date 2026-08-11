#!/usr/bin/env node
/**
 * Conversão reais <-> centavos (src/lib/vendas/dinheiro.ts).
 *
 * É a borda onde o dinheiro entra: o cliente digita "24,90" e o banco guarda
 * 2490. Erro aqui é centavo perdido em todo pedido daquele produto, e o sintoma
 * só aparece somando o pedido — longe da causa.
 *
 * Não precisa de banco nem de rede. Importa o .ts direto: o Node 22.18+ faz
 * type stripping nativo, e o módulo é puro justamente para permitir isto.
 *
 * Uso: node tests/dinheiro.mjs
 */

import { centavosParaReais, formatarBRL, parsearPrecoParaCentavos } from '../src/lib/vendas/dinheiro.ts';

let passou = 0;
const falhas = [];

function eq(rotulo, obtido, esperado) {
  const ok = obtido === esperado;
  if (ok) passou++;
  else falhas.push(`${rotulo}: esperava ${JSON.stringify(esperado)}, veio ${JSON.stringify(obtido)}`);
  console.log(`  ${ok ? 'OK   ' : 'FALHA'} ${rotulo}`);
}

function centavos(entrada) {
  const r = parsearPrecoParaCentavos(entrada);
  return r.ok ? r.centavos : `ERRO(${r.erro})`;
}

function recusa(entrada) {
  return parsearPrecoParaCentavos(entrada).ok === false;
}

console.log('\n== Conversão de dinheiro ==\n');

console.log('  -- vírgula decimal (como o brasileiro digita) --');
eq('"24,90"', centavos('24,90'), 2490);
eq('"24,9" completa o centavo', centavos('24,9'), 2490);
eq('"0,05"', centavos('0,05'), 5);
eq('"1000,00"', centavos('1000,00'), 100000);

console.log('  -- ponto decimal (como o teclado numérico produz) --');
eq('"24.90"', centavos('24.90'), 2490);
eq('"24.9"', centavos('24.9'), 2490);

console.log('  -- sem separador --');
eq('"24" são 24 reais, não 24 centavos', centavos('24'), 2400);
eq('"0"', centavos('0'), 0);

console.log('  -- milhar --');
eq('"1.234,56" (pt-BR)', centavos('1.234,56'), 123456);
eq('"1,234.56" (en-US)', centavos('1,234.56'), 123456);
eq('"1.234" é mil duzentos e trinta e quatro', centavos('1.234'), 123400);
eq('"1.234.567"', centavos('1.234.567'), 123456700);
eq('"1,234,567"', centavos('1,234,567'), 123456700);

console.log('  -- ruído que o cliente cola junto --');
eq('"R$ 24,90"', centavos('R$ 24,90'), 2490);
eq('"r$24,90"', centavos('r$24,90'), 2490);
eq('" 24,90 "', centavos(' 24,90 '), 2490);

console.log('  -- recusas --');
eq('vazio', recusa(''), true);
eq('só espaços', recusa('   '), true);
eq('texto', recusa('abc'), true);
eq('negativo', recusa('-10'), true);
eq('3 casas decimais não arredonda em silêncio', recusa('24,904'), true);
eq('duas vírgulas decimais', recusa('24,90,5'), true);
eq('acima do limite', recusa('99999999999'), true);
eq('milhar mal agrupado "1.23.456"', recusa('1.23.456'), true);
eq('milhar mal agrupado "12,34,567"', recusa('12,34,567'), true);
eq('"1.2345" não vira milhar', recusa('1.2345'), true);

console.log('  -- precisão: o clássico do float --');
// parseFloat('0.29') * 100 === 28.999999999999996
eq('"0,29" não vira 28', centavos('0,29'), 29);
eq('"1,10" não vira 109', centavos('1,10'), 110);
eq('"8,70" não vira 869', centavos('8,70'), 870);
{
  let todosInteiros = true;
  for (let i = 0; i < 1000; i++) {
    const reais = (i / 100).toFixed(2).replace('.', ',');
    const r = parsearPrecoParaCentavos(reais);
    if (!r.ok || r.centavos !== i) todosInteiros = false;
  }
  eq('0,00 a 9,99 fecham exatos (1000 valores)', todosInteiros, true);
}

console.log('  -- ida e volta --');
eq('2490 -> "24,90"', centavosParaReais(2490), '24,90');
eq('5 -> "0,05"', centavosParaReais(5), '0,05');
eq('0 -> "0,00"', centavosParaReais(0), '0,00');
eq('100000 -> "1000,00"', centavosParaReais(100000), '1000,00');
{
  let idaEVolta = true;
  for (const c of [0, 1, 5, 99, 100, 999, 2490, 123456, 999999999]) {
    const r = parsearPrecoParaCentavos(centavosParaReais(c));
    if (!r.ok || r.centavos !== c) idaEVolta = false;
  }
  eq('centavos -> texto -> centavos preserva o valor', idaEVolta, true);
}

console.log('  -- exibição --');
eq('formatarBRL(2490)', formatarBRL(2490).replace(/ /g, ' '), 'R$ 24,90');
eq('formatarBRL(123456)', formatarBRL(123456).replace(/ /g, ' '), 'R$ 1.234,56');
eq('formatarBRL(0)', formatarBRL(0).replace(/ /g, ' '), 'R$ 0,00');

console.log(`\n${'-'.repeat(56)}`);
console.log(`  ${passou} passaram, ${falhas.length} falharam`);
if (falhas.length) {
  console.log('\n  FALHAS:');
  for (const f of falhas) console.log(`    - ${f}`);
  process.exit(1);
}
console.log('\n  Conversão de dinheiro confirmada.\n');
