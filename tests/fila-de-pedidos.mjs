/**
 * A fila de pedidos (migração 83) — agrupamento, próximo passo e busca.
 *
 * Por que isto é um módulo puro e não lógica dentro do componente: fila que só
 * existe dentro de JSX se testa clicando, e clicar não entra na suíte. Aqui o
 * relógio é um argumento, então "o que é hoje às 23h50 em Ariquemes" é uma
 * asserção, não uma tentativa.
 *
 * E o `resolverQuando` do serviço entra junto, porque os dois são o mesmo
 * caminho visto de dois lados: o agente resolve a hora da loja para um
 * instante, a fila devolve o instante ao dia da loja. Se divergirem, o pedido
 * marcado para as 7h aparece em "ontem".
 *
 *   npm run teste:fila-de-pedidos
 */
import { montarFila, grupoDe, naFila, proximoPasso, casaBusca, diaLocal, horaLocal }
  from '../src/app/(app)/painel/pedidos/fila.ts';
import { resolverQuando, narrarQuando } from '../agente/src/pedido/quando.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  ok    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ' — ' + det : ''}`); }
};

const TZ = 'America/Porto_Velho'; // o fuso do Empório: UTC-4, sem horário de verão
const SP = 'America/Sao_Paulo';

const ped = (p) => ({
  id: p.id ?? 'x', numero: p.numero ?? 1, status: p.status ?? 'aguardando_pagamento',
  total_centavos: 1500, quando_em: p.quando_em ?? null, separado_em: p.separado_em ?? null,
  retirado_em: p.retirado_em ?? null, pago_em: p.pago_em ?? null,
  pagamento_modo: p.pagamento_modo ?? 'na_retirada', retirada_nome: p.retirada_nome ?? null,
  conversation_id: p.conversation_id ?? 48, criado_em: p.criado_em ?? '2026-10-06T10:00:00.000Z',
  itens: 2,
});

console.log('\n== 1. O que ENTRA na fila ==\n');
chk('pedido fechado aguardando pagamento entra', naFila(ped({})));
chk('pedido pago e não retirado entra', naFila(ped({ status: 'pago' })));
chk('RASCUNHO fica de fora — ainda está sendo montado na conversa',
  !naFila(ped({ status: 'rascunho' })));
chk('retirado sai da fila', !naFila(ped({ status: 'pago', retirado_em: '2026-10-06T12:00:00Z' })));
chk('cancelado não entra', !naFila(ped({ status: 'cancelado' })));
chk('expirado não entra', !naFila(ped({ status: 'expirado' })));

console.log('\n== 2. O agrupamento, com relógio de verdade ==\n');
// 06/10/2026 é uma terça. 14:00 em Porto Velho = 18:00Z.
const agora = new Date('2026-10-06T18:00:00.000Z');
chk('o relógio de teste é 06/10 no fuso da loja', diaLocal(agora, TZ) === '2026-10-06', diaLocal(agora, TZ));

const g = (quando) => grupoDe(ped({ quando_em: quando }), agora, TZ);
chk('ontem -> atrasado', g('2026-10-05T11:00:00.000Z') === 'atrasado');
chk('hoje mais tarde -> hoje', g('2026-10-06T22:00:00.000Z') === 'hoje');
chk('hoje JÁ PASSOU da hora -> continua HOJE, não atrasado',
  g('2026-10-06T11:00:00.000Z') === 'hoje', g('2026-10-06T11:00:00.000Z'));
chk('amanhã -> amanha', g('2026-10-07T11:00:00.000Z') === 'amanha');
chk('depois de amanhã -> depois', g('2026-10-09T11:00:00.000Z') === 'depois');
chk('sem hora -> sem_horario', g(null) === 'sem_horario');

// A virada do dia é onde o fuso morde: 06/10 23:30 em Porto Velho é 07/10
// 03:30Z. Agrupar pelo dia UTC poria um pedido de HOJE em "amanhã".
const quase = new Date('2026-10-07T03:30:00.000Z');
chk('23:30 na loja ainda é HOJE (não o dia UTC seguinte)',
  diaLocal(quase, TZ) === '2026-10-06', diaLocal(quase, TZ));
chk('e o mesmo instante JÁ É 07/10 em São Paulo — o fuso importa',
  diaLocal(quase, SP) === '2026-10-07', diaLocal(quase, SP));

console.log('\n== 3. A ordem dentro do grupo ==\n');
const fila = montarFila([
  ped({ id: 'b', quando_em: '2026-10-06T20:00:00.000Z' }),       // hoje 16:00
  ped({ id: 'a', quando_em: '2026-10-06T11:00:00.000Z' }),       // hoje 07:00
  ped({ id: 'atrasado', quando_em: '2026-10-05T11:00:00.000Z' }),
  ped({ id: 'sem', quando_em: null, criado_em: '2026-10-01T10:00:00Z' }),
  ped({ id: 'sem2', quando_em: null, criado_em: '2026-10-03T10:00:00Z' }),
  ped({ id: 'rascunho', status: 'rascunho' }),
], agora, TZ);
chk('a varredura montou grupos (lista vazia reprova antes de comparar)', fila.length > 0, String(fila.length));
chk('ATRASADO vem primeiro — é o que ninguém pode deixar passar',
  fila[0]?.chave === 'atrasado', fila.map((x) => x.chave).join(','));
const hoje = fila.find((x) => x.chave === 'hoje');
chk('dentro de HOJE, a hora manda', hoje?.pedidos.map((p) => p.id).join(',') === 'a,b',
  hoje?.pedidos.map((p) => p.id).join(','));
const sem = fila.find((x) => x.chave === 'sem_horario');
chk('sem hora, quem pediu primeiro vem primeiro', sem?.pedidos.map((p) => p.id).join(',') === 'sem,sem2',
  sem?.pedidos.map((p) => p.id).join(','));
chk('o rascunho não apareceu em grupo nenhum',
  !fila.some((x) => x.pedidos.some((p) => p.id === 'rascunho')));

console.log('\n== 4. Um botão só: o próximo passo ==\n');
chk('ainda não separado -> separar', proximoPasso(ped({})) === 'separar');
chk('separado e aguardando pagamento -> pago',
  proximoPasso(ped({ separado_em: '2026-10-06T11:00:00Z' })) === 'pago');
chk('separado e pago -> retirado',
  proximoPasso(ped({ separado_em: '2026-10-06T11:00:00Z', status: 'pago' })) === 'retirado');
chk('já retirado -> nada a fazer',
  proximoPasso(ped({ status: 'pago', retirado_em: '2026-10-06T12:00:00Z' })) === null);

console.log('\n== 5. A busca que a pessoa de fato faz ==\n');
const douglas = ped({ numero: 7, retirada_nome: 'Douglas', conversation_id: 48 });
chk('acha pelo número', casaBusca(douglas, '7'));
chk('acha pelo "nº 7"', casaBusca(douglas, 'nº 7'));
chk('acha pelo nome', casaBusca(douglas, 'doug'));
chk('acha SEM acento e sem caixa', casaBusca(ped({ retirada_nome: 'Débora' }), 'debora'));
chk('não casa com quem não é', !casaBusca(douglas, 'maria'));
chk('busca vazia mostra tudo', casaBusca(douglas, '   '));

console.log('\n== 6. O par com o serviço: hora da loja -> instante -> hora da loja ==\n');
const iso = resolverQuando('2026-10-07T07:00', TZ);
chk('o serviço resolve a hora da loja para um instante', typeof iso === 'string', String(iso));
chk('07:00 em Porto Velho é 11:00Z', iso === '2026-10-07T11:00:00.000Z', String(iso));
chk('e a fila devolve 07:00 ao ler de volta', horaLocal(iso, TZ) === '07:00', horaLocal(iso, TZ));
chk('o mesmo instante em São Paulo seria outra hora — por isso o fuso é do tenant',
  horaLocal(iso, SP) === '08:00', horaLocal(iso, SP));
chk('e cai no grupo AMANHÃ, visto de hoje', grupoDe(ped({ quando_em: iso }), agora, TZ) === 'amanha');
chk('a narração sai em português, no fuso da loja',
  /07\/10 às 07:00/.test(narrarQuando(iso, TZ)), narrarQuando(iso, TZ));

console.log('\n== 7. O que o modelo escreve errado NÃO derruba a venda ==\n');
for (const ruim of ['manhã', 'amanhã às 7', '2026-13-01T07:00', '2026-02-31T07:00', '', null, undefined, '07:00']) {
  chk(`"${String(ruim)}" vira null (sem hora), não exceção`, resolverQuando(ruim, TZ) === null,
    String(resolverQuando(ruim, TZ)));
}
chk('e um pedido sem hora continua entrando na fila, em "sem horário"',
  grupoDe(ped({ quando_em: null }), agora, TZ) === 'sem_horario');

console.log('\n== 8. Sabotagem ==\n');
// S1: agrupar pelo dia UTC em vez do dia da loja
const diaUtc = (iso2) => new Date(iso2).toISOString().slice(0, 10);
chk('S1: agrupar por dia UTC poria um pedido de hoje 23:30 no dia errado',
  diaUtc('2026-10-07T03:30:00.000Z') !== diaLocal(quase, TZ));
// S2: ordenar por CRIAÇÃO em vez de hora inverte a fila. O fixture é feito
// para os dois critérios discordarem — sem isso a asserção passaria por acaso
// e eu não saberia qual dos dois a fila de fato usa.
const discordam = montarFila([
  ped({ id: 'cedo',  quando_em: '2026-10-06T11:00:00.000Z', criado_em: '2026-10-06T09:00:00Z' }),
  ped({ id: 'tarde', quando_em: '2026-10-06T20:00:00.000Z', criado_em: '2026-10-06T08:00:00Z' }),
], agora, TZ).find((x) => x.chave === 'hoje');
const porHora = discordam?.pedidos.map((p) => p.id).join(',');
chk('S2: com hora e criação DISCORDANDO, a fila segue a hora', porHora === 'cedo,tarde', String(porHora));
chk('S2: ...e seguir a criação daria a ordem oposta — a sabotagem muda o resultado',
  [...(discordam?.pedidos ?? [])].sort((a, b) => a.criado_em.localeCompare(b.criado_em))
    .map((p) => p.id).join(',') === 'tarde,cedo');
console.log(`\n${falhas.length ? 'FALHOU' : 'passaram'}: ${ok} ok, ${falhas.length} falhas`);
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
