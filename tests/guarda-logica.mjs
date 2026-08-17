#!/usr/bin/env node
/**
 * A lógica da guarda, exercitada sem banco.
 *
 * `guarda-sabotagem.mjs` prova a guarda de ponta a ponta, mas precisa de
 * conexão e cria um tenant de verdade. Este roda em qualquer lugar, em
 * milissegundos, e cobre os casos de fronteira que a sabotagem contra banco
 * cobriria devagar e uma vez só.
 *
 * Os dois que mais importam são simétricos: apaga-um-cria-um (o que contagem
 * não vê) e tenant efêmero legítimo (o falso positivo que faria alguém desligar
 * a guarda na segunda semana).
 *
 * Uso: node tests/guarda-logica.mjs
 */

import { comparar, formatarRelatorio } from './lib/guarda-tenants.mjs';

let passou = 0;
const falhas = [];

/**
 * Primeira divergência, ou um objeto vazio.
 *
 * POR QUE EXISTE. As asserções abaixo liam `r.divergencias[0].mudaram` direto.
 * Quando `comparar` para de detectar alteração — o defeito que elas existem para
 * pegar — `divergencias` fica vazio e o acesso estoura `TypeError`, matando o
 * processo na terceira asserção. As outras sete não rodavam, e o exit 1 do crash
 * se parece com falha de teste o bastante para ninguém olhar duas vezes.
 *
 * É a regra do CLAUDE.md: rejeição inesperada tem que virar FALHA, não crash.
 * Verificado sabotando `comparar` — antes disto, uma das cinco sabotagens
 * "passava" por exceção em vez de por asserção vermelha.
 */
function primeira(r) {
  return r.divergencias[0] ?? { tipo: '(nenhuma)', slug: '—', sumiram: [], surgiram: [], mudaram: [] };
}

function checar(nome, ok, detalhe = '') {
  if (ok) {
    passou++;
    console.log(`  OK    ${nome}`);
  } else {
    falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`);
    console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

/** Monta um retrato de mentira: { id: slug } e { id: { chave: hash } }. */
function retrato(tenants, produtos) {
  return {
    slugs: new Map(Object.entries(tenants)),
    linhas: new Map([
      ['tenants', new Map(Object.keys(tenants).map((id) => [id, new Map([[id, `h-${id}`]])]))],
      ['produtos', new Map(Object.entries(produtos).map(([t, m]) => [t, new Map(Object.entries(m))]))],
    ]),
  };
}

console.log('\n== Lógica da guarda ==\n');

const base = retrato({ A: 'acqua-lavanderia' }, { A: { p1: 'h1' } });

{
  const r = comparar(base, retrato({ A: 'acqua-lavanderia' }, { A: { p1: 'h1' } }));
  checar('retrato idêntico não acusa nada', r.divergencias.length === 0);
}

{
  const r = comparar(base, retrato({ A: 'acqua-lavanderia' }, { A: {} }));
  checar(
    'DELETE é detectado',
    r.divergencias.length === 1 && primeira(r).sumiram.length === 1,
    `${r.divergencias.length} divergência(s)`,
  );
  checar('o relatório nomeia o tenant', formatarRelatorio(r).includes('acqua-lavanderia'));
}

{
  // Contagem igual, conteúdo diferente: o caso que motivou usar checksum.
  const r = comparar(base, retrato({ A: 'acqua-lavanderia' }, { A: { p1: 'h2' } }));
  const d = primeira(r);
  checar(
    'UPDATE é detectado e classificado como alteração',
    d.mudaram.length === 1 && d.sumiram.length === 0,
    `tipo=${d.tipo} ~${d.mudaram.length} -${d.sumiram.length}`,
  );
  // `includes('~1')` casaria com '~11' e com '~100'. Delimitado, a asserção
  // volta a ser sobre UMA alteração.
  checar('o relatório marca exatamente ~1', /\[~1\]/.test(formatarRelatorio(r)));
}

{
  // Contagem igual, conjunto diferente.
  const r = comparar(base, retrato({ A: 'acqua-lavanderia' }, { A: { p9: 'h9' } }));
  const d = primeira(r);
  checar(
    'apaga-um-cria-um é detectado',
    d.sumiram.length === 1 && d.surgiram.length === 1,
    `-${d.sumiram.length} +${d.surgiram.length}`,
  );
}

{
  const r = comparar(base, retrato({ A: 'acqua-lavanderia' }, { A: { p1: 'h1', p2: 'h2' } }));
  checar(
    'lixo deixado para trás é detectado',
    primeira(r).surgiram.length === 1,
    `+${primeira(r).surgiram.length}`,
  );
}

{
  // O padrão que a reescrita dos cinco vai usar. Não pode gerar ruído.
  const r = comparar(
    base,
    retrato({ A: 'acqua-lavanderia', Z: 'zz-efemero-abc' }, { A: { p1: 'h1' }, Z: { p9: 'h9' } }),
  );
  checar('tenant efêmero não é falso positivo', r.divergencias.length === 0);
  checar('e aparece como criado, para o operador saber', r.criados.includes('zz-efemero-abc'));
}

{
  const antes = retrato({ A: 'acqua-lavanderia', B: 'emporio' }, { A: { p1: 'h1' }, B: { p2: 'h2' } });
  const r = comparar(antes, retrato({ A: 'acqua-lavanderia' }, { A: { p1: 'h1' } }));
  checar(
    'tenant preexistente apagado dispara o alarme alto',
    r.divergencias.some((d) => d.tipo === 'TENANT APAGADO' && d.slug === 'emporio'),
  );
}

console.log(`\n  ${passou} passaram, ${falhas.length} falharam\n`);
if (falhas.length) {
  for (const f of falhas) console.log(`   - ${f}`);
  console.log('');
  process.exit(1);
}
