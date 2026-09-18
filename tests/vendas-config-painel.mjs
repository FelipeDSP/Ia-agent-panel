/**
 * `src/lib/tools/vendas-config.ts` — o que o painel grava em
 * `tenant_tools.config` de `vendas` (migração 69) e como lê o que está lá.
 *
 * Propriedades: a leitura preenche defaults iguais aos de `vendas_oferta()` no
 * banco (ausente = ['link'], entrega 'nao', todos os eventos); valor inválido
 * é descartado, não vira erro; o formulário exige ao menos uma forma de pagar;
 * `entrega = atendente` só com a transferência disponível; WhatsApp exige
 * número válido; sem evento marcado com aviso ligado é erro; a lista de
 * eventos gravada nunca é vazia (vazio no banco = todos).
 *
 *   node --import ./tests/lib/ts.mjs tests/vendas-config-painel.mjs
 */
import { EVENTOS, canalDerivado, lerConfigVendas, validarVendasCliente, validarVendasAgencia, VENDAS_PADRAO } from '../src/lib/tools/vendas-config.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
const form = (campos) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  return fd;
};
const TODOS = EVENTOS.map((e) => e.valor).join(',');

console.log('\n== lerConfigVendas ==\n');
{
  const v = lerConfigVendas({});
  chk('{} -> defaults: link, entrega nao, todos os eventos, canal nenhum', v.pagamentos.join() === 'link' && v.entrega === 'nao' && v.eventos.join() === TODOS && v.notificacao.canal === 'nenhum', JSON.stringify(v));
  chk('null/undefined/string -> defaults, sem lançar', lerConfigVendas(null).pagamentos.join() === 'link' && lerConfigVendas(undefined).entrega === 'nao' && lerConfigVendas('x').eventos.join() === TODOS);
  const v2 = lerConfigVendas({ pagamentos: ['na_retirada', 'fiado', 'na_retirada'], entrega: 'atendente', eventos: ['pedido_cancelado', 'x'], notificacao: { canal: 'waha', sessao: 's', destino: '55@c.us', nota_chatwoot: true }, horas_expirar_pagamento: '48' });
  chk('inválido descartado, duplicata removida, resto preservado', v2.pagamentos.join() === 'na_retirada' && v2.entrega === 'atendente' && v2.eventos.join() === 'pedido_cancelado' && v2.notificacao.canal === 'waha' && v2.notificacao.sessao === 's' && v2.notificacao.destino === '55@c.us' && v2.notificacao.nota_chatwoot === true, JSON.stringify(v2));
  chk('pagamentos só com inválidos -> default link (igual ao banco)', lerConfigVendas({ pagamentos: ['fiado'] }).pagamentos.join() === 'link');
  chk('entrega desconhecida -> nao; nota_chatwoot "true" (string) -> ausente', lerConfigVendas({ entrega: 'sim' }).entrega === 'nao' && lerConfigVendas({ notificacao: { nota_chatwoot: 'true' } }).notificacao.nota_chatwoot === undefined);
  chk('VENDAS_PADRAO é o mesmo que ler {}', JSON.stringify(VENDAS_PADRAO) === JSON.stringify(lerConfigVendas({})));
}

console.log('\n== validarVendasCliente ==\n');
{
  const base = { pagamento_link: 'on', pagamento_na_retirada: 'on', entrega: 'nao', evento_pedido_fechado: 'on' };
  const r = validarVendasCliente(form(base), { transferirDisponivel: false });
  chk('duas formas, entrega nao, um evento -> ok', r.ok && r.valor.pagamentos.join() === 'link,na_retirada' && r.valor.entrega === 'nao' && r.valor.eventos.join() === 'pedido_fechado' && r.valor.notificar === false && r.valor.nota_chatwoot === false, JSON.stringify(r));
  const r2 = validarVendasCliente(form({ entrega: 'nao' }), { transferirDisponivel: false });
  chk('nenhuma forma -> erro em pagamentos', !r2.ok && 'pagamentos' in r2.erros);
  const r3 = validarVendasCliente(form({ ...base, entrega: 'atendente' }), { transferirDisponivel: false });
  chk('atendente sem transferência -> erro em entrega', !r3.ok && 'entrega' in r3.erros);
  const r4 = validarVendasCliente(form({ ...base, entrega: 'atendente' }), { transferirDisponivel: true });
  chk('atendente com transferência -> ok', r4.ok && r4.valor.entrega === 'atendente');
  const r5 = validarVendasCliente(form({ pagamento_link: 'on', entrega: 'nao' }), { transferirDisponivel: false });
  chk('sem evento marcado e sem aviso -> ok, eventos = todos (vazio no banco seria "todos")', r5.ok && r5.valor.eventos.join() === TODOS);
  const r6 = validarVendasCliente(form({ pagamento_link: 'on', entrega: 'nao', nota_chatwoot: 'on' }), { transferirDisponivel: false });
  chk('nota ligada sem evento -> erro em eventos', !r6.ok && 'eventos' in r6.erros);
  const r7 = validarVendasCliente(form({ ...base, notificar: 'on' }), { transferirDisponivel: false });
  chk('WhatsApp ligado sem número -> erro em destino', !r7.ok && 'destino' in r7.erros);
  const r8 = validarVendasCliente(form({ ...base, notificar: 'on', destino: '69993666645' }), { transferirDisponivel: false });
  chk('número sem país (11 dígitos) -> erro em destino', !r8.ok && 'destino' in r8.erros);
  const r9 = validarVendasCliente(form({ ...base, notificar: 'on', destino: '556993666645', nota_chatwoot: 'on' }), { transferirDisponivel: false });
  chk('número com país -> notificar, destino @c.us, nota true', r9.ok && r9.valor.notificar === true && r9.valor.destino === '556993666645@c.us' && r9.valor.nota_chatwoot === true, JSON.stringify(r9));
  const r10 = validarVendasCliente(form({ ...base, destino: '556993666645' }), { transferirDisponivel: false });
  chk('número informado com aviso desligado -> guarda o número, notificar false', r10.ok && r10.valor.notificar === false && r10.valor.destino === '556993666645@c.us');
}

console.log('\n== canalDerivado (70): o cliente diz SE; o caminho é derivado da sessão ==\n');
{
  chk('notificar + sessão -> waha', canalDerivado(true, 'emporio') === 'waha');
  chk('notificar sem sessão -> chatwoot (inbox do agente)', canalDerivado(true, undefined) === 'chatwoot' && canalDerivado(true, '') === 'chatwoot' && canalDerivado(true, null) === 'chatwoot');
  chk('não notificar -> nenhum, com ou sem sessão', canalDerivado(false, 'emporio') === 'nenhum' && canalDerivado(false, null) === 'nenhum');
  chk('lerConfigVendas aceita canal chatwoot', lerConfigVendas({ notificacao: { canal: 'chatwoot', destino: '55@c.us' } }).notificacao.canal === 'chatwoot');
}

console.log('\n== 18/09: sem o módulo de pagamento, "por link" não vale ==\n');
{
  const r = validarVendasCliente(form({ pagamento_link: 'on', entrega: 'nao' }), { transferirDisponivel: false, linkDisponivel: false });
  chk('link marcado sem o módulo -> erro em pagamentos', !r.ok && /Asaas/.test(r.erros.pagamentos ?? ''));
  const r2 = validarVendasCliente(form({ pagamento_na_retirada: 'on', entrega: 'nao' }), { transferirDisponivel: false, linkDisponivel: false });
  chk('só na retirada sem o módulo -> ok', r2.ok && r2.valor.pagamentos.join() === 'na_retirada');
  const r3 = validarVendasCliente(form({ pagamento_link: 'on', entrega: 'nao' }), { transferirDisponivel: false });
  chk('linkDisponivel omitido = disponível (compatível)', r3.ok);
}

console.log('\n== 72: nome de quem retira e endereço ==\n');
{
  const base = { pagamento_link: 'on', entrega: 'nao' };
  const r = validarVendasCliente(form({ ...base, pedir_nome: 'on', endereco: ' Av. Central, 10 ', mapa_url: 'https://maps.app.goo.gl/abc' }), { transferirDisponivel: false });
  chk('pedir_nome + endereço + mapa -> ok, endereço com trim', r.ok && r.valor.pedir_nome === true && r.valor.retirada.endereco === 'Av. Central, 10' && r.valor.retirada.mapa_url === 'https://maps.app.goo.gl/abc', JSON.stringify(r));
  const r2 = validarVendasCliente(form({ ...base, mapa_url: 'maps.app.goo.gl/abc', endereco: 'x' }), { transferirDisponivel: false });
  chk('mapa sem https -> erro em mapa_url', !r2.ok && 'mapa_url' in r2.erros);
  const r3 = validarVendasCliente(form({ ...base, mapa_url: 'https://maps.app.goo.gl/abc' }), { transferirDisponivel: false });
  chk('mapa sem endereço em texto -> erro em endereco', !r3.ok && 'endereco' in r3.erros);
  const r4 = validarVendasCliente(form({ ...base, endereco: 'x'.repeat(301) }), { transferirDisponivel: false });
  chk('endereço acima de 300 -> erro', !r4.ok && 'endereco' in r4.erros);
  const r5 = validarVendasCliente(form(base), { transferirDisponivel: false });
  chk('sem nada -> pedir_nome false e retirada {}', r5.ok && r5.valor.pedir_nome === false && JSON.stringify(r5.valor.retirada) === '{}');
  const l = lerConfigVendas({ pedir_nome: true, retirada: { endereco: 'Rua A', mapa_url: 'ftp://x' } });
  chk('lerConfigVendas: pedir_nome true; mapa inválido descartado; endereço fica', l.pedir_nome === true && l.retirada.endereco === 'Rua A' && l.retirada.mapa_url === undefined);
  chk('lerConfigVendas({}): pedir_nome false, retirada {}', lerConfigVendas({}).pedir_nome === false && JSON.stringify(lerConfigVendas({}).retirada) === '{}');
}

console.log('\n== validarVendasAgencia ==\n');
{
  chk('sessão vazia é válida (= sem aviso)', validarVendasAgencia(form({ sessao: '  ' })).ok === true && validarVendasAgencia(form({ sessao: '  ' })).valor.sessao === '');
  chk('sessão longa -> erro', validarVendasAgencia(form({ sessao: 'x'.repeat(81) })).ok === false);
  chk('sessão normal -> trim', validarVendasAgencia(form({ sessao: ' emporio ' })).valor?.sessao === 'emporio');
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
