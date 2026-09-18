/**
 * "Avisos para você" (18/09) — `src/lib/tools/avisos.ts`: um número e uma lista
 * do que avisar, gravados nas duas configs (transferência e vendas).
 *
 * Propriedades: leitura junta as duas configs (número de vendas prevalece);
 * WhatsApp ligado exige número válido e ao menos um aviso; `aplicarAvisos`
 * preserva `sessao` e as chaves alheias de cada config, deriva o canal
 * (sessão → waha, sem sessão → chatwoot, desligado → nenhum) e grava eventos
 * vazios como "todos" (é como o banco lê). Também os validadores que
 * encolheram: transferência sem notificação (e com "horário da loja") e
 * vendas sem notificação.
 *
 *   node --import ./tests/lib/ts.mjs tests/avisos-painel.mjs
 */
import { lerAvisos, validarAvisos, aplicarAvisos } from '../src/lib/tools/avisos.ts';
import { validarTransferirCliente } from '../src/lib/tools/transferir-humano.ts';
import { validarVendasCliente } from '../src/lib/tools/vendas-config.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
const form = (campos) => { const fd = new FormData(); for (const [k, v] of Object.entries(campos)) fd.set(k, v); return fd; };

console.log('\n== lerAvisos ==\n');
{
  const tr = { horario: { timezone: 'America/Sao_Paulo', dias_semana: [1], hora_inicio: 8, hora_fim: 18 }, notificacao: { canal: 'waha', sessao: 'emporio', destino: '5511@c.us' } };
  const ve = { pagamentos: ['na_retirada'], eventos: ['pedido_fechado'], notificacao: { canal: 'chatwoot', destino: '5522@c.us', nota_chatwoot: true } };
  const a = lerAvisos(tr, ve, true);
  chk('junta as duas: whatsapp ligado, número de VENDAS prevalece, transferência ligada, eventos, nota', a.whatsapp && a.numero === '5522' && a.transferencia && a.eventos.join() === 'pedido_fechado' && a.nota_chatwoot, JSON.stringify(a));
  const b = lerAvisos(tr, null, false);
  chk('sem vendas: número da transferência, eventos vazios', b.numero === '5511' && b.eventos.length === 0 && b.transferencia);
  const c = lerAvisos({ notificacao: { canal: 'nenhum' } }, {}, true);
  chk('tudo desligado: whatsapp false, eventos = todos (default do banco), nota false', !c.whatsapp && c.eventos.length === 3 && !c.nota_chatwoot);
}

console.log('\n== validarAvisos ==\n');
{
  const r = validarAvisos(form({ whatsapp: 'on', destino: '556993666645', aviso_transferencia: 'on', evento_pedido_fechado: 'on', nota_chatwoot: 'on' }), { vendasContratada: true });
  chk('ok completo', r.ok && r.valor.destino === '556993666645@c.us' && r.valor.transferencia && r.valor.eventos.join() === 'pedido_fechado' && r.valor.nota_chatwoot, JSON.stringify(r));
  const r2 = validarAvisos(form({ whatsapp: 'on', aviso_transferencia: 'on' }), { vendasContratada: true });
  chk('whatsapp sem número -> erro em destino', !r2.ok && 'destino' in r2.erros);
  const r3 = validarAvisos(form({ whatsapp: 'on', destino: '556993666645' }), { vendasContratada: true });
  chk('whatsapp sem nenhum aviso marcado -> erro em whatsapp', !r3.ok && 'whatsapp' in r3.erros);
  const r4 = validarAvisos(form({ destino: '69993666645' }), { vendasContratada: false });
  chk('número sem país -> erro em destino (mesmo desligado, se informado)', !r4.ok && 'destino' in r4.erros);
  const r5 = validarAvisos(form({ whatsapp: 'on', destino: '556993666645', evento_pedido_fechado: 'on', nota_chatwoot: 'on' }), { vendasContratada: false });
  chk('sem vendas contratada, eventos e nota são ignorados -> erro (nenhum aviso)', !r5.ok && 'whatsapp' in r5.erros);
  const r6 = validarAvisos(form({}), { vendasContratada: true });
  chk('tudo vazio -> ok, desligado', r6.ok && !r6.valor.whatsapp && r6.valor.eventos.length === 0);
}

console.log('\n== aplicarAvisos ==\n');
{
  const tr = { horario: { timezone: 'America/Sao_Paulo', dias_semana: [1], hora_inicio: 8, hora_fim: 18 }, horario_da_loja: true, notificacao: { canal: 'nenhum', sessao: 'emporio' } };
  const ve = { pagamentos: ['na_retirada'], pedir_nome: true, horas_expirar_pagamento: '48', notificacao: { canal: 'nenhum' } };
  const v = { whatsapp: true, destino: '5533@c.us', transferencia: true, eventos: ['pagamento_confirmado'], nota_chatwoot: true };
  const r = aplicarAvisos(v, tr, ve);
  chk('transferência: canal waha (tem sessão), sessão preservada, destino novo, horário e horario_da_loja intactos',
    r.transferir.notificacao.canal === 'waha' && r.transferir.notificacao.sessao === 'emporio' && r.transferir.notificacao.destino === '5533@c.us' && r.transferir.horario_da_loja === true && r.transferir.horario.hora_fim === 18, JSON.stringify(r.transferir));
  chk('vendas: canal chatwoot (sem sessão), eventos, nota, destino; pagamentos/pedir_nome/horas_expirar preservados',
    r.vendas.notificacao.canal === 'chatwoot' && r.vendas.eventos.join() === 'pagamento_confirmado' && r.vendas.notificacao.nota_chatwoot === true && r.vendas.notificacao.destino === '5533@c.us'
    && r.vendas.pagamentos.join() === 'na_retirada' && r.vendas.pedir_nome === true && r.vendas.horas_expirar_pagamento === '48', JSON.stringify(r.vendas));
  const r2 = aplicarAvisos({ whatsapp: false, transferencia: false, eventos: [], nota_chatwoot: true }, tr, ve);
  chk('whatsapp desligado: canal nenhum nos dois; eventos vazios viram todos; nota fica', r2.transferir.notificacao.canal === 'nenhum' && r2.vendas.notificacao.canal === 'nenhum' && r2.vendas.eventos.length === 3 && r2.vendas.notificacao.nota_chatwoot === true);
  const r3 = aplicarAvisos(v, tr, null);
  chk('sem vendas: só a transferência é escrita', r3.transferir && r3.vendas === null);
  const r4 = aplicarAvisos({ whatsapp: true, destino: '5533@c.us', transferencia: false, eventos: ['pedido_fechado'], nota_chatwoot: false }, tr, ve);
  chk('whatsapp ligado só para vendas: transferência fica nenhum, vendas waha/chatwoot', r4.transferir.notificacao.canal === 'nenhum' && r4.vendas.notificacao.canal === 'chatwoot');
}

console.log('\n== validadores que encolheram ==\n');
{
  const t1 = validarTransferirCliente(form({ quando: 'loja' }));
  chk('transferência "horário da loja": ok sem ler os campos de hora', t1.ok && t1.valor.horario_da_loja === true && t1.valor.horario === undefined);
  const t2 = validarTransferirCliente(form({ quando: 'proprio', timezone: 'America/Porto_Velho', dia_1: 'on', hora_inicio: '9', hora_fim: '17' }));
  chk('transferência "outro horário": valida e devolve o horário', t2.ok && t2.valor.horario_da_loja === false && t2.valor.horario.hora_inicio === 9);
  const t3 = validarTransferirCliente(form({ quando: 'proprio', timezone: 'x' }));
  chk('"outro horário" inválido -> erros', !t3.ok && 'timezone' in t3.erros);
  const v1 = validarVendasCliente(form({ pagamento_na_retirada: 'on', entrega: 'nao' }), { transferirDisponivel: false, linkDisponivel: false });
  chk('vendas: sem campos de notificação no retorno', v1.ok && !('notificar' in v1.valor) && !('eventos' in v1.valor));
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
