/**
 * `validarConfigTenantSuper` — o formulário da agência com os campos da 66.
 *
 * Propriedades: as checkboxes de forma de pagamento viram lista (só valores da
 * lista fixa; vazio é erro); o silêncio da memória é inteiro 1..1440; nada do
 * form entra cru (um valor inventado em `pagamento_formas` é descartado).
 *
 *   node --import ./tests/lib/ts.mjs tests/config-tenant-super.mjs
 */
import { validarConfigTenantSuper, FORMAS_PAGAMENTO } from '../src/lib/tenants/schema.ts';

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
const form = (campos, formas = ['PIX']) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ nome: 'Cliente', modelo: 'gpt-4.1-mini', temperatura: '0.2', debounce_segundos: '3', memoria_silencio_minutos: '40', ...campos })) fd.set(k, v);
  for (const f of formas) fd.append('pagamento_formas', f);
  return fd;
};

console.log('\n== validarConfigTenantSuper ==\n');
{
  const r = validarConfigTenantSuper(form({ memoria_silencio_minutos: '120' }, ['PIX', 'CREDIT_CARD']));
  chk('120 min e duas formas -> ok, na ordem enviada', r.ok && r.valor.memoria_silencio_minutos === 120 && r.valor.pagamento_formas.join(',') === 'PIX,CREDIT_CARD', JSON.stringify(r));
  const r2 = validarConfigTenantSuper(form({}, ['PIX', 'DINHEIRO', 'CREDIT_CARD']));
  chk('forma fora da lista fixa é DESCARTADA (não vira erro nem entra)', r2.ok && r2.valor.pagamento_formas.join(',') === 'PIX,CREDIT_CARD');
  const r3 = validarConfigTenantSuper(form({}, []));
  chk('nenhuma forma -> erro em pagamento_formas', !r3.ok && /pagamento_formas/.test(Object.keys(r3.erros).join()));
  const r4 = validarConfigTenantSuper(form({}, ['DINHEIRO']));
  chk('só forma inválida -> erro (lista vazia depois do filtro)', !r4.ok && 'pagamento_formas' in r4.erros);
  for (const v of ['0', '1441', '2.5', 'abc', '']) {
    const r5 = validarConfigTenantSuper(form({ memoria_silencio_minutos: v }));
    chk(`silêncio "${v}" -> erro`, !r5.ok && 'memoria_silencio_minutos' in r5.erros);
  }
  const r6 = validarConfigTenantSuper(form({ memoria_silencio_minutos: '1440' }));
  chk('1440 (24 h) é o teto e passa', r6.ok && r6.valor.memoria_silencio_minutos === 1440);
  chk('FORMAS_PAGAMENTO é a lista de três (contraprova de que o filtro não é vácuo)', FORMAS_PAGAMENTO.length === 3);
}
console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
