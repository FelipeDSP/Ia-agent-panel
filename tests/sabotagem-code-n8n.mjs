#!/usr/bin/env node
/**
 * Sabota os nós Code de propósito e confirma que o `n8n-validar` PEGA.
 *
 * POR QUE ISTO EXISTE. Em 12/08/2026 um nó Code foi para produção com o
 * escapamento perdido — os `\n` viraram quebra de linha real dentro de uma
 * string — e derrubou o `busca_conhecimento`. Como é tool BASELINE, a busca na
 * base parou para TODOS os tenants ao mesmo tempo. Nem o `n8n-validar` nem o
 * `n8n:sincronia` olhavam se o código dentro do nó era JavaScript válido.
 *
 * A checagem foi acrescentada; este arquivo é a rede DELA. Guard sem teste de
 * guard é só mais código que pode estar quebrado em silêncio — e aqui isso não é
 * hipótese: a checagem de `return` passava por baixo quando alguém comentava a
 * linha, porque a palavra continuava lá dentro do `//`. Só apareceu porque
 * existia sabotagem para ela.
 *
 * NOTA DE MANUTENÇÃO. As sabotagens são construídas com `String.fromCharCode`,
 * não com literais escapados, e este arquivo é editado como ARQUIVO, nunca
 * gerado por heredoc de shell. Montar `\\n` por heredoc colapsa para `\n` e a
 * sabotagem vira no-op que passa como se tivesse rodado — aconteceu três vezes
 * seguidas, e é a mesma classe do bug que o teste existe para pegar.
 *
 * Restaura os arquivos no fim, inclusive quando um caso falha.
 *
 * Uso: node tests/sabotagem-code-n8n.mjs   (npm run teste:sabotagem-code)
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';

const BARRA_N = String.fromCharCode(92) + 'n'; // os dois caracteres: \ e n
const NOVA_LINHA = String.fromCharCode(10);

const CASOS = [
  {
    nome: 'escape perdido (o bug real)',
    arq: 'n8n/workflows/Tool - Busca KB Multi-Tenant.json',
    no: 'Consolida Resultado',
    quebrar: (js) => js.split(BARRA_N).join(NOVA_LINHA),
  },
  {
    nome: 'return comentado',
    arq: 'n8n/workflows/agente-principal.json',
    no: 'Extrair e Filtrar',
    quebrar: (js) => js.replace(/^(\s*)return\b/gm, '$1// return'),
  },
  {
    // O no de MAIOR exposicao do repo, convertido para arquivo em 12/08. A
    // conversao e justamente o momento em que o escapamento aninhado erra: uma
    // quebra de linha dentro de string literal e o que derrubou o
    // `Consolida Resultado` e parou a busca na base de TODOS os tenants.
    nome: 'escape perdido no Extrair e Filtrar',
    arq: 'n8n/workflows/agente-principal.json',
    no: 'Extrair e Filtrar',
    quebrar: (js) => js.replace("'Integração WhatsApp'", "'Integração" + NOVA_LINHA + "WhatsApp'"),
  },
  {
    nome: 'chave a mais',
    arq: 'n8n/workflows/Tool - Transferir para Humano (Multi-Tenant).json',
    no: 'Avalia Horario',
    quebrar: (js) => js + NOVA_LINHA + '}',
  },
];

console.log('\n== Sabotagem dos nós Code ==\n');

const escaparam = [];

for (const c of CASOS) {
  const original = fs.readFileSync(c.arq, 'utf8');
  try {
    const w = JSON.parse(original);
    const no = w.nodes.find((n) => n.name === c.no);
    if (!no) {
      console.log(`  ${c.nome.padEnd(30)} NÓ AUSENTE (${c.no}) — teste desatualizado`);
      escaparam.push(`${c.nome}: nó "${c.no}" não existe mais`);
      continue;
    }

    const antes = no.parameters.jsCode;
    const depois = c.quebrar(antes);

    // Uma sabotagem que não altera nada passa como se tivesse rodado. Este é o
    // modo de falha mais perigoso de um teste de guard: ele fica verde sem ter
    // testado coisa alguma.
    if (antes === depois) {
      console.log(`  ${c.nome.padEnd(30)} NÃO APLICOU — a sabotagem não alterou o código`);
      escaparam.push(`${c.nome}: a sabotagem não chegou a aplicar`);
      continue;
    }

    no.parameters.jsCode = depois;
    fs.writeFileSync(c.arq, JSON.stringify(w, null, 2) + '\n');

    let saida = '';
    try {
      saida = execSync(`node scripts/n8n-validar.mjs "${c.arq}"`, { encoding: 'utf8' });
    } catch (e) {
      saida = (e.stdout ?? '') + (e.stderr ?? '');
    }

    const pegou = /PROBLEMA/.test(saida);
    const detalhe = (saida.match(/PROBLEMA {2}(.*)/) ?? [, ''])[1].slice(0, 60);
    console.log(`  ${c.nome.padEnd(30)} ${pegou ? 'PEGOU ' : 'PASSOU'}  ${detalhe}`);
    if (!pegou) escaparam.push(c.nome);
  } finally {
    fs.writeFileSync(c.arq, original);
  }
}

console.log('  workflows restaurados');

console.log(`\n${'-'.repeat(60)}`);
if (escaparam.length) {
  console.log(`  ${escaparam.length} sabotagem(ns) NÃO foi(ram) pega(s):`);
  for (const e of escaparam) console.log(`    - ${e}`);
  console.log('\n  O validador tem um buraco. Não importe nada antes de fechar.\n');
  process.exit(1);
}
console.log(`  ${CASOS.length} de ${CASOS.length} sabotagens pegas.\n`);
