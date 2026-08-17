#!/usr/bin/env node
/**
 * O critério de aceitação da reescrita, como teste.
 *
 * `docs/PENDENCIA-SEED-DOS-TESTES.md` fixou a frase: **apagar seed nenhum
 * consegue deixá-los verdes.** Não basta reprovar quando o seed falta — o alvo
 * é não ter seed para faltar. Isto aqui é a verificação permanente dessa frase.
 *
 * É CHECAGEM ESTÁTICA, de propósito. A prova comportamental (soft-deletar os
 * três seeds e rodar os cinco) foi feita uma vez, à mão, e está registrada na
 * pendência — mas não pode virar suíte: ela apaga tenant de produção a cada
 * execução, e um teste que precisa fazer isso para se provar é pior do que o
 * defeito que evita. A checagem estática dá a mesma garantia sem tocar em nada,
 * e roda em milissegundos.
 *
 * O que ela impede na prática: o próximo teste de isolamento voltar a resolver
 * tenant por slug de seed porque "já estava assim nos outros".
 *
 * Uso: node tests/seed-independente.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));

/**
 * Os slugs que alguém pode apagar pelo painel. Lista fixa E declarada: se
 * aparecer um seed novo, ele entra aqui de propósito, não por descuido.
 */
const SLUGS_DE_SEED = ['restaurante-teste', 'sandbox-de-testes', 'clinica-teste', 'acqua-lavanderia'];

/**
 * Os cinco reescritos. Lista explícita e não varredura de diretório: varrer
 * faria o teste passar sozinho no dia em que alguém renomeasse um arquivo, e
 * "nenhum arquivo casou" é o falso verde mais fácil de escrever.
 */
const REESCRITOS = [
  'tests/isolamento-fase2.mjs',
  'tests/isolamento-modulos.mjs',
  'tests/isolamento-produtos.mjs',
  'tests/isolamento-pedidos.mjs',
  'tests/isolamento-fotos.mjs',
];

let passou = 0;
const falhas = [];

function checar(nome, ok, detalhe = '') {
  if (ok) {
    passou++;
    console.log(`  OK    ${nome}`);
  } else {
    falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`);
    console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

/** Tira comentários antes de procurar: citar o slug ao EXPLICAR a regra é legítimo. */
function codigo(fonte) {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

console.log('\n== Os testes de isolamento independem do seed? ==\n');

for (const rel of REESCRITOS) {
  const caminho = path.join(RAIZ, rel);
  let fonte;
  try {
    fonte = readFileSync(caminho, 'utf8');
  } catch {
    checar(`${rel} existe`, false, 'arquivo não encontrado — a lista está desatualizada');
    continue;
  }

  const corpo = codigo(fonte);
  const citados = SLUGS_DE_SEED.filter((slug) => corpo.includes(slug));
  checar(
    `${rel.replace('tests/', '')}: não resolve tenant por slug de seed`,
    citados.length === 0,
    citados.length ? `cita ${citados.join(', ')} fora de comentário` : '',
  );

  checar(
    `${rel.replace('tests/', '')}: cria os próprios tenants`,
    corpo.includes('criarTenantsEfemeros'),
    'não chama criarTenantsEfemeros',
  );

  checar(
    `${rel.replace('tests/', '')}: remove os próprios tenants`,
    corpo.includes('removerTenantsEfemeros'),
    'não chama removerTenantsEfemeros — sobra tenant em produção',
  );
}

// A sabotagem que o resto do repo aprendeu a exigir: a checagem acima só vale se
// conseguir enxergar um slug plantado. Sem isto, um erro no regex de comentário
// deixaria tudo verde para sempre.
{
  const fingido = codigo(`
    // este comentário cita restaurante-teste e NÃO deve contar
    const x = 'clinica-teste';
  `);
  checar(
    'a varredura ignora comentário e enxerga código',
    !fingido.includes('restaurante-teste') && fingido.includes('clinica-teste'),
    `comentário=${fingido.includes('restaurante-teste')} código=${fingido.includes('clinica-teste')}`,
  );
}

console.log(`\n${'-'.repeat(60)}`);
console.log(`  ${passou} passaram, ${falhas.length} falharam\n`);
if (falhas.length) {
  for (const f of falhas) console.log(`   - ${f}`);
  console.log('');
  process.exitCode = 1;
}
