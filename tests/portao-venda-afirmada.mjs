// ============================================================================
// teste:portao-venda — os DOIS vereditos do portao contra os casos REAIS
//
// O que ele testa: `n8n/aplica-portao.js`, o ARQUIVO, carregado e executado com
// `$input` e `$()` de mentira. Nao uma copia da logica — copia diverge do
// original em silencio, e ai o teste passa a medir a copia.
//
// As fixtures sao os quatro casos de dinheiro afirmado a mais que a
// docs/PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md §7.1 lista, com o texto verbatim do
// `mensagens_log` e o estado do banco daquele instante. Nao ha texto inventado.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTE = path.join(RAIZ, 'n8n', 'aplica-portao.js');
const WORKFLOW = path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json');

let ok = 0;
let falhas = 0;
const chk = (nome, cond, detalhe) => {
  if (cond) { ok++; console.log('  OK    ' + nome); }
  else { falhas++; console.log('  FALHA ' + nome + (detalhe ? ' — ' + detalhe : '')); }
};

// ----------------------------------------------------------------------------
// O arnes: roda o corpo do no com os globais do n8n substituidos
// ----------------------------------------------------------------------------
function rodar(fonte, { texto, estado }) {
  const $input = { first: () => ({ json: estado }) };
  const est = { output: texto, componentes_json: JSON.stringify({ chamadas: 1 }) };
  const $ = (nome) => {
    if (nome === 'Estima Tokens') return { first: () => ({ json: est }) };
    throw new Error('no nao esperado: ' + nome);
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('$input', '$', fonte);
  return fn($input, $)[0].json;
}

// ----------------------------------------------------------------------------
// O QUE ESTE TESTE EXERCITA: O CODIGO QUE VAI AO AR
// ----------------------------------------------------------------------------
// A primeira versao carregava `n8n/aplica-portao.js`, o arquivo-fonte. A
// intencao estava certa — testar o original e nao uma copia da logica — e o
// alvo estava errado: o que roda em producao e a COPIA dentro do `jsCode` do no
// `Aplica Portao`, e as duas divergiram de verdade.
//
// Em 2026-09-09 o commit e48b7a7 renomeou `tem_rascunho` -> `tem_pedido` no
// arquivo e nao rodou o injetor. O no ficou lendo um campo que a migracao 56 nao
// devolve mais; se importado, a regra 2 nunca avaliaria e o bloco 📋 nunca seria
// anexado. E este teste dava 45/45 — sobre um codigo que nao era o que subiria.
//
// Agora ele roda as fixtures contra o `jsCode`, e afirma a identidade ANTES.
// Rodar so a identidade nao bastaria: com o injetor esquecido, a identidade
// falha e nenhuma regra chega a ser exercitada.
const FONTE_ARQUIVO = fs.readFileSync(FONTE, 'utf8');
const FONTE_TXT = (() => {
  const w = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
  const no = w.nodes.find((n) => n.name === 'Aplica Portao');
  if (!no) {
    console.log('  FALHA no "Aplica Portao" ausente do workflow — nada a exercitar');
    process.exit(1);
  }
  return no.parameters?.jsCode ?? '';
})();

console.log('\n== 0. O no e o arquivo sao o mesmo codigo ==\n');
{
  // Fim de linha normalizado nos dois lados: o repo oscila entre CRLF e LF
  // (`core.autocrlf=true`, sem `.gitattributes`) e isso nao e deriva de logica.
  const nl = (x) => x.replace(/\r\n/g, '\n');
  chk('jsCode do no == n8n/aplica-portao.js',
    nl(FONTE_ARQUIVO) === nl(FONTE_TXT),
    `arquivo ${nl(FONTE_ARQUIVO).length} chars, no ${nl(FONTE_TXT).length} — rode node scripts/aplicar-portao-venda.mjs`);
  // E o campo que a migracao 56 devolve, conferido no CODIGO QUE SOBE.
  chk('o codigo que sobe le `tem_pedido` (o campo que a migracao 56 devolve)',
    /estado\.tem_pedido/.test(FONTE_TXT));
  chk('o codigo que sobe NAO le `estado.tem_rascunho` (removido na migracao 56)',
    !/estado\.tem_rascunho/.test(FONTE_TXT));
}

// ----------------------------------------------------------------------------
// Estados de banco, como `api_n8n_estado_pedido` os devolve
// ----------------------------------------------------------------------------
const semPedido = { tem_pedido: false, pedido_status: null, total_centavos: 0, itens: [], escreveu_neste_turno: false, barrou_anterior: false };
const rascunho = (totalCentavos, itens, escreveu = false, barrouAnterior = false) => ({
  tem_pedido: true, pedido_status: 'rascunho', total_centavos: totalCentavos, itens,
  escreveu_neste_turno: escreveu, barrou_anterior: barrouAnterior,
});
const item = (nome, qtd, unit) => ({ nome, quantidade: qtd, preco_unit_centavos: unit, subtotal_centavos: unit * qtd });

// ============================================================================
console.log('\n== 1. Os quatro casos reais de dinheiro afirmado a mais ==\n');
// ============================================================================

// CASO 2 (§7.1 item 2) — `emporio` conv 1636, 20/08 10:19:43, chamadas = 1.
// Banco: rascunho com 1x Queijo Defumado, R$ 25,00. Texto afirma R$ 60,00.
const caso1636 = rodar(FONTE_TXT, {
  texto: 'Só para confirmar, seu pedido está assim:\n\n- 1 Café Cujubi Coffe — R$ 35,00\n- 1 Queijo Defumado — R$ 25,00\n\nTotal: R$ 60,00\n\nPrefere retirar de manhã (7h-10h) ou à tarde (16h-19h)?',
  estado: rascunho(2500, [item('3 - Queijo Defumado', 1, 2500)]),
});
chk('1636 (R$ 60,00 x R$ 25,00) barra', caso1636._portao.veredito.startsWith('barrado'), caso1636._portao.veredito);
chk('1636 le o total afirmado em centavos', caso1636._portao.total_afirmado_centavos === 6000,
  String(caso1636._portao.total_afirmado_centavos));
chk('1636 marca a regra 2 como AVALIADA', caso1636._portao.regra2_avaliada === true);

// CASO 4 (§7.1 item 4) — `estudyou-sendbox` conv 1864, 08/09 16:07:33, chamadas = 1.
// Banco: rascunho 3x NR 01 = R$ 209,70. Texto afirma R$ 279,60.
const caso27960 = rodar(FONTE_TXT, {
  texto: 'Adicionei 1 Treinamento de NR 06 on-line ao seu pedido. Agora seu pedido está assim:\n\n- 3x Treinamento de NR 01 on-line — R$ 209,70\n- 1x Treinamento de NR 06 on-line — R$ 69,90\n\nTotal: R$ 279,60\n\nQuer finalizar o pedido?',
  estado: rascunho(20970, [item('1 - Treinamento de NR 01 on-line', 3, 6990)]),
});
chk('sendbox (R$ 279,60 x R$ 209,70) barra', caso27960._portao.veredito.startsWith('barrado'), caso27960._portao.veredito);
chk('sendbox le R$ 279,60 como total afirmado', caso27960._portao.total_afirmado_centavos === 27960,
  String(caso27960._portao.total_afirmado_centavos));

// CASO 3 (§7.1 item 3) — `estudyou-sendbox`, 28/08 11:54:53, chamadas = 1.
// Banco naquele instante: pedido nº 1 JA FECHADO (aguardando_pagamento), SEM
// rascunho. A regra 2 nao tem com o que comparar; quem pega e a REGRA 1.
const caso24980 = rodar(FONTE_TXT, {
  texto: 'Adicionei 1 Treinamento de NR 01 on-line ao seu pedido. Agora seu pedido está assim:\n\n- 1x Curso de Direção Defensiva — R$ 179,90\n- 1x Treinamento de NR 01 on-line — R$ 69,90\n\nTotal: R$ 249,80\n\nQuer finalizar o pedido?',
  estado: semPedido,
});
chk('sendbox 28/08 (R$ 249,80, sem rascunho) barra pela REGRA 1', caso24980._portao.veredito === 'barrado_regra_1',
  caso24980._portao.veredito);
chk('sendbox 28/08 nao avalia a regra 2 (nao ha com o que comparar)', caso24980._portao.regra2_avaliada === false);

// CASO 1 (§7.1 item 1) — `emporio` conv 18, 21/08 21:43:01, chamadas = 4.
// A tool RODOU e fechou o pedido de R$ 30,00; o texto publicou R$ 42,50.
//
// Este e o caso que a versao "sempre o rascunho" deixava escapar: o
// `fechar_pedido` transforma o rascunho em `aguardando_pagamento` NO MESMO
// TURNO em que o valor final e dito, entao no instante da consulta nao havia
// rascunho e a regra 2 ficava sem referencia. Com a referencia por PEDIDO
// TOCADO no turno, o pedido recem-fechado continua sendo a referencia.
const fechadoAgora = {
  tem_pedido: true, pedido_status: 'aguardando_pagamento', total_centavos: 3000,
  itens: [item('11 - Pão de queijo tradicional', 20, 150)],
  escreveu_neste_turno: true, barrou_anterior: false,
};
const caso4250 = rodar(FONTE_TXT, { texto: 'Seu pedido está fechado com 20 pães de queijo tradicionais e 10 pães franceses, totalizando R$ 42,50. Pode passar para retirar pela manhã na nossa loja.', estado: fechadoAgora });
chk('21/08 (R$ 42,50 x R$ 30,00, pedido FECHADO no turno) barra pela regra 2',
  caso4250._portao.veredito === 'barrado_regra_2', caso4250._portao.veredito);
chk('21/08 a regra 1 NAO barra — a tool rodou de verdade', caso4250._portao.escreveu_neste_turno === true);

// E o espelho: mesmo fechamento, valor CERTO -> passa. Sem isto, o verde acima
// poderia vir de "fechamento sempre barra".
const fechadoCerto = rodar(FONTE_TXT, {
  texto: 'Seu pedido está fechado com 20 pães de queijo tradicionais, totalizando R$ 30,00. Pode passar para retirar pela manhã.',
  estado: fechadoAgora,
});
chk('fechamento com valor CERTO passa', fechadoCerto._portao.veredito === 'passou', fechadoCerto._portao.veredito);

// ============================================================================
console.log('\n== 2. Os tres turnos do caso do emporio de 08/09 ==\n');
// ============================================================================
// Nenhum pedido foi criado. Os tres afirmam, os tres tem chamadas = 1.
const t1 = rodar(FONTE_TXT, {
  texto: 'Anotei 10 pães de queijo tradicionais para você, totalizando R$ 15,00. Quer levar um doce de leite junto?',
  estado: semPedido,
});
const t2 = rodar(FONTE_TXT, {
  texto: 'Tudo bem! Só para confirmar, seu pedido ficou:\n- 10 pães de queijo tradicionais — R$ 15,00\nTotal: R$ 15,00\n\nPrefere retirar de manhã ou à tarde?',
  estado: semPedido,
});
const t3 = rodar(FONTE_TXT, {
  texto: 'Perfeito! Seu pedido está confirmado com 10 pães de queijo tradicionais para retirada. Qualquer coisa, é só chamar.',
  estado: semPedido,
});
chk('08/09 turno 1 ("Anotei") barra', t1._portao.veredito === 'barrado_regra_1');
chk('08/09 turno 2 ("seu pedido ficou:") barra', t2._portao.veredito === 'barrado_regra_1');
chk('08/09 turno 3 ("pedido está confirmado") barra', t3._portao.veredito === 'barrado_regra_1');
chk('08/09 turno 2 e o que NENHUM dos quatro detectores pegava', t2._portao.veredito.startsWith('barrado'));

// ============================================================================
console.log('\n== 3. O que NAO pode ser barrado ==\n');
// ============================================================================

// A confirmacao legitima mais comum: subtotais SEM o lema "total".
const subtotais = rodar(FONTE_TXT, {
  texto: 'Você gostaria de 10 pães de queijo tradicional a R$ 15,00, 1 queijo frescal a R$ 20,00 e 1 iogurte a R$ 3,50? Posso confirmar o pedido para você?',
  estado: rascunho(3850, [item('11 - Pão de queijo', 10, 150), item('9 - Queijo Frescal', 1, 2000), item('6 - Iogurte', 1, 350)]),
});
chk('subtotais sem "total" NAO sao avaliados pela regra 2', subtotais._portao.regra2_avaliada === false);
chk('subtotais sem "total" passam', subtotais._portao.veredito === 'passou', subtotais._portao.veredito);

// Venda boa: a tool rodou, o total bate.
const vendaBoa = rodar(FONTE_TXT, {
  texto: 'Anotei 12 unidades de pão de queijo tradicional, totalizando R$ 18,00. Você prefere retirar de manhã ou à tarde?',
  estado: rascunho(1800, [item('11 - Pão de queijo tradicional', 12, 150)], true),
});
chk('venda boa (total bate, houve escrita) PASSA', vendaBoa._portao.veredito === 'passou', vendaBoa._portao.veredito);
chk('venda boa avalia a regra 2 e nao barra', vendaBoa._portao.regra2_avaliada === true);
chk('venda boa recebe o bloco do pedido anexado', vendaBoa._portao.bloco_anexado === true);
chk('o bloco traz ITENS e nao so o total', /• .*×.*=/.test(vendaBoa.output) && /Total: R\$ 18,00/.test(vendaBoa.output));

// Oferta e pergunta nao sao efeito consumado.
const oferta = rodar(FONTE_TXT, {
  texto: 'O Café Cujubi Coffe não tem foto cadastrada, mas ele é conhecido pelo sabor intenso. Quer que eu já coloque uma unidade no seu pedido?',
  estado: semPedido,
});
chk('"Quer que eu ja coloque..." NAO e efeito consumado', oferta._portao.afirmou_efeito_consumado === false);
chk('oferta passa', oferta._portao.veredito === 'passou', oferta._portao.veredito);

// Falso positivo conhecido da D1: lista de vacinas do `fortalize`, tenant sem venda.
const vacina = rodar(FONTE_TXT, {
  texto: 'Perfeito! Atualizando a lista das vacinas no segundo ano de vida, incluindo a influenza anual:\n- Reforço da Hexavalente aos 15 meses.',
  estado: semPedido,
});
chk('lista de vacinas do fortalize passa (era falso positivo da D1)', vacina._portao.veredito === 'passou',
  vacina._portao.veredito);

// Afirmacao benigna: o pedido mudou NESTE turno e o texto conta isso.
const benigna = rodar(FONTE_TXT, {
  texto: 'Adicionei 1 unidade do Curso de Direção Defensiva ao seu pedido. Total até agora: R$ 179,90.',
  estado: rascunho(17990, [item('12 - Curso de Direção Defensiva', 1, 17990)], true),
});
chk('afirmacao verdadeira com escrita no turno passa', benigna._portao.veredito === 'passou', benigna._portao.veredito);

// ============================================================================
console.log('\n== 4. As variantes do lema "total" que "Total:" literal perderia ==\n');
// ============================================================================
const variantes = [
  ['total R$ 18,00', 'Ótimo! Então, confirmando: 12 pães de queijo tradicional, total R$ 18,00.', 1800],
  ['O total ficou R$ 75,00', 'Seu pedido foi separado para retirada. O total ficou R$ 75,00, com 3 pedaços de bolo.', 7500],
  ['por R$ 4,50 no total', 'Encontrei 3 pães de queijo por R$ 4,50 no total.', 450],
  ['Totalizando R$ 331,80', 'Adicionei 1 porção ao seu pedido. Totalizando R$ 331,80.', 33180],
];
for (const [rotulo, texto, esperado] of variantes) {
  const r = rodar(FONTE_TXT, { texto, estado: rascunho(999999, [item('x', 1, 999999)], true) });
  chk(`variante "${rotulo}" e reconhecida`, r._portao.total_afirmado_centavos === esperado,
    String(r._portao.total_afirmado_centavos));
}

// ============================================================================
console.log('\n== 5. Transferencia depois de DUAS barradas seguidas ==\n');
// ============================================================================
const primeira = rodar(FONTE_TXT, { texto: 'Pronto, anotei seu pedido!', estado: semPedido });
chk('primeira barrada NAO transfere', primeira._portao.transferiu === false);
const segunda = rodar(FONTE_TXT, {
  texto: 'Pronto, anotei seu pedido!',
  estado: { ...semPedido, barrou_anterior: true },
});
chk('segunda barrada seguida transfere', segunda._portao.transferiu === true);
chk('a nota privada traz o ESTADO DE FATO rotulado', /Estado de fato \(banco\)/.test(segunda._portao_nota_privada));
chk('a nota privada traz o que o AGENTE AFIRMOU, rotulado',
  /O que o agente afirmou/.test(segunda._portao_nota_privada)
  && segunda._portao_nota_privada.includes('anotei seu pedido'));

// ============================================================================
console.log('\n== 6. O registro nao pode perder o texto bruto ==\n');
// ============================================================================
const comp = JSON.parse(t2.componentes_json);
chk('o veredito viaja no componentes_json', comp.portao?.veredito === 'barrado_regra_1');
chk('o texto BRUTO do modelo e preservado quando houve substituicao',
  typeof comp.portao?.bruto === 'string' && comp.portao.bruto.includes('seu pedido ficou'));
chk('a saida ao cliente NAO e o texto bruto', t2.output !== comp.portao.bruto);
chk('mensagem que passou nao carrega bruto (evita duplicar bytes)',
  JSON.parse(vendaBoa.componentes_json).portao.bruto === null);
chk('os componentes de token do Estima Tokens sobrevivem', comp.chamadas === 1);

// ============================================================================
console.log('\n== 7. SABOTAGEM — as assercoes tem de saber reprovar ==\n');
// ============================================================================
// A regra do CLAUDE.md: sabote e CONFIRME QUE A MUTACAO ENTROU antes de
// acreditar no resultado. Ja houve sabotagem que nao mutou nada (CRLF, regex
// multi-linha) e passou por "a regra nao pega".
function sabotar(de, para, rotulo) {
  const n = FONTE_TXT.split(de).length - 1;
  if (n !== 1) { falhas++; console.log(`  FALHA sabotagem "${rotulo}" nao aplicou — trecho aparece ${n}x`); return null; }
  const mutado = FONTE_TXT.split(de).join(para);
  if (mutado === FONTE_TXT) { falhas++; console.log(`  FALHA sabotagem "${rotulo}" nao mudou o texto`); return null; }
  return mutado;
}

// (a) Regra 1 desligada: os tres turnos de 08/09 tem de deixar de barrar.
const semR1 = sabotar('const regra1Barra = afirmou && !escreveuNesteTurno;',
  'const regra1Barra = false;', 'regra 1 desligada');
if (semR1) {
  const r = rodar(semR1, { texto: 'Anotei 10 pães de queijo tradicionais para você.', estado: semPedido });
  chk('SABOTAGEM regra 1 desligada -> o caso de 08/09 PASSA (a assercao sabe reprovar)',
    r._portao.veredito === 'passou', r._portao.veredito);
}

// (b) Regra 2 desligada: o caso 1636 tem de deixar de barrar.
const semR2 = sabotar('const regra2Barra = regra2Avaliada && totalAfirmado !== totalBanco;',
  'const regra2Barra = false;', 'regra 2 desligada');
if (semR2) {
  const r = rodar(semR2, {
    texto: 'Só para confirmar, seu pedido está assim:\n- 1 Café — R$ 35,00\n- 1 Queijo — R$ 25,00\nTotal: R$ 60,00',
    // escreveu = true isola a regra 2: sem isso a regra 1 barraria e o teste
    // ficaria verde pelo motivo errado — que e exatamente a armadilha do §8.
    estado: rascunho(2500, [item('Queijo', 1, 2500)], true),
  });
  chk('SABOTAGEM regra 2 desligada -> o caso 1636 PASSA', r._portao.veredito === 'passou', r._portao.veredito);
}

// (c) Marcador alargado para qualquer valor: a confirmacao com subtotais passa a
//     ser barrada. E a prova de que o marcador ESTREITO esta fazendo trabalho.
const largo = sabotar('const RE_LEMA_TOTAL = /\\btotal(izando|iza|izou|izam)?\\b/gi;',
  'const RE_LEMA_TOTAL = /\\b(total(izando|iza|izou|izam)?|a|de|e)\\b/gi;', 'marcador alargado');
if (largo) {
  const r = rodar(largo, {
    texto: 'Você gostaria de 10 pães de queijo tradicional a R$ 15,00, 1 queijo frescal a R$ 20,00 e 1 iogurte a R$ 3,50?',
    estado: rascunho(3850, [item('x', 1, 3850)], true),
  });
  chk('SABOTAGEM marcador largo -> a confirmacao legitima passa a ser BARRADA',
    r._portao.veredito === 'barrado_regra_2', r._portao.veredito);
}

// ============================================================================
console.log('\n== 8. A armadilha nomeada: barrar pelo motivo ERRADO ==\n');
// ============================================================================
// "Um teste que barre a mensagem fabricada pode estar passando porque o rascunho
// nao existe, e nao porque o total diverge."
//
// O caso abaixo tem rascunho PRESENTE, total CORRETO e escrita no turno. Se ele
// barrar, a regra 2 esta reprovando por ausencia de referencia e nao por
// divergencia — e todos os verdes da secao 1 seriam por acaso.
const controle = rodar(FONTE_TXT, {
  texto: 'Adicionei 1 Treinamento de NR 06 on-line ao seu pedido. Agora seu pedido está assim:\n\n- 3x Treinamento de NR 01 on-line — R$ 209,70\n- 1x Treinamento de NR 06 on-line — R$ 69,90\n\nTotal: R$ 279,60\n\nQuer finalizar o pedido?',
  estado: rascunho(27960, [item('NR 01', 3, 6990), item('NR 06', 1, 6990)], true),
});
chk('MESMO texto, rascunho presente e total CORRETO -> PASSA', controle._portao.veredito === 'passou',
  controle._portao.veredito);
chk('e a regra 2 foi de fato AVALIADA nesse controle', controle._portao.regra2_avaliada === true);
chk('e o total lido foi o mesmo do banco', controle._portao.total_afirmado_centavos === 27960);

// O espelho: mesmo estado, um centavo de diferenca -> barra.
const umCentavo = rodar(FONTE_TXT, {
  texto: 'Agora seu pedido está assim:\n- 3x NR 01\n- 1x NR 06\nTotal: R$ 279,61',
  estado: rascunho(27960, [item('NR 01', 3, 6990), item('NR 06', 1, 6990)], true),
});
chk('um centavo de divergencia ja barra (comparacao e em centavos, nao float)',
  umCentavo._portao.veredito === 'barrado_regra_2', umCentavo._portao.veredito);

// ============================================================================
console.log('\n== 9. Cobertura dos quatro casos, dita de frente ==\n');
// ============================================================================
const cobertura = [
  ['R$ 60,00  (emporio/1636, 20/08)', caso1636._portao.veredito],
  ['R$ 249,80 (sendbox, 28/08)', caso24980._portao.veredito],
  ['R$ 279,60 (sendbox, 08/09)', caso27960._portao.veredito],
  ['R$ 42,50  (emporio/18, 21/08)', caso4250._portao.veredito],
];
for (const [rotulo, v] of cobertura) console.log(`    ${rotulo.padEnd(34)} -> ${v}`);
const pegos = cobertura.filter(([, v]) => v.startsWith('barrado')).length;
console.log(`\n    barrados: ${pegos} de 4`);
chk('os QUATRO casos reais sao barrados', pegos === 4, `pegos=${pegos}`);

console.log(`\n------------------------------------------------------------`);
console.log(`  ${ok} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
