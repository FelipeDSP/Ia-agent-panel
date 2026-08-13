/**
 * Grupos de módulo: o que o cliente vê e no que ele pode mexer.
 *
 * A REGRA que este teste guarda, uma frase: o painel do cliente só mostra o que
 * ele pode agir. Não pode desligar nem configurar -> some. Não tem contratado ->
 * some. Pode configurar ou ligar/desligar -> fica.
 *
 * TUDO AQUI É PROPRIEDADE, NÃO ESTADO DO MUNDO. Nenhuma asserção olha o banco.
 * A diferença importa: "nenhum módulo padrão está desligado" é verdade hoje e
 * fica vermelha no dia em que alguém desligar um de propósito — o que é uma
 * operação legítima. O que este arquivo afirma é "SE existir módulo padrão
 * desligado, ENTÃO a seção do admin abre sozinha", que continua verdadeira nos
 * dois estados do mundo.
 *
 * Importa a FONTE em TypeScript (ver tests/lib/resolver-ts.mjs). Reimplementar a
 * regra aqui produziria um teste que concorda consigo mesmo para sempre.
 *
 * Uso: npm run teste:grupos
 */

import {
  REGISTRO_TOOLS,
  clientePodeDesligar,
  clienteVeModulo,
  grupoTool,
  secaoPadraoTemAnomalia,
} from '../src/lib/tools/registro.ts';

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
  ok(recebido === esperado, `${descricao} (esperado ${esperado}, veio ${recebido})`);
}

console.log('\n=== 1. Classificação das tools registradas ===\n');

// GRUPO e PODE-DESLIGAR são declarados SEPARADOS de propósito.
//
// A primeira versão derivava "pode desligar" de "é contratável", e isso estava
// errado: `transferir_humano` não é vendida e ainda assim é decisão do cliente —
// há quem não queira receber atendimento transferido em momento nenhum. Ser
// vendida não responde se pode desligar.
//
// Com as duas colunas explícitas, a tabela abaixo é a intenção escrita à mão, e
// não um eco da implementação.
const ESPERADO = {
  busca_conhecimento: { grupo: 'padrao', podeDesligar: false },
  resolver_conversa: { grupo: 'padrao', podeDesligar: false },
  transferir_humano: { grupo: 'configuravel', podeDesligar: true },
  vendas: { grupo: 'contratavel', podeDesligar: true },
  transcricao_audio: { grupo: 'contratavel', podeDesligar: true },
  foto_produto: { grupo: 'contratavel', podeDesligar: true },
};

for (const [nome, { grupo }] of Object.entries(ESPERADO)) {
  eq(grupoTool(nome), grupo, `${nome}`);
}

// Cobertura: se alguém registrar uma tool nova e esquecer deste teste, o
// esquecimento aparece aqui em vez de aparecer na tela de um cliente.
const naoCobertas = Object.keys(REGISTRO_TOOLS).filter((n) => !(n in ESPERADO));
ok(
  naoCobertas.length === 0,
  `toda tool do registry tem grupo esperado declarado aqui${
    naoCobertas.length ? ` — faltam: ${naoCobertas.join(', ')}` : ''
  }`,
);

console.log('\n=== 2. Tool fora do registry ===\n');

// Decisão registrada: cai em contratável. A agência pode ter criado a linha no
// catálogo e vendido antes de alguém escrever o rótulo — recusar deixaria um
// módulo vendido invisível, e o cliente pagando por algo que não aparece.
eq(grupoTool('modulo_que_nao_existe'), 'contratavel', 'tool desconhecida cai em contratável');
ok(clientePodeDesligar('modulo_que_nao_existe'), 'e o cliente pode desligá-la');

// ATENÇÃO AO QUE AS SEÇÕES ABAIXO COMPARAM.
//
// A primeira versão delas afirmava `clienteVeModulo(n, true) === (grupoTool(n)
// !== 'padrao')`. Isso não é teste: `clienteVeModulo` É `contratado &&
// grupoTool(n) !== 'padrao'`, então a igualdade vale por construção e nenhuma
// mudança de comportamento a derruba. Descobri sabotando — marcar
// transferir_humano como contratável reprovou UMA asserção, quando deveria
// reprovar a linha inteira daquela tool.
//
// Agora tudo compara contra ESPERADO, que é intenção declarada à mão. É a
// diferença entre afirmar o que o sistema deve fazer e repetir o que ele faz.

console.log('\n=== 3. Exibição: só aparece o que dá para agir ===\n');

for (const [nome, { grupo }] of Object.entries(ESPERADO)) {
  ok(
    clienteVeModulo(nome, false) === false,
    `${nome}: não contratado nunca aparece para o cliente`,
  );
  eq(
    clienteVeModulo(nome, true),
    grupo !== 'padrao',
    `${nome}: contratado aparece? (declarado ${grupo})`,
  );
}

console.log('\n=== 4. Capacidade: quem o cliente pode desligar ===\n');

for (const [nome, { podeDesligar }] of Object.entries(ESPERADO)) {
  eq(clientePodeDesligar(nome), podeDesligar, `${nome}: pode desligar?`);
}

// A PROPRIEDADE QUE LIGA AS DUAS COLUNAS: quem pode desligar tem de aparecer.
// Um módulo desligável e invisível seria decisão do cliente sem lugar para ele
// tomar — foi exatamente o buraco que `transferir_humano` caiu quando "pode
// desligar" saía do grupo: o switch sumiu da tela e ninguém tinha como religar.
for (const [nome, { podeDesligar }] of Object.entries(ESPERADO)) {
  if (!podeDesligar) continue;
  ok(clienteVeModulo(nome, true), `${nome}: é desligável, então aparece quando contratado`);
}

// TELA e SERVIDOR contra a mesma intenção. O servidor (`alternarModulo`) chama
// `clientePodeDesligar`; a tela decide onde o switch aparece. Se divergirem,
// aparece switch que o servidor recusa — ou o servidor aceita o que sumiu.
for (const [nome, { podeDesligar }] of Object.entries(ESPERADO)) {
  eq(clientePodeDesligar(nome), podeDesligar, `${nome}: servidor aceita desligar`);
}

console.log('\n=== 5. Seção do admin abre sozinha quando há anomalia ===\n');

// A PROPRIEDADE, não o estado do mundo: "se existe módulo padrão contratado e
// desligado, a seção abre". Vale para qualquer lista, inclusive as que não
// existem hoje no banco.
const L = (contratado, ativo) => ({ contratado, ativo });

eq(secaoPadraoTemAnomalia([]), false, 'lista vazia não abre');
eq(secaoPadraoTemAnomalia([L(true, true)]), false, 'tudo contratado e ligado não abre');
eq(secaoPadraoTemAnomalia([L(true, false)]), true, 'contratado e DESLIGADO abre');
eq(
  secaoPadraoTemAnomalia([L(false, false)]),
  false,
  'não contratado não é anomalia (nunca foi ligado)',
);
eq(
  secaoPadraoTemAnomalia([L(true, true), L(true, true), L(true, false)]),
  true,
  'um desligado no meio de ligados abre',
);
eq(
  secaoPadraoTemAnomalia([L(false, false), L(true, true)]),
  false,
  'sem desligado contratado, não abre',
);

console.log('\n=== 6. Estado impossível não é representável ===\n');

// `grupo` é derivado de `contratavel` + `temConfigCliente`, então não há como
// escrever "padrão que configura". Esta asserção existe para o dia em que
// alguém trocar a derivação por um campo próprio: aí o par volta a poder
// contradizer, e é aqui que aparece.
for (const [nome, def] of Object.entries(REGISTRO_TOOLS)) {
  const grupo = grupoTool(nome);
  ok(
    !(grupo === 'padrao' && def.temConfigCliente),
    `${nome}: não é padrão com configuração de cliente`,
  );
  ok(
    !(grupo === 'padrao' && def.contratavel),
    `${nome}: não é padrão e vendável ao mesmo tempo`,
  );
}

console.log('\n' + '-'.repeat(60));
console.log(`  ${passou} passaram, ${falhou} falharam\n`);

// `exitCode` e NÃO `process.exit()`. Com o hook de resolver registrado, sair
// abruptamente no Windows dispara uma assertion do libuv
// (`!(handle->flags & UV_HANDLE_CLOSING)`) que derruba o processo com 127 —
// mascarando tanto o verde quanto o vermelho. Deixar o processo terminar
// sozinho fecha o worker do loader antes.
process.exitCode = falhou > 0 ? 1 : 0;
