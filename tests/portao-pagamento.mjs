// ============================================================================
// teste:portao-pagamento — a REGRA 3 do portao, contra `n8n/aplica-portao.js`
//
// ----------------------------------------------------------------------------
// POR QUE ESTE TESTE E SEPARADO DE `teste:portao-venda`, E O QUE CADA UM MEDE
// ----------------------------------------------------------------------------
// Sao os DOIS LADOS do mesmo par derivado, e nenhum sozinho basta — e a licao
// que o CLAUDE.md registra como caso dez:
//
//   `teste:portao-venda`     roda o `jsCode` DO NO e afirma que ele e IDENTICO
//                            ao arquivo. Ele mede o DERIVADO.
//   `teste:portao-pagamento` (este) roda `n8n/aplica-portao.js`, o ARQUIVO, e
//                            mede o COMPORTAMENTO da regra 3.
//
// Enquanto a injecao no workflow nao for autorizada, o primeiro fica VERMELHO —
// e esse vermelho e verdadeiro: o no carrega codigo mais velho que a fonte, que
// e exatamente a assinatura do defeito que ele existe para pegar. Ele volta ao
// verde com `node scripts/aplicar-portao-venda.mjs`, num passo proprio.
//
// Este aqui nao depende daquele passo, entao a regra 3 tem cobertura desde ja.
//
// ----------------------------------------------------------------------------
// O QUE O ENUNCIADO EXIGIU, E ONDE ESTA
// ----------------------------------------------------------------------------
//   "um teste que afirme «o agente nao confirma pagamento» passa numa
//    implementacao em que a ferramenta de gerar link tambem nunca funciona."
//      -> §1 afirma que BARRA, §2 afirma que PASSA no espelho, e §3 afirma que
//         a mensagem que ENTREGA O LINK passa. Uma implementacao que barra
//         sempre reprova em §2 e §3.
//
//   "a regra 3 testada so com pedido nao pago passa numa implementacao que
//    barra sempre. Monte o espelho."
//      -> §2 e o espelho, item a item: MESMO texto, pedido `pago` -> PASSA.
// ============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTE = fs.readFileSync(path.join(RAIZ, 'n8n', 'aplica-portao.js'), 'utf8');

let ok = 0;
let falhas = 0;
const chk = (nome, cond, detalhe) => {
  if (cond) { ok++; console.log('  OK    ' + nome); }
  else { falhas++; console.log('  FALHA ' + nome + (detalhe ? ' — ' + detalhe : '')); }
};
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex').slice(0, 12);

function rodar(fonte, { texto, estado }) {
  const $input = { first: () => ({ json: estado }) };
  const est = { output: texto, componentes_json: JSON.stringify({ chamadas: 1 }) };
  const $ = (nome) => {
    if (nome === 'Estima Tokens') return { first: () => ({ json: est }) };
    throw new Error('no nao esperado: ' + nome);
  };
  // eslint-disable-next-line no-new-func
  return new Function('$input', '$', fonte)($input, $)[0].json;
}

const item = (nome, qtd, unit) => ({ nome, quantidade: qtd, preco_unit_centavos: unit, subtotal_centavos: unit * qtd });

// `api_n8n_estado_pedido` depois da migracao 61 — nove colunas.
const fechado = (extra = {}) => ({
  tem_pedido: true, pedido_status: 'aguardando_pagamento', pedido_numero: 7,
  total_centavos: 6990, itens: [item('1 - Treinamento de NR 01 on-line', 1, 6990)],
  escreveu_neste_turno: true, barrou_anterior: false, pagamento_confirmado: false,
  ...extra,
});
const pago = (extra = {}) => fechado({ pedido_status: 'pago', pagamento_confirmado: true, ...extra });

// Textos. Os dois primeiros sao as duas metades do par que o enunciado nomeia.
const AFIRMA_PAGAMENTO = 'Pagamento confirmado! ✅ Já pode retirar quando quiser.';
const ENTREGA_O_LINK = 'Prontinho! 😊 Aqui está o link para pagamento do seu pedido: '
  + 'https://sandbox.asaas.com/c/abc123\n\nAssim que o pagamento for confirmado eu te aviso por aqui.';

// ============================================================================
console.log('\n== 1. Afirma pagamento e o pedido NAO esta pago -> BARRA ==\n');
// ============================================================================
{
  const r = rodar(FONTE, { texto: AFIRMA_PAGAMENTO, estado: fechado() });
  chk('"Pagamento confirmado!" com pedido aguardando -> barrado_regra_3',
    r._portao.veredito === 'barrado_regra_3', r._portao.veredito);
  chk('e o marcador registra que afirmou', r._portao.afirmou_pagamento === true);
  chk('e registra que o banco NAO confirmou', r._portao.pagamento_confirmado === false);
  chk('o texto do modelo NAO chega ao cliente', !r.output.includes('Já pode retirar'), r.output);
  chk('a substituta nao afirma pagamento nenhum',
    !/confirmad/i.test(r.output.split('\n').slice(-2).join(' ')), r.output);
  chk('a substituta MOSTRA o pedido em vez de negar que ele existe',
    r.output.includes('📋 Seu pedido') && r.output.includes('R$ 69,90'), r.output);
  chk('e diz que a confirmacao ainda nao apareceu',
    /Ainda nao apareceu a confirmacao/.test(r.output), r.output);
  chk('o bruto vai para o log (a segunda fonte de deteccao nao pode cegar)',
    r._portao.bruto === AFIRMA_PAGAMENTO);
}

// Variantes reais de "o dinheiro entrou", todas com pedido NAO pago.
for (const [rot, txt] of [
  ['pix caiu', 'Seu pix caiu aqui, ja separei tudo!'],
  ['recebemos', 'Recebemos o seu pagamento, obrigado!'],
  ['ja esta pago', 'Seu pedido ja esta pago, pode vir buscar.'],
  ['identificado', 'O pagamento foi identificado certinho por aqui.'],
  ['passiva', 'Confirmado o seu pagamento! Vou separar.'],
]) {
  const r = rodar(FONTE, { texto: txt, estado: fechado() });
  chk(`variante "${rot}" barra`, r._portao.veredito === 'barrado_regra_3', r._portao.veredito);
}

// ============================================================================
console.log('\n== 2. O ESPELHO: mesmo texto, pedido PAGO -> PASSA ==\n');
// ============================================================================
// Sem esta secao, tudo acima passaria numa implementacao que barra sempre.
{
  const r = rodar(FONTE, { texto: AFIRMA_PAGAMENTO, estado: pago() });
  chk('"Pagamento confirmado!" com pedido PAGO -> passou', r._portao.veredito === 'passou',
    r._portao.veredito);
  chk('e o texto do modelo CHEGA ao cliente', r.output.includes('Já pode retirar'), r.output);
  chk('o marcador disparou do mesmo jeito (o que muda e o BANCO, nao o texto)',
    r._portao.afirmou_pagamento === true);
  chk('e o banco confirmou', r._portao.pagamento_confirmado === true);
}
{
  // O caso que motivou `pagamento_confirmado` existir: o cliente pagou, o
  // webhook aplicou, e ele volta a perguntar meia hora depois. Nao ha pedido na
  // janela do turno e nao ha rascunho — `tem_pedido` e FALSO — e a resposta
  // certa continua sendo "sim, caiu".
  const r = rodar(FONTE, {
    texto: 'Sim! O pagamento foi confirmado aqui. 😊',
    estado: {
      tem_pedido: false, pedido_status: null, pedido_numero: null, total_centavos: 0,
      itens: [], escreveu_neste_turno: false, barrou_anterior: false,
      pagamento_confirmado: true,
    },
  });
  chk('"caiu?" meia hora depois, sem pedido na janela, com pagamento_confirmado -> PASSA',
    r._portao.veredito === 'passou', r._portao.veredito);
}

// ============================================================================
console.log('\n== 3. O CONTROLE: a mensagem que ENTREGA o link tem de passar ==\n');
// ============================================================================
// E o falso positivo que importa. Ela contem a palavra "pagamento", termina em
// "assim que o pagamento for confirmado eu te aviso", e o pedido NAO esta pago.
// Se ela barrar, o portao esta impedindo justamente o passo que esta fase
// existe para dar.
{
  const r = rodar(FONTE, { texto: ENTREGA_O_LINK, estado: fechado() });
  chk('a mensagem do link PASSA', r._portao.veredito === 'passou', r._portao.veredito);
  chk('o marcador de pagamento NAO disparou nela', r._portao.afirmou_pagamento === false);
  chk('e o link chega inteiro ao cliente', r.output.includes('sandbox.asaas.com/c/abc123'));
  // E a regra 1 tambem nao pode pegar: "Prontinho!" afirma efeito consumado, e
  // nenhuma linha de `pedidos` se mexeu quando o link foi gerado. E a migracao
  // 61 poe `pedido_cobrancas` em `escreveu_neste_turno` justamente por isso.
  chk('a regra 1 tambem nao a barra (a 61 conta a cobranca como escrita do turno)',
    r._portao.escreveu_neste_turno === true && r._portao.veredito === 'passou');
}
{
  // O espelho da mesma frase: se a cobranca NAO contasse como escrita do turno,
  // a regra 1 barraria. E a prova de que aquela parte da 61 e carga, nao enfeite.
  const r = rodar(FONTE, { texto: ENTREGA_O_LINK, estado: fechado({ escreveu_neste_turno: false }) });
  chk('sem escrita no turno, a MESMA mensagem cai na regra 1',
    r._portao.veredito === 'barrado_regra_1', r._portao.veredito);
}

// Futuro, condicional e pergunta nao afirmam nada.
for (const [rot, txt] of [
  ['futuro', 'Te aviso assim que o pagamento for confirmado.'],
  ['aguardando', 'Seu pagamento ainda esta pendente, aguardando compensacao.'],
  ['negativa', 'Ainda nao identifiquei o seu pagamento por aqui.'],
  ['pergunta', 'Voce ja fez o pagamento? Assim que cair eu confirmo.'],
  ['oferta', 'Quer que eu confira se o pagamento ja foi confirmado?'],
]) {
  const r = rodar(FONTE, { texto: txt, estado: fechado() });
  chk(`"${rot}" nao dispara a regra 3`, r._portao.veredito !== 'barrado_regra_3', r._portao.veredito);
}

// ============================================================================
console.log('\n== 4. A narracao do status vem do BANCO ==\n');
// ============================================================================
{
  const r = rodar(FONTE, { texto: 'Anotei aqui!', estado: fechado() });
  chk('o bloco 📋 diz "aguardando pagamento"', r.output.includes('Status: aguardando pagamento'), r.output);
}
{
  const r = rodar(FONTE, { texto: 'Anotei aqui!', estado: pago() });
  chk('com o pedido pago, o bloco diz "pago"', r.output.includes('Status: pago'), r.output);
}
{
  const r = rodar(FONTE, {
    texto: 'Anotei aqui!',
    estado: fechado({ pedido_status: 'rascunho', escreveu_neste_turno: true }),
  });
  chk('rascunho vira "em montagem" (rotulo de cliente, nao nome de coluna)',
    r.output.includes('Status: em montagem'), r.output);
}
{
  // Status novo que ninguem mapeou nao pode SUMIR da narracao.
  const r = rodar(FONTE, { texto: 'Anotei aqui!', estado: fechado({ pedido_status: 'estornado' }) });
  chk('status sem rotulo aparece cru em vez de desaparecer',
    r.output.includes('Status: estornado'), r.output);
}

// ============================================================================
console.log('\n== 5. As outras duas regras continuam inteiras ==\n');
// ============================================================================
{
  // Regra 2, com pedido pago: total divergente ainda barra. Pagar nao autoriza
  // o modelo a recitar outro valor.
  const r = rodar(FONTE, {
    texto: 'Pagamento confirmado! Total: R$ 999,90',
    estado: pago(),
  });
  chk('pedido pago + total divergente -> barra pela regra 2',
    r._portao.veredito === 'barrado_regra_2', r._portao.veredito);
}
{
  const r = rodar(FONTE, {
    texto: 'Anotei 1 Treinamento de NR 01. Total: R$ 69,90',
    estado: fechado(),
  });
  chk('total correto com escrita no turno -> passa', r._portao.veredito === 'passou', r._portao.veredito);
}

// ============================================================================
console.log('\n== 6. SABOTAGEM ==\n');
// ============================================================================
function sabotar(de, para, rotulo) {
  const n = FONTE.split(de).length - 1;
  if (n !== 1) { falhas++; console.log(`  FALHA sabotagem "${rotulo}" casa ${n}x, esperava 1`); return null; }
  const mut = FONTE.split(de).join(para);
  if (mut === FONTE) { falhas++; console.log(`  FALHA sabotagem "${rotulo}" nao mutou`); return null; }
  // md5, nao tamanho: uma troca de N caracteres por outros N deixa o
  // comprimento identico e o log diria "nao entrou" no caso em que entrou.
  console.log(`     [mutou "${rotulo}": md5 ${md5(FONTE)} -> ${md5(mut)}]`);
  return mut;
}

// S1 — a regra 3 passa a barrar SEMPRE que o texto afirmar pagamento, sem olhar
//      o banco. E a implementacao que o enunciado nomeia, e quem a pega e o
//      ESPELHO da §2 — nao a §1, que fica verde nela.
{
  const s = sabotar('const regra3Barra = afirmouPagamento && !pagamentoConfirmado;',
    'const regra3Barra = afirmouPagamento;', 'regra 3 sem olhar o banco');
  if (s) {
    const espelho = rodar(s, { texto: AFIRMA_PAGAMENTO, estado: pago() });
    chk('S1 QUEBRA o espelho: pedido PAGO passa a ser barrado',
      espelho._portao.veredito === 'barrado_regra_3', espelho._portao.veredito);
    const direto = rodar(s, { texto: AFIRMA_PAGAMENTO, estado: fechado() });
    chk('S1 e a §1 fica VERDE nela — sozinha ela nao pegaria isto',
      direto._portao.veredito === 'barrado_regra_3');
  }
}

// S2 — o marcador nunca dispara. E a implementacao em que "o agente nao
//      confirma pagamento" e verdade por vacuidade.
{
  const s = sabotar('  return frases(txt).some((f) =>\n    RE_PAGAMENTO_RECEBIDO.test(f)',
    '  return false && frases(txt).some((f) =>\n    RE_PAGAMENTO_RECEBIDO.test(f)',
    'marcador de pagamento morto');
  if (s) {
    const r = rodar(s, { texto: AFIRMA_PAGAMENTO, estado: fechado() });
    chk('S2 QUEBRA a §1: a afirmacao falsa passa a chegar ao cliente',
      r._portao.veredito !== 'barrado_regra_3' && r.output.includes('Já pode retirar'),
      r._portao.veredito);
    const controle = rodar(s, { texto: ENTREGA_O_LINK, estado: fechado() });
    chk('S2 e o controle da §3 fica VERDE nela — sozinho ele nao pegaria isto',
      controle._portao.veredito === 'passou');
  }
}

// S3 — sem a negacao de futuro, a mensagem que entrega o link passa a ser
//      barrada. E a prova de que `RE_PAGAMENTO_FUTURO` e carga.
{
  const s3 = sabotar('    && !RE_PAGAMENTO_FUTURO.test(f)\n', '', 'negacao de futuro removida');
  if (s3) {
    const r = rodar(s3, { texto: ENTREGA_O_LINK, estado: fechado() });
    chk('S3 sem a negacao de futuro -> a mensagem do LINK passa a ser barrada',
      r._portao.veredito === 'barrado_regra_3', r._portao.veredito);
  }
}

// S4 — ler o status da JANELA no lugar de `pagamento_confirmado`. Passa em tudo
//      que e do mesmo turno e quebra o caso do cliente que volta depois.
{
  const s = sabotar('const pagamentoConfirmado = estado.pagamento_confirmado === true;',
    "const pagamentoConfirmado = estado.pedido_status === 'pago';",
    'status da janela no lugar de pagamento_confirmado');
  if (s) {
    const volta = rodar(s, {
      texto: 'Sim! O pagamento foi confirmado aqui. 😊',
      estado: {
        tem_pedido: false, pedido_status: null, pedido_numero: null, total_centavos: 0,
        itens: [], escreveu_neste_turno: false, barrou_anterior: false,
        pagamento_confirmado: true,
      },
    });
    chk('S4 QUEBRA o cliente que volta: resposta correta passa a ser barrada',
      volta._portao.veredito === 'barrado_regra_3', volta._portao.veredito);
    const mesmoTurno = rodar(s, { texto: AFIRMA_PAGAMENTO, estado: pago() });
    chk('S4 e o espelho do MESMO turno fica VERDE nela — sozinho nao pegaria',
      mesmoTurno._portao.veredito === 'passou');
  }
}

// ============================================================================
console.log('\n== 7. O par derivado: o codigo le o campo que a 61 devolve ==\n');
// ============================================================================
// O injetor (`scripts/aplicar-portao-venda.mjs`) DERIVA a lista de colunas da
// query do no a partir de `estado.<campo>` neste arquivo. Entao esta assercao
// nao e decorativa: ela diz qual coluna a query vai pedir.
chk('o codigo le `estado.pagamento_confirmado`', /estado\.pagamento_confirmado/.test(FONTE));
chk('e NAO inventa um `estado.pago` que a funcao nao devolve', !/estado\.pago\b/.test(FONTE));

console.log(`\n------------------------------------------------------------`);
console.log(`  ${ok} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
