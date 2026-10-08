/**
 * O PORTÃO BARRANDO O QUE NÃO DEVIA (08/10) — os dois consertos, medidos
 * contra as mensagens que clientes de verdade leram.
 *
 * Entre 17/09 e 07/10 o portão barrou 23 respostas e trocou 18 delas por
 * "Ainda nao tenho nenhum item anotado no seu pedido aqui". Treze foram no
 * CEEJAAR, que é uma ESCOLA e não tem a tool `vendas` contratada.
 *
 * (A) A CONTA QUE NÃO VENDE. "pedido" em português também é SOLICITAÇÃO, e
 *     `RE_CONTEXTO_PEDIDO` casa a palavra. "Já encaminhei seu pedido para a
 *     secretaria" disparava a regra 1, e um aluno perguntando por certificado
 *     recebia uma mensagem de carrinho de compras. A pior foi um
 *     agradecimento: "sucesso no seu pedido hoje!".
 *
 * (B) O PEDIDO FECHADO FORA DA JANELA. `tem_pedido` é "tocado neste turno",
 *     não "existe". Na conversa 56 do Empório a confirmação do fechamento foi
 *     gravada 7,2 s DEPOIS da linha do pedido e virou a borda da janela: no
 *     turno seguinte a Thaís leu que não havia pedido nenhum, vinte segundos
 *     depois de fechar R$ 9,00.
 *
 * O QUE ESTE TESTE NÃO É: uma lista de frases que eu inventei. Os textos
 * marcados como REAL são `portao->>'bruto'` de produção, copiados do banco —
 * é o que o modelo escreveu e o portão jogou fora. Teste de portão escrito com
 * frase de laboratório mede o laboratório.
 *
 * As duas direções são medidas em todo caso: o que passou a passar, e o que
 * PRECISA continuar barrando. Uma exceção só é segura se a contraprova de que
 * ela não afrouxou o resto estiver junto.
 */
import { corpoRegra, rodarRegra } from '../agente/src/regras-js.ts';

const CORPO = corpoRegra('agente/regras', 'aplica-portao.js');

let ok = 0;
const falhas = [];
const chk = (nome, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${extra ? ' — ' + extra : ''}`); }
};

function portao(estado, texto) {
  const s = rodarRegra(CORPO, { json: estado }, { 'Estima Tokens': { output: texto, componentes_json: '{}' } });
  let c = {};
  try { c = JSON.parse(s.componentes_json ?? '{}'); } catch { c = {}; }
  return { output: String(s.output ?? ''), portao: c.portao ?? {} };
}
const passou = (e, t) => portao(e, t).portao.veredito === 'passou';

/** Frases REAIS que o portão barrou no CEEJAAR (`portao->>'bruto'`). */
const REAIS_CEEJAAR = [
  'Já encaminhei seu pedido para a secretaria, que vai te orientar certinho sobre como pegar o certificado e histórico da Netima Carvalho Ramiro e do Fábio Ramiro.',
  'Já registrei seu pedido e passei para a secretaria. Eles vão entrar em contato com você para orientar direitinho.',
  'Simone, no momento a secretaria do CEEJAAR está fora do horário de atendimento. Já registrei seu pedido para emissão do histórico escolar.',
  'De nada! Fico feliz em ajudar. Boa tarde e sucesso no seu pedido hoje! Se precisar, é só chamar por aqui. 😊',
  'Claudete, já passei seu pedido para a secretaria do CEEJAAR. Eles vão te retornar por aqui mesmo.',
  'Já estou passando seu pedido para a secretaria, que vai te ajudar a consultar suas faltas.',
];

/** Frases REAIS barradas no Empório, com o pedido fechado vivo no banco. */
const REAIS_EMPORIO_COM_PEDIDO = [
  'Thaís, seu pedido já está separado e confirmado para retirada hoje às 17h30. Você paga na retirada, no balcão.',
  'Douglas, seu pedido de 10 pães de queijo tradicional está confirmado para retirada à tarde, entre 16h e 19h. O pagamento é feito na hora que você buscar.',
];

const SEM_VENDAS = { tem_pedido: false, conta_vende: false };
const VENDE_SEM_PEDIDO = { tem_pedido: false, conta_vende: true, pedido_recente: false };
const VENDE_COM_FECHADO = { tem_pedido: false, conta_vende: true, pedido_recente: true, pedido_recente_numero: 7 };

console.log('\n=== 1. (A) A conta que não vende ===\n');

chk('a lista de frases reais do CEEJAAR não está vazia', REAIS_CEEJAAR.length > 0);
const aindaBarradas = REAIS_CEEJAAR.filter((f) => !passou(SEM_VENDAS, f));
chk('TODAS as 6 frases reais do CEEJAAR passam agora', aindaBarradas.length === 0,
  'ainda barradas: ' + aindaBarradas.map((f) => f.slice(0, 50)).join(' / '));

// CONTRAPROVA. Sem ela, "passam agora" seria verdade também se o portão
// tivesse parado de barrar tudo — inclusive o que ele existe para pegar.
const barradasQuandoVende = REAIS_CEEJAAR.filter((f) => !passou({ ...VENDE_SEM_PEDIDO }, f));
chk('CONTRAPROVA: numa conta que VENDE, as mesmas frases continuam sendo barradas',
  barradasQuandoVende.length > 0, `nenhuma barrou — a regra 1 morreu (${REAIS_CEEJAAR.length} frases)`);

// A chave AUSENTE tem de significar o comportamento de hoje: quem não sabe
// responder é tratado como conta que vende, que é o lado que barra mais.
chk('`conta_vende` ausente = conta que vende (barra, como antes)',
  !passou({ tem_pedido: false }, REAIS_CEEJAAR[0]));
chk('`conta_vende: "nao"` (string) não desliga — só o false',
  !passou({ tem_pedido: false, conta_vende: 'nao' }, REAIS_CEEJAAR[0]));

// A regra 3 NÃO foi desligada para quem não vende, de propósito: afirmar
// dinheiro recebido é fabricação em qualquer conta.
chk('a regra 3 continua valendo numa conta que não vende',
  !passou(SEM_VENDAS, 'Prontinho, o pix caiu aqui e ja esta tudo certo!'));

console.log('\n=== 2. (B) O pedido fechado que existe ===\n');

const aindaBarradasEmp = REAIS_EMPORIO_COM_PEDIDO.filter((f) => !passou(VENDE_COM_FECHADO, f));
chk('as 2 frases reais do Empório passam com pedido fechado no banco', aindaBarradasEmp.length === 0,
  'ainda barradas: ' + aindaBarradasEmp.map((f) => f.slice(0, 60)).join(' / '));

// CONTRAPROVA: sem pedido fechado, as MESMAS frases continuam barradas. É o
// que separa "a exceção funciona" de "a regra 1 parou de existir".
const semPedido = REAIS_EMPORIO_COM_PEDIDO.filter((f) => !passou(VENDE_SEM_PEDIDO, f));
chk('CONTRAPROVA: sem pedido fechado, as mesmas frases são barradas',
  semPedido.length === REAIS_EMPORIO_COM_PEDIDO.length,
  `${semPedido.length} de ${REAIS_EMPORIO_COM_PEDIDO.length}`);

// O CORTE. A primeira versão da exceção usava `RE_OUTRA_ACAO_NO_PEDIDO`, que
// inclui os PARTICÍPIOS (`separad[oa]`, `fech(ado|ada)`) — e a frase da Thaís
// continuava barrada, porque ela diz "separado". Quem mostrou foi rodar, não
// reler. O corte é a PRIMEIRA PESSOA do passado.
chk('"ja anotei mais 3" continua barrando mesmo com pedido fechado',
  !passou(VENDE_COM_FECHADO, 'Pronto, ja anotei mais 3 paes de queijo no seu pedido.'));
chk('"cancelei seu pedido" idem', !passou(VENDE_COM_FECHADO, 'Cancelei seu pedido aqui, sem problema!'));
chk('"removi o item" idem', !passou(VENDE_COM_FECHADO, 'Removi o item do seu pedido, ficou so o cafe.'));
chk('...mas o PARTICÍPIO que descreve o estado passa', passou(VENDE_COM_FECHADO, 'Seu pedido ja esta registrado e separado aqui comigo.'));

console.log('\n=== 3. A substituta não afirma o que o portão não sabe ===\n');

// Era aqui que o portão — que existe para impedir fabricação — fabricava.
const comFechado = portao(VENDE_COM_FECHADO, 'Pronto, ja anotei mais 3 paes de queijo no seu pedido.');
chk('com pedido fechado, a recusa NÃO diz "nao tenho nenhum item anotado"',
  !/nao tenho nenhum item anotado/i.test(comFechado.output), comFechado.output.replace(/\n+/g, ' | '));
chk('...e diz que o pedido existe, com o número', /pedido no 7 ja esta fechado/i.test(comFechado.output),
  comFechado.output.replace(/\n+/g, ' | '));
chk('pedido fechado e PAGO: a recusa diz que o pagamento consta',
  /pagamento consta como recebido/i.test(
    portao({ ...VENDE_COM_FECHADO, pedido_recente_status: 'pago' }, 'Pronto, ja anotei mais 3 no seu pedido.').output));

// E a frase CONTINUA quando é verdadeira: sem pedido nenhum (nem rascunho, que
// `tem_pedido` já cobre, nem fechado), "não tenho nada anotado" é o conserto
// que a regra 1 existe para dar. Tirá-la aqui seria trocar uma mentira por um
// silêncio inútil.
const semNada = portao(VENDE_SEM_PEDIDO, 'Pronto, ja anotei 5 paes de queijo no seu pedido.');
chk('sem pedido nenhum, a frase verdadeira CONTINUA',
  /nao tenho nenhum item anotado/i.test(semNada.output), semNada.output.replace(/\n+/g, ' | '));

console.log('\n=== 4. O trace guarda a razão ===\n');

// Razão que não fica gravada não é investigável — foi lendo `portao` que os
// 13 casos do CEEJAAR apareceram.
const t1 = portao(SEM_VENDAS, REAIS_CEEJAAR[0]).portao;
chk('`conta_vende` vai para o trace', t1.conta_vende === false, JSON.stringify(t1));
const t2 = comFechado.portao;
chk('`pedido_recente` vai para o trace', t2.pedido_recente === true);
chk('`pedido_recente_status` vai para o trace',
  portao({ ...VENDE_COM_FECHADO, pedido_recente_status: 'pago' }, 'ja anotei mais 3 no pedido').portao.pedido_recente_status === 'pago');

console.log('\n=== 5. Nada do que já funcionava mudou ===\n');

// Com rascunho e total batendo, o caminho feliz segue feliz.
chk('mensagem comum passa', passou({ tem_pedido: false, conta_vende: true }, 'Bom dia! Como posso te ajudar hoje?'));
chk('oferta de preço sem pedido passa', passou({ tem_pedido: false, conta_vende: true }, 'O pao de queijo sai por R$ 1,50 a unidade. Quer levar quantos?'));
// Regra 2: total divergente continua barrando. `escreveu_neste_turno: true`
// para ISOLAR a regra 2 — com ele false as duas barram e a regra 1 fica com o
// rótulo, o que fez esta asserção reprovar na primeira escrita. O defeito era
// meu: eu estava medindo o NOME do veredito, não o efeito.
const r2 = portao(
  { tem_pedido: true, conta_vende: true, total_centavos: 900, pedido_status: 'rascunho', itens: [], escreveu_neste_turno: true },
  'Seu pedido ficou em R$ 15,00 no total.');
chk('regra 2 (total divergente) continua barrando', r2.portao.veredito === 'barrado_regra_2', JSON.stringify(r2.portao.veredito));
chk('...e o trace guarda os dois totais', r2.portao.total_banco_centavos === 900 && r2.portao.total_afirmado_centavos === 1500);
// Contraprova: total BATENDO passa.
chk('CONTRAPROVA: com o total certo, passa',
  passou({ tem_pedido: true, conta_vende: true, total_centavos: 1500, pedido_status: 'rascunho', itens: [], escreveu_neste_turno: true },
    'Seu pedido ficou em R$ 15,00 no total.'));
// Regra 1 clássica: afirmou escrita, não houve, não há pedido.
chk('regra 1 clássica continua barrando',
  portao(VENDE_SEM_PEDIDO, 'Pronto, ja adicionei 2 cafes no seu pedido.').portao.veredito === 'barrado_regra_1');

console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
