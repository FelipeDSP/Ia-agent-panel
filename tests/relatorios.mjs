#!/usr/bin/env node
/**
 * A aritmética dos Relatórios do cliente.
 *
 * Não toca no banco: importa as funções puras de `src/lib/relatorios/agregar.ts`
 * e exercita os casos que ninguém testa abrindo a tela — virada de dia no fuso
 * da loja, mês sem nada, turno sem par de mensagens.
 *
 * O RISCO DESTA TELA é específico: número errado aqui não dá erro, dá DECISÃO
 * errada. "Seu pico é às 22h" faz o dono pensar em mudar horário de
 * funcionamento; se for erro de fuso, ele muda por causa de um bug.
 *
 * Uso: npm run teste:relatorios
 */

import {
  atendimento,
  clientesQueVoltaram,
  conversasPorDia,
  diaLocal,
  horaLocal,
  pedidos,
  picos,
  porHora,
  tempoDeResposta,
} from '../src/lib/relatorios/agregar.ts';

let ok = 0;
const falhas = [];
const chk = (n, c, d = '') => {
  if (c) { ok++; console.log(`  OK    ${n}`); }
  else { falhas.push(`${n}${d ? ' — ' + d : ''}`); console.log(`  FALHA ${n}${d ? ' — ' + d : ''}`); }
};

const RO = 'America/Porto_Velho'; // UTC-4, sem horário de verão
const SP = 'America/Sao_Paulo';

console.log('\n== Relatórios ==\n');

// -------------------------------------------------------------------------
console.log('-- 1. O fuso é o da loja, não o do servidor --\n');

// 01:00 UTC de dia 12 é 21:00 do dia 11 em Rondônia. É a virada que faz o
// relatório mentir sobre o horário E sobre o dia, de uma vez só.
chk('01:00 UTC vira 21h em Rondônia', horaLocal('2026-08-12T01:00:00Z', RO) === 21,
  String(horaLocal('2026-08-12T01:00:00Z', RO)));
chk('e o DIA também volta um', diaLocal('2026-08-12T01:00:00Z', RO) === '2026-08-11',
  diaLocal('2026-08-12T01:00:00Z', RO));
chk('mesma hora em São Paulo é 22h (fusos diferentes, respostas diferentes)',
  horaLocal('2026-08-12T01:00:00Z', SP) === 22, String(horaLocal('2026-08-12T01:00:00Z', SP)));
chk('meia-noite local não vira 24', horaLocal('2026-08-12T04:00:00Z', RO) === 0,
  String(horaLocal('2026-08-12T04:00:00Z', RO)));

// -------------------------------------------------------------------------
console.log('\n-- 2. O histograma conta o cliente, não o agente --\n');

const msgs = [
  { criado_em: '2026-08-12T18:00:00Z', direcao: 'entrada', execucao_id: 'a' }, // 14h RO
  { criado_em: '2026-08-12T18:00:20Z', direcao: 'saida', execucao_id: 'a' },
  { criado_em: '2026-08-12T19:00:00Z', direcao: 'entrada', execucao_id: 'b' }, // 15h RO
  { criado_em: '2026-08-12T19:00:08Z', direcao: 'saida', execucao_id: 'b' },
  { criado_em: '2026-08-12T19:30:00Z', direcao: 'entrada', execucao_id: 'c' }, // 15h RO
  { criado_em: '2026-08-12T19:30:40Z', direcao: 'saida', execucao_id: 'c' },
];

const h = porHora(msgs, RO);
chk('soma = só as entradas (3, não 6)', h.reduce((a, b) => a + b, 0) === 3,
  String(h.reduce((a, b) => a + b, 0)));
chk('14h tem 1', h[14] === 1, String(h[14]));
chk('15h tem 2', h[15] === 2, String(h[15]));
chk('o pico é 15h', picos(h)[0]?.hora === 15, JSON.stringify(picos(h)));
chk('hora sem movimento não entra nos picos', picos(h).every((p) => p.n > 0));

// -------------------------------------------------------------------------
console.log('\n-- 3. "Resolveu sozinho" olha pausado_em, não o status de agora --\n');

const convs = [
  // ATENDIDA POR GENTE e já encerrada: voltou a 'ativo', mas passou por humano.
  { status_efetivo: 'ativo', phone: '5569900000001', criado_em: '2026-08-12T18:00:00Z', pausado_em: '2026-08-12T18:05:00Z' },
  { status_efetivo: 'pausado', phone: '5569900000002', criado_em: '2026-08-12T19:00:00Z', pausado_em: '2026-08-12T19:01:00Z' },
  { status_efetivo: 'ativo', phone: '5569900000003', criado_em: '2026-08-12T20:00:00Z', pausado_em: null },
  { status_efetivo: 'ativo', phone: '5569900000003', criado_em: '2026-08-13T20:00:00Z', pausado_em: null },
];

const at = atendimento(convs);
chk('duas passaram por gente (uma delas já voltou a ativo)', at.comHumano === 2, String(at.comHumano));
chk('o agente levou duas sozinho', at.soAgente === 2, String(at.soAgente));
/*
 * `status_efetivo`, não `status` — as fixtures acompanham a view
 * `conversas_painel` (migração 51), que é de onde os Relatórios passaram a ler.
 * Com o cru, `pausadasAgora` contava a LÁPIDE: pausa vencida seguia gravada como
 * 'pausado' e o número nunca drenava. A pergunta que ele responde continua sendo
 * "quantas estão em atendimento humano AGORA" — mudou a fonte, não a pergunta.
 */
chk('só UMA está pausada agora — é outra pergunta', at.pausadasAgora === 1, String(at.pausadasAgora));
chk('50% resolvidas sozinho', at.pctSoAgente === 50, String(at.pctSoAgente));

// Sem conversa, percentual é AUSÊNCIA e não zero: "0% precisaram de atendente"
// soa como resultado.
chk('sem conversa nenhuma, o percentual é null e não 0',
  atendimento([]).pctSoAgente === null, String(atendimento([]).pctSoAgente));

const volta = clientesQueVoltaram(convs);
chk('três pessoas distintas', volta.pessoas === 3, String(volta.pessoas));
chk('uma voltou', volta.voltaram === 1, String(volta.voltaram));
chk('telefone nulo não vira pessoa',
  clientesQueVoltaram([{ status_efetivo: 'ativo', phone: null, criado_em: '2026-08-12T18:00:00Z', pausado_em: null }]).pessoas === 0);

const dias = conversasPorDia(convs, RO);
chk('agrupa por dia LOCAL (2 dias, não 1)', dias.length === 2, JSON.stringify(dias));

// -------------------------------------------------------------------------
console.log('\n-- 4. Tempo de resposta: mediana, e sem inventar par --\n');

const r = tempoDeResposta(msgs);
chk('três turnos com par', r?.turnos === 3, JSON.stringify(r));
chk('mediana 20s (8, 20, 40 — a média seria 22,7)', r?.medianaSegundos === 20, JSON.stringify(r));

// Turno sem saída: descartado. Virar zero diria "respondeu na hora" para uma
// execução que morreu no meio — falha entrando na conta como excelência.
const soEntrada = [{ criado_em: '2026-08-12T18:00:00Z', direcao: 'entrada', execucao_id: 'x' }];
chk('turno sem par é descartado, não vira 0s', tempoDeResposta(soEntrada) === null,
  JSON.stringify(tempoDeResposta(soEntrada)));
chk('mensagem sem execucao_id (antes da migração 37) é ignorada',
  tempoDeResposta([{ criado_em: '2026-08-12T18:00:00Z', direcao: 'entrada', execucao_id: null }]) === null);

// -------------------------------------------------------------------------
console.log('\n-- 5. Pedidos: receita só do que foi pago --\n');

const p = pedidos([
  { status: 'pago', total_centavos: 33180, criado_em: '2026-08-12T18:00:00Z' },
  { status: 'pago', total_centavos: 2000, criado_em: '2026-08-12T18:00:00Z' },
  { status: 'aguardando_pagamento', total_centavos: 5000, criado_em: '2026-08-12T18:00:00Z' },
  { status: 'rascunho', total_centavos: 9900, criado_em: '2026-08-12T18:00:00Z' },
  { status: 'expirado', total_centavos: 1000, criado_em: '2026-08-12T18:00:00Z' },
]);
chk('receita = 351,80 (só os pagos)', p.receitaCentavos === 35180, String(p.receitaCentavos));
chk('o carrinho abandonado é contado à parte', p.rascunho === 1, String(p.rascunho));
chk('aguardando não entra na receita', p.aguardando === 1 && p.receitaCentavos === 35180);
chk('total_centavos nulo não quebra a soma',
  pedidos([{ status: 'pago', total_centavos: null, criado_em: 'x' }]).receitaCentavos === 0);

// -------------------------------------------------------------------------
console.log('\n-- 6. Sabotagem --\n');

// Cada uma reproduz um defeito PLAUSÍVEL — não absurdo — e confirma que alguma
// asserção acima o pegaria.
chk('sabotagem: contar saída junto dobraria o histograma',
  msgs.length !== 3 && msgs.filter((m) => m.direcao === 'entrada').length === 3,
  'o cenário precisa ter saída para a asserção da soma significar algo');

/*
 * O campo virou `status_efetivo` quando os Relatórios passaram a ler a view
 * `conversas_painel` (migração 51). A sabotagem continua medindo a MESMA coisa:
 * `comHumano` conta quem JÁ passou por gente (marca em `pausado_em`, inclusive
 * quem voltou a ativo), e o status conta quem está pausada AGORA. São perguntas
 * diferentes, e o cenário precisa fazê-las divergir — senão trocar uma pela
 * outra passaria despercebido.
 */
chk('sabotagem: usar `status_efetivo` no lugar de `pausado_em` daria 1 e não 2',
  convs.filter((c) => c.status_efetivo === 'pausado').length === 1 && at.comHumano === 2,
  'as duas contagens precisam divergir no cenário, senão a asserção não mede nada');

chk('sabotagem: média no lugar de mediana daria 23 e não 20',
  Math.round((8 + 20 + 40) / 3) !== 20 && r?.medianaSegundos === 20);

chk('sabotagem: fuso fixo em UTC diria 18h/19h em vez de 14h/15h',
  horaLocal('2026-08-12T18:00:00Z', 'UTC') === 18 && horaLocal('2026-08-12T18:00:00Z', RO) === 14);

console.log('\n' + '-'.repeat(58));
console.log(`  ${ok} passaram, ${falhas.length} falharam`);
for (const f of falhas) console.log(`  ! ${f}`);
console.log();
process.exitCode = falhas.length > 0 ? 1 : 0;
