#!/usr/bin/env node
/**
 * A aritmética da tela de consumo — e a sabotagem que prova que as asserções
 * conseguem reprovar.
 *
 * O QUE ESTE ARQUIVO GUARDA. `src/lib/billing/consumo.ts` decide o que aparece
 * em `/admin/consumo`: qual é o mês corrente, a comparação com o anterior, a
 * ordem dos cards e o preenchimento de buraco no histórico. Nenhum desses casos
 * é visto abrindo a tela — o que quebra é a virada de ano, o mês anterior
 * zerado e o cliente que parou, e nenhum deles está na tela hoje.
 *
 * TUDO AQUI É PROPRIEDADE, NÃO ESTADO DO MUNDO. Nada consulta o banco. As
 * entradas são fixtures escritas à mão; "o Empório gastou 50 tokens" seria
 * verdade hoje e falsa amanhã, e teste que fica vermelho porque alguém usou o
 * sistema é a forma mais rápida de todo mundo parar de olhar a suíte.
 *
 * IMPORTA A FONTE em TypeScript (ver tests/lib/resolver-ts.mjs). Reimplementar
 * a regra aqui produziria um teste que concorda consigo mesmo para sempre.
 *
 * A SEÇÃO 5 É O MOTIVO DE O RESTO VALER ALGUMA COISA. Ela reescreve o módulo
 * com defeitos de propósito, reimporta e exige que alguma asserção reprove. Sem
 * ela, este arquivo seria mais uma asserção comprando confiança sem conseguir
 * falhar — já houve seis numa semana. Cada sabotagem confere o md5 antes/depois:
 * "rodou e não falhou" com a mutação que não aplicou já aconteceu duas vezes.
 *
 * Uso: npm run teste:consumo
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const FONTE = path.join(RAIZ, 'src', 'lib', 'billing', 'consumo.ts');

const mod = await import('../src/lib/billing/consumo.ts');
const {
  FRACAO_MES_PARA_QUEDA,
  LIMIAR_VARIACAO_PCT,
  LIMIAR_VARIACAO_USD,
  PCT_VIRA_MULTIPLICADOR,
  classificarVariacao,
  formatarUsd,
  fracaoDoMes,
  historicoDoTenant,
  mesAnteriorDe,
  mesCorrente,
  montarVisaoMensal,
  rotuloMes,
} = mod;

/**
 * Atalho para os casos em que só o CUSTO importa: presença é inferida do próprio
 * custo (>0 = usou). Os casos em que token e custo DIVERGEM — que é o defeito
 * que a tela mostrou — são escritos com o objeto completo, à mão.
 */
function variacao(custoAtual, custoAnterior, fracao) {
  return classificarVariacao({
    custoAtual,
    custoAnterior,
    tokensAtual: custoAtual > 0 ? 1 : 0,
    tokensAnterior: custoAnterior > 0 ? 1 : 0,
    fracao,
  });
}

let passou = 0;
let falhou = 0;

function ok(condicao, descricao) {
  if (condicao) {
    passou++;
    console.log(`  OK    ${descricao}`);
  } else {
    falhou++;
    console.log(`  FALHA ${descricao}`);
  }
}

function eq(recebido, esperado, descricao) {
  ok(
    Object.is(recebido, esperado),
    `${descricao} (esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(recebido)})`,
  );
}

/** Linha crua como o PostgREST entrega: NUMERIC e BIGINT chegam como STRING. */
function linha(tenantId, nome, mes, entrada, saida, embedding, custo) {
  return {
    tenant_id: tenantId,
    tenant_nome: nome,
    mes: `${mes}-01`,
    tokens_entrada: String(entrada),
    tokens_saida: String(saida),
    tokens_embedding: String(embedding),
    custo_usd: String(custo),
  };
}

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'dddddddd-0000-4000-8000-000000000004';
const E = 'eeeeeeee-0000-4000-8000-000000000005';
const Z = 'ffffffff-0000-4000-8000-000000000006';

// Catálogo COMPLETO de tenants, inclusive os excluídos — é o que a página passa
// agora, porque é de onde sai o `slug` de quem está excluído. Delta está
// excluído E tem linha (entra); Zeta está excluído e NÃO tem linha (não entra).
const TENANTS = [
  { id: A, nome: 'Alfa', slug: 'alfa', deletado: false },
  { id: B, nome: 'Beta', slug: 'beta', deletado: false },
  { id: C, nome: 'Gama', slug: 'gama', deletado: false },
  { id: E, nome: 'Épsilon', slug: 'epsilon', deletado: false },
  { id: D, nome: 'Delta', slug: 'delta', deletado: true },
  { id: Z, nome: 'Zeta', slug: 'zeta', deletado: true },
];

// 15/08 = mês pela metade (15/31 = 0,48 — ainda ABAIXO do limiar de queda).
// 25/08 = mês adiantado. Os dois existem porque a regra de queda depende disso.
const MEIO = new Date('2026-08-15T12:00:00Z');
const TARDE = new Date('2026-08-25T12:00:00Z');

console.log('\n=== 1. Mês corrente, mês anterior e virada de ano ===\n');

// Em UTC, não no fuso do processo. O teste roda no Windows em UTC-3; se a
// função usasse getMonth(), este caso passaria mesmo assim e só quebraria na
// Vercel — por isso a asserção é numa data cuja hora UTC cai no dia seguinte.
eq(mesCorrente(new Date('2026-08-31T23:30:00Z')), '2026-08', 'último instante de agosto em UTC');
eq(mesCorrente(new Date('2026-09-01T00:30:00Z')), '2026-09', 'primeira hora de setembro em UTC');

eq(mesAnteriorDe('2026-08'), '2026-07', 'mês anterior dentro do ano');
eq(mesAnteriorDe('2026-01'), '2025-12', 'mês anterior na virada de ano');
eq(mesAnteriorDe('2026-10'), '2026-09', 'mês anterior mantém o zero à esquerda');

eq(rotuloMes('2026-08'), 'ago/2026', 'rótulo do mês');
eq(rotuloMes('2026-01'), 'jan/2026', 'rótulo de janeiro');
eq(rotuloMes('2026-12'), 'dez/2026', 'rótulo de dezembro');

// Bissexto sem tabela: fevereiro de 2028 tem 29 dias.
eq(fracaoDoMes(new Date('2028-02-29T00:00:00Z')), 1, 'último dia de fevereiro bissexto = mês inteiro');
eq(fracaoDoMes(new Date('2026-08-31T00:00:00Z')), 1, 'último dia de agosto = mês inteiro');

console.log('\n=== 2. Variação: os casos que viram Infinity se ninguém olhar ===\n');

// O caso que motivou nomear os tipos. (x - 0) / 0 é Infinity em JS, e
// "+Infinity%" na tela aconteceria no mês em que entra cliente novo.
eq(variacao(5, 0, 0.5).tipo, 'primeiro-mes', 'mês anterior zerado não divide por zero');
eq(variacao(0, 0, 0.5).tipo, 'sem-consumo', 'zero nos dois meses não é 0/0 = NaN');
eq(variacao(0, 3, 0.9).tipo, 'parou', 'consumia e parou tem tipo próprio');

// A propriedade, e não um valor: nenhum caminho devolve número não finito.
for (const [atual, anterior] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.0001, 0.0002]]) {
  const v = variacao(atual, anterior, 0.5);
  ok(
    v.tipo !== 'variou' || (Number.isFinite(v.pct) && Number.isFinite(v.delta)),
    `variação(${atual}, ${anterior}) não produz Infinity/NaN`,
  );
}

console.log('\n=== 3. Limiar de destaque: as DUAS condições ===\n');

// Percentual grande e centavos de diferença: é o ruído da escala de hoje.
const ruido = variacao(0.04, 0.02, 1);
eq(ruido.tipo, 'variou', 'dobrou de 0,02 para 0,04');
ok(Math.abs(ruido.pct) >= LIMIAR_VARIACAO_PCT, `  ...e passa do limiar percentual (${ruido.pct}%)`);
eq(ruido.destacar, false, 'não destaca: 2 centavos não passam do piso absoluto');

// Diferença absoluta grande e percentual pequeno: crescimento proporcional.
const proporcional = variacao(11, 10, 1);
eq(proporcional.destacar, false, 'não destaca: +US$ 1,00 mas só +10%');

// As duas juntas.
const anomalia = variacao(0.6, 0.2, 1);
eq(anomalia.destacar, true, 'destaca: +200% E +40 centavos');
ok(
  Math.abs(anomalia.pct) >= LIMIAR_VARIACAO_PCT && Math.abs(anomalia.delta) >= LIMIAR_VARIACAO_USD,
  '  ...porque passa das duas condições',
);

// A regra do mês parcial. Mesma queda, dois momentos do mês.
const quedaCedo = variacao(0.2, 2, 0.1);
const quedaTarde = variacao(0.2, 2, 0.9);
eq(quedaCedo.destacar, false, 'queda no começo do mês não destaca (o mês é parcial)');
eq(quedaTarde.destacar, true, 'a MESMA queda destaca com o mês adiantado');
eq(variacao(0, 2, 0.1).destacar, false, '"parou" também respeita o mês parcial');
eq(variacao(0, 2, 0.9).destacar, true, '"parou" destaca com o mês adiantado');

// Alta não espera o mês passar: subir já com o mês incompleto é sinal mais forte.
eq(variacao(4, 1, 0.05).destacar, true, 'alta destaca desde o dia 1');

ok(FRACAO_MES_PARA_QUEDA > 0 && FRACAO_MES_PARA_QUEDA < 1, 'a fração de corte é uma fração');

console.log('\n=== 4. Montagem do mês: união, ordem, total ===\n');

const LINHAS = [
  linha(A, 'Alfa', '2026-08', 100_000, 3_000, 0, '0.0500'),
  linha(B, 'Beta', '2026-08', 0, 0, 50, '0.0000'), // gastou token, custo arredonda a zero
  linha(E, 'Épsilon', '2026-08', 0, 0, 10, '0.0000'), // idem, com MENOS token que Beta
  linha(D, 'Delta', '2026-08', 10_000, 500, 0, '0.0100'), // excluído, MAS com linha no mês
  linha(A, 'Alfa', '2026-07', 40_000, 1_000, 0, '0.0200'),
  linha(C, 'Gama', '2026-07', 900_000, 20_000, 0, '0.5000'), // material: acima do piso
  linha(A, 'Alfa', '2026-06', 1_000, 10, 0, '0.0005'), // mês antigo: fora da tela
];

const visao = montarVisaoMensal({ linhas: LINHAS, tenants: TENANTS, agora: MEIO });

eq(visao.mes, '2026-08', 'a visão é do mês corrente');
eq(visao.mesAnterior, '2026-07', 'e sabe qual é o anterior');

// O total soma AS LINHAS DO MÊS — inclusive a do tenant excluído, que não está
// na lista de vivos. Se ele saísse do total, a soma dos cards não fecharia.
eq(Number(visao.total.toFixed(4)), 0.06, 'total = 0,05 + 0,00 + 0,01 (inclui o excluído)');
eq(
  Number(visao.cards.reduce((s, c) => s + c.custo, 0).toFixed(4)),
  Number(visao.total.toFixed(4)),
  'a soma dos cards fecha com o total em destaque',
);

const nomes = visao.cards.map((c) => c.nome);
eq(nomes.length, 5, 'cinco cards: os 4 vivos + o excluído COM linha');
ok(!nomes.includes('Zeta'), 'excluído SEM linha não entra — senão a tela vira cemitério');
ok(nomes.includes('Gama'), 'cliente sem NENHUMA linha no mês ainda aparece na lista');
ok(nomes.includes('Delta'), 'cliente excluído que consumiu no mês não some do card');

eq(nomes[0], 'Alfa', 'ordem: mais caro primeiro');
eq(nomes[1], 'Delta', 'ordem: segundo mais caro');
eq(nomes[2], 'Beta', 'ordem: empate em custo zero desempata por token (50)');
eq(nomes[3], 'Épsilon', 'ordem: ...e depois quem gastou menos token (10)');
eq(nomes[4], 'Gama', 'ordem: sem consumo nenhum vai para o fim');

const beta = visao.cards.find((c) => c.nome === 'Beta');
eq(beta.semConsumo, false, 'custo arredondado a zero NÃO é o mesmo que sem consumo');
eq(beta.embedding, 50, '  ...e os tokens vieram convertidos de string para número');

const gama = visao.cards.find((c) => c.nome === 'Gama');
eq(gama.semConsumo, true, 'quem não tem linha no mês está sem consumo');
eq(gama.variacao.tipo, 'parou', '  ...e como consumiu em julho, o tipo é "parou"');
eq(gama.variacao.destacar, false, '  ...sem destaque: o mês ainda está pela metade');

const gamaTarde = montarVisaoMensal({ linhas: LINHAS, tenants: TENANTS, agora: TARDE }).cards.find(
  (c) => c.nome === 'Gama',
);
eq(gamaTarde.variacao.destacar, true, 'a MESMA parada destaca no fim do mês');

// O outro lado, e é o conserto (b): parada de valor irrelevante NÃO destaca nem
// com o mês inteiro passado. Sem esta asserção, subir o valor do Gama acima
// teria escondido a regressão em vez de a testar.
const IRRELEVANTE = [linha(C, 'Gama', '2026-07', 300, 20, 0, '0.0002')];
const gamaTrivial = montarVisaoMensal({
  linhas: IRRELEVANTE,
  tenants: TENANTS,
  agora: TARDE,
}).cards.find((c) => c.nome === 'Gama');
eq(gamaTrivial.variacao.tipo, 'parou', 'parada trivial ainda é "parou"');
eq(gamaTrivial.variacao.destacar, false, '  ...mas não destaca: o piso vale para o "parou"');

const delta = visao.cards.find((c) => c.nome === 'Delta');
eq(delta.deletado, true, 'o excluído com linha vem marcado');
eq(delta.slug, 'delta', '  ...e com SLUG, que é o que separa dois nomes iguais na tela');
eq(delta.variacao.tipo, 'primeiro-mes', '  ...e sem julho, é primeiro mês (não Infinity)');

const alfa = visao.cards.find((c) => c.nome === 'Alfa');
eq(alfa.variacao.tipo, 'variou', 'Alfa tem os dois meses');
eq(Number(alfa.variacao.delta.toFixed(4)), 0.03, '  ...delta = 0,05 - 0,02');
eq(Math.round(alfa.variacao.pct), 150, '  ...pct = +150%');
eq(alfa.variacao.destacar, false, '  ...sem destaque: 3 centavos não passam do piso');

// Nenhum card do mês corrente carrega número do mês retrasado.
eq(alfa.entrada, 100_000, 'o card usa a linha de AGOSTO, não a de julho nem a de junho');

console.log('\n=== 4b. Os quatro defeitos que só a tela mostrou ===\n');

/*
 * Nenhuma das 79 asserções anteriores pegou nada disto, e não por descuido: elas
 * olhavam uma função por vez, e três dos quatro defeitos são de ACORDO entre
 * duas funções que, isoladas, estavam certas. Por isso viram casos nomeados.
 */

// (a) PRESENÇA É TOKEN, NÃO CUSTO. O card do Empório mostrava "embedding 50" e,
// três linhas abaixo, "sem consumo neste mês". 50 tokens custam US$ 0,000001.
const soToken = classificarVariacao({
  custoAtual: 0, custoAnterior: 0, tokensAtual: 50, tokensAnterior: 0, fracao: 0.5,
});
eq(soToken.tipo, 'primeiro-mes', 'token sem custo mensurável é USO, não ausência');

const EMPORIO = [linha(B, 'Beta', '2026-08', 0, 0, 50, '0.0000')];
const cardEmporio = montarVisaoMensal({ linhas: EMPORIO, tenants: TENANTS, agora: MEIO })
  .cards.find((c) => c.nome === 'Beta');
eq(cardEmporio.semConsumo, false, 'quem gastou token não é "sem consumo"');
eq(cardEmporio.tokens, 50, '  ...e o card carrega a contagem que a tela mostra');
ok(
  cardEmporio.variacao.tipo !== 'sem-consumo',
  'o card NÃO pode exibir token e dizer "sem consumo" ao mesmo tempo',
);

// (b) O PISO DO `parou` É O MESMO DO `variou`. O sandbox fechou julho em
// US$ 0,0002 e parou; era o único elemento colorido da tela.
eq(variacao(0, 0.0002, 1).destacar, false, 'parar depois de 2 centésimos de centavo NÃO destaca');
eq(variacao(0, 2, 1).destacar, true, 'parar depois de US$ 2,00 destaca');
eq(
  variacao(0, LIMIAR_VARIACAO_USD, 1).destacar,
  true,
  'exatamente no piso destaca (inclusivo, como no `variou`)',
);

// A PROPRIEDADE, e não dois valores: `parou` usa o MESMO piso do `variou`.
for (const anterior of [0.0001, 0.001, 0.05, 0.09, 0.1, 0.5, 5]) {
  const parou = variacao(0, anterior, 1);
  ok(
    parou.destacar === (anterior >= LIMIAR_VARIACAO_USD),
    `parou(${anterior}) segue o piso absoluto de US$ ${LIMIAR_VARIACAO_USD}`,
  );
}

// O caso que a separação token/custo CRIOU: usou nos dois meses, mas o mês
// anterior custou menos que a menor casa exibível. Percentual contra ~zero é o
// +Infinity% voltando por outra porta. É o Empório no mês que vem.
const baseZero = classificarVariacao({
  custoAtual: 0.02, custoAnterior: 0, tokensAtual: 9000, tokensAnterior: 50, fracao: 0.5,
});
eq(baseZero.tipo, 'base-zero', 'custo anterior zerado COM token anterior não vira percentual');
ok(!('pct' in baseZero), '  ...e não carrega pct nenhum para a tela imprimir');

// (c) Acima de mil por cento o percentual vira multiplicador. O limiar é
// exportado para a página não escolher outro por conta própria.
ok(PCT_VIRA_MULTIPLICADOR >= 100, 'o corte de multiplicador é um percentual alto');
const explosao = variacao(0.0436, 0.0003, 1);
ok(
  Math.abs(explosao.pct) >= PCT_VIRA_MULTIPLICADOR,
  `o caso real (0,0003 -> 0,0436) cruza o corte (${Math.round(explosao.pct)}%)`,
);

// (d) Dinheiro com casas FIXAS dentro da escala. A tela mostrava $0.0436,
// $0.0012, $0.0002 e então $0.00 — a última parecia outra régua.
eq(formatarUsd(0), '$0.0000', 'zero tem as mesmas 4 casas dos vizinhos');
eq(formatarUsd(0.045), '$0.0450', 'e o total não perde o zero à direita');
eq(formatarUsd(0.0436), '$0.0436', 'centavos com 4 casas');
eq(formatarUsd(12.3), '$12.30', 'de um dólar para cima, 2 casas');
eq(formatarUsd(1), '$1.00', 'a fronteira é inclusiva em 1');
const casas = (x) => (formatarUsd(x).split('.')[1] ?? '').length;
for (const [x, y] of [[0, 0.0436], [0.0002, 0.045], [12.3, 999.99]]) {
  eq(casas(x), casas(y), `${x} e ${y} saem com o mesmo número de casas`);
}

console.log('\n=== 5. Histórico de um tenant: buraco vira zero, não sumiço ===\n');

const histAlfa = historicoDoTenant(LINHAS, A, '2026-08');
eq(histAlfa.length, 3, 'jun, jul, ago');
eq(
  histAlfa.map((m) => m.mes).join(','),
  '2026-08,2026-07,2026-06',
  'mais recente primeiro',
);

// Gama consumiu em julho e nada em agosto: agosto tem de existir, zerado.
const histGama = historicoDoTenant(LINHAS, C, '2026-08');
eq(histGama.length, 2, 'julho (com consumo) e agosto (parado)');
eq(histGama[0].mes, '2026-08', 'o mês corrente aparece mesmo sem linha');
eq(histGama[0].custo, 0, '  ...com custo zero');
eq(histGama[1].custo, 0.5, '  ...e julho com o custo real');

// Buraco NO MEIO do histórico: se junho e agosto têm linha e julho não, julho
// não pode simplesmente não estar lá — a leitura seria "julho não existiu".
const COM_BURACO = [
  linha(A, 'Alfa', '2026-06', 100, 10, 0, '0.0010'),
  linha(A, 'Alfa', '2026-08', 100, 10, 0, '0.0010'),
];
const histBuraco = historicoDoTenant(COM_BURACO, A, '2026-08');
eq(histBuraco.length, 3, 'o buraco no meio é preenchido');
eq(histBuraco[1].mes, '2026-07', '  ...com o mês que faltava');
eq(histBuraco[1].custo, 0, '  ...zerado');

eq(historicoDoTenant(LINHAS, 'nao-existe', '2026-08').length, 0, 'tenant sem linha: histórico vazio');

// Virada de ano dentro do preenchimento.
const VIRADA = [linha(A, 'Alfa', '2025-11', 100, 10, 0, '0.0010')];
const histVirada = historicoDoTenant(VIRADA, A, '2026-01');
eq(histVirada.length, 3, 'nov/2025 -> jan/2026 preenche dezembro sem laço infinito');
eq(histVirada.map((m) => m.mes).join(','), '2026-01,2025-12,2025-11', '  ...na ordem certa');

console.log('\n=== 6. SABOTAGEM — as asserções acima conseguem reprovar? ===\n');

/*
 * Cada caso reescreve a FONTE com um defeito plausível, reimporta o módulo com
 * query de cache-busting e roda um punhado de asserções. Se nenhuma reprovar, a
 * asserção correspondente lá em cima é decoração.
 *
 * Rejeição inesperada vira FALHA, não crash: um `await` cru numa chamada que a
 * sabotagem faz estourar derrubaria o processo antes das outras sabotagens, e
 * ficaria sem saber qual propriedade quebrou.
 */

const ORIGINAL = fs.readFileSync(FONTE, 'utf8');
const md5 = (s) => createHash('md5').update(s).digest('hex').slice(0, 8);

const SABOTAGENS = [
  {
    nome: 'divisão por zero destravada (o +Infinity%)',
    // Tira o curto-circuito de "anterior <= 0": volta a cair no cálculo de pct.
    quebrar: (s) => s.replace("if (!usouAntes) return { tipo: 'primeiro-mes' };", ''),
    conferir: (m) => {
      const v = variacaoDe(m)(5, 0, 0.5);
      return v.tipo === 'primeiro-mes' || Number.isFinite(v.pct);
    },
  },
  {
    nome: 'limiar só percentual (o piso absoluto some)',
    quebrar: (s) => s.replace('export const LIMIAR_VARIACAO_USD = 0.1;', 'export const LIMIAR_VARIACAO_USD = 0;'),
    conferir: (m) => variacaoDe(m)(0.04, 0.02, 1).destacar === false,
  },
  {
    nome: 'queda destaca desde o dia 1 (o vermelho que aparece sempre)',
    quebrar: (s) => s.replace('export const FRACAO_MES_PARA_QUEDA = 0.5;', 'export const FRACAO_MES_PARA_QUEDA = 0;'),
    conferir: (m) => variacaoDe(m)(0.2, 2, 0.1).destacar === false,
  },
  {
    nome: 'ordem crescente em vez de decrescente',
    quebrar: (s) => s.replace('if (b.custo !== a.custo) return b.custo - a.custo;', 'if (b.custo !== a.custo) return a.custo - b.custo;'),
    conferir: (m) =>
      m.montarVisaoMensal({ linhas: LINHAS, tenants: TENANTS, agora: MEIO }).cards[0].nome === 'Alfa',
  },
  {
    // O desempate por token é o que separa "custo arredondado a zero" de "não
    // usou". Invertê-lo põe quem não usou na frente de quem usou.
    //
    // NÃO há sabotagem para a chave `semConsumo` do sort, e o motivo está
    // escrito na fonte: com custo sempre >= 0, quem não consumiu já é o mínimo
    // das duas chaves seguintes e cairia no fim de qualquer jeito. Sabotá-la
    // seria um caso que passa verde sem provar nada — que é exatamente o que
    // esta seção existe para não deixar acontecer.
    nome: 'desempate por token invertido',
    quebrar: (s) =>
      s.replace(
        'if (b.tokens !== a.tokens) return b.tokens - a.tokens;',
        'if (b.tokens !== a.tokens) return a.tokens - b.tokens;',
      ),
    conferir: (m) => {
      const c = m.montarVisaoMensal({ linhas: LINHAS, tenants: TENANTS, agora: MEIO }).cards;
      return c[2].nome === 'Beta' && c[3].nome === 'Épsilon';
    },
  },
  {
    nome: 'custo zero passa a contar como sem consumo',
    quebrar: (s) => s.replace('semConsumo: tokens === 0,', 'semConsumo: v.custo === 0,'),
    conferir: (m) =>
      m
        .montarVisaoMensal({ linhas: LINHAS, tenants: TENANTS, agora: MEIO })
        .cards.find((x) => x.nome === 'Beta').semConsumo === false,
  },
  {
    nome: 'tenant excluído sai dos cards (total deixa de fechar)',
    quebrar: (s) =>
      s.replace(
        'const aExibir = tenants.filter((t) => !t.deletado || comLinha.has(t.id));',
        'const aExibir = tenants.filter((t) => !t.deletado);',
      ),
    conferir: (m) => {
      const v = m.montarVisaoMensal({ linhas: LINHAS, tenants: TENANTS, agora: MEIO });
      const soma = v.cards.reduce((s2, c) => s2 + c.custo, 0);
      return Math.abs(soma - v.total) < 1e-9;
    },
  },
  {
    nome: 'buraco no histórico volta a sumir',
    quebrar: (s) =>
      s.replace(
        'saida.push(porMes.get(cursor) ?? { mes: cursor, entrada: 0, saida: 0, embedding: 0, custo: 0 });',
        'if (porMes.has(cursor)) saida.push(porMes.get(cursor));',
      ),
    conferir: (m) => m.historicoDoTenant(COM_BURACO, A, '2026-08').length === 3,
  },
  {
    nome: 'virada de ano no mês anterior (mês 0)',
    quebrar: (s) => s.replace('if (m === 1) return `${ano - 1}-12`;', ''),
    conferir: (m) => m.mesAnteriorDe('2026-01') === '2025-12',
  },
  {
    nome: 'mês corrente pelo fuso local em vez de UTC',
    quebrar: (s) =>
      s.replace(
        'return agora.toISOString().slice(0, 7);',
        "return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;",
      ),
    // Roda com TZ fixo para a sabotagem ser determinística onde quer que o
    // teste rode: às 23:30Z de 31/08, em Tóquio já é setembro.
    conferir: (m) => m.mesCorrente(new Date('2026-08-31T23:30:00Z')) === '2026-08',
    tz: 'Asia/Tokyo',
  },
  {
    // (a) O defeito real: presença voltando a ser custo em vez de token.
    nome: 'presença por custo em vez de token (o card que se contradiz)',
    quebrar: (s) => s.replace('const usouAgora = tokensAtual > 0;', 'const usouAgora = custoAtual > 0;'),
    conferir: (m) =>
      m.classificarVariacao({
        custoAtual: 0, custoAnterior: 0, tokensAtual: 50, tokensAnterior: 0, fracao: 0.5,
      }).tipo === 'primeiro-mes',
  },
  {
    nome: 'semConsumo volta a olhar custo (Empório apagado por engano)',
    quebrar: (s) => s.replace('semConsumo: tokens === 0,', 'semConsumo: v.custo === 0,'),
    conferir: (m) =>
      m
        .montarVisaoMensal({ linhas: EMPORIO, tenants: TENANTS, agora: MEIO })
        .cards.find((c) => c.nome === 'Beta').semConsumo === false,
  },
  {
    // (b) O piso do `parou` desaparecendo de novo.
    nome: 'parou sem piso absoluto (US$ 0,0002 pintado de laranja)',
    quebrar: (s) => s.replace('custoAnterior >= LIMIAR_VARIACAO_USD && fracao', 'fracao'),
    conferir: (m) => variacaoDe(m)(0, 0.0002, 1).destacar === false,
  },
  {
    nome: 'base-zero removido (o +Infinity% pela porta do token)',
    quebrar: (s) =>
      s.replace("if (custoAnterior <= 0) return { tipo: 'base-zero', anterior: custoAnterior };", ''),
    conferir: (m) => {
      const v = m.classificarVariacao({
        custoAtual: 0.02, custoAnterior: 0, tokensAtual: 9000, tokensAnterior: 50, fracao: 0.5,
      });
      return v.tipo === 'base-zero' || Number.isFinite(v.pct);
    },
  },
  {
    // (d) A precisão que fazia $0.00 parecer outra régua.
    nome: 'dinheiro volta a cortar zero à direita',
    quebrar: (s) => s.replace('  minimumFractionDigits: 4,', '  minimumFractionDigits: 2,'),
    conferir: (m) => m.formatarUsd(0) === '$0.0000',
  },
  {
    // (e) O slug que separa dois cards de nome idêntico.
    nome: 'slug some do card (dois "Sandbox de Testes" indistinguíveis)',
    quebrar: (s) => s.replace('      slug: t.slug,', '      slug: null,'),
    conferir: (m) =>
      m
        .montarVisaoMensal({ linhas: LINHAS, tenants: TENANTS, agora: MEIO })
        .cards.find((c) => c.nome === 'Delta').slug === 'delta',
  },
  {
    nome: 'excluído sem linha volta a entrar (tela vira cemitério)',
    quebrar: (s) =>
      s.replace(
        'const aExibir = tenants.filter((t) => !t.deletado || comLinha.has(t.id));',
        'const aExibir = tenants.filter(() => true);',
      ),
    conferir: (m) =>
      !m
        .montarVisaoMensal({ linhas: LINHAS, tenants: TENANTS, agora: MEIO })
        .cards.some((c) => c.nome === 'Zeta'),
  },
];

/** `variacao()` contra o módulo SABOTADO — o bom não serve para nada aqui. */
function variacaoDe(m) {
  return (custoAtual, custoAnterior, fracao) =>
    m.classificarVariacao({
      custoAtual,
      custoAnterior,
      tokensAtual: custoAtual > 0 ? 1 : 0,
      tokensAnterior: custoAnterior > 0 ? 1 : 0,
      fracao,
    });
}

let semEfeito = 0;
let versao = 0;

for (const s of SABOTAGENS) {
  versao += 1;
  const quebrado = s.quebrar(ORIGINAL);

  // CONFIRMA QUE A MUTAÇÃO ENTROU antes de acreditar no resultado. Sabotagem
  // que não muda nada passa como se tivesse rodado — aconteceu duas vezes neste
  // repo, e é o falso verde mais caro que existe.
  if (quebrado === ORIGINAL) {
    falhou++;
    semEfeito++;
    console.log(`  FALHA ${s.nome}: a mutação NÃO aplicou (md5 ${md5(ORIGINAL)} inalterado)`);
    continue;
  }

  const tzOriginal = process.env.TZ;
  try {
    fs.writeFileSync(FONTE, quebrado);
    if (s.tz) process.env.TZ = s.tz;

    // Query nova a cada caso: sem ela o ESM devolve o módulo do cache e a
    // sabotagem nunca é executada.
    const sabotado = await import(`../src/lib/billing/consumo.ts?sabotagem=${versao}`);

    // `conferir` devolve o que a asserção da seção correspondente afirma. Com a
    // fonte quebrada ela TEM de virar false.
    let aindaPassa;
    try {
      aindaPassa = s.conferir(sabotado);
    } catch {
      // Estourar também é reprovar — o defeito foi detectado, só que por
      // exceção. Não derruba o processo.
      aindaPassa = false;
    }

    ok(aindaPassa === false, `sabotagem "${s.nome}" é PEGA (md5 ${md5(ORIGINAL)} -> ${md5(quebrado)})`);
  } finally {
    fs.writeFileSync(FONTE, ORIGINAL);
    if (s.tz) {
      if (tzOriginal === undefined) delete process.env.TZ;
      else process.env.TZ = tzOriginal;
    }
  }
}

// Prova de que o arquivo voltou ao que era — sabotagem que não restaura deixa o
// repo quebrado e o próximo teste culpa o código errado. Compara por md5 para
// não despejar o arquivo inteiro na mensagem quando falhar.
eq(
  md5(fs.readFileSync(FONTE, 'utf8')),
  md5(ORIGINAL),
  'a fonte foi restaurada ao fim das sabotagens',
);
eq(semEfeito, 0, 'toda sabotagem alterou de fato o arquivo');

console.log('\n' + '-'.repeat(60));
console.log(`  ${passou} passaram, ${falhou} falharam\n`);

process.exitCode = falhou > 0 ? 1 : 0;
