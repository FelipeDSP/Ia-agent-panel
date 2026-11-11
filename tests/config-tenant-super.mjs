/**
 * `validarConfigTenantSuper` — o formulário da agência com os campos da 66 e a
 * pausa da 47.
 *
 * Propriedades: as checkboxes de forma de pagamento viram lista (só valores da
 * lista fixa; vazio é erro); o silêncio da memória é inteiro 1..1440; nada do
 * form entra cru (um valor inventado em `pagamento_formas` é descartado).
 *
 * `pausa_expira_minutos` (11/11) tem bloco próprio no fim, e ele mede DUAS
 * coisas, porque validar sozinho não faz nada chegar ao banco: o valor passa
 * pelo validador E a Server Action o escreve. Campo de tela que valida bonito e
 * não é gravado é a forma mais convincente de não funcionar — a coluna existe
 * desde a 47 e passou quase três meses sem campo nenhum, o que já custou "é só
 * ajuste de configuração" dito para quem não tinha onde ajustar.
 *
 *   node --import ./tests/lib/ts.mjs tests/config-tenant-super.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validarConfigTenantSuper, FORMAS_PAGAMENTO } from '../src/lib/tenants/schema.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');

let ok = 0;
const falhas = [];
const chk = (nome, cond, det = '') => {
  if (cond) { ok++; console.log(`  OK    ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}${det ? ` — ${det}` : ''}`); }
};
const form = (campos, formas = ['PIX']) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ nome: 'Cliente', modelo: 'gpt-4.1-mini', temperatura: '0.2', debounce_segundos: '3', memoria_silencio_minutos: '40', pausa_expira_minutos: '30', ...campos })) fd.set(k, v);
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

console.log('\n== pausa_expira_minutos: valida E chega ao banco ==\n');
{
  const r = validarConfigTenantSuper(form({ pausa_expira_minutos: '1' }));
  chk('1 min passa (é o que destrava a abertura externa de prospecção)',
    r.ok && r.valor.pausa_expira_minutos === 1, JSON.stringify(r));
  const r2 = validarConfigTenantSuper(form({ pausa_expira_minutos: '1440' }));
  chk('1440 é o teto da tela e passa', r2.ok && r2.valor.pausa_expira_minutos === 1440);
  for (const v of ['0', '-5', '1441', '2.5', 'abc', '']) {
    const r3 = validarConfigTenantSuper(form({ pausa_expira_minutos: v }));
    chk(`pausa "${v}" -> erro`, !r3.ok && 'pausa_expira_minutos' in r3.erros);
  }
  /*
   * CONTRAPROVA do laço acima: se o campo fosse OPCIONAL, "" devolveria ok e as
   * asserções de erro passariam por não existir campo nenhum. Esta exige que o
   * valor BOM atravesse.
   */
  const r4 = validarConfigTenantSuper(form({ pausa_expira_minutos: '30' }));
  chk('CONTRAPROVA: 30 (o padrão) passa, logo o erro acima é do VALOR',
    r4.ok && r4.valor.pausa_expira_minutos === 30);

  // As três pontas do caminho até o banco. Linha de comentário fora: um `//`
  // que explique a regra não é a regra.
  const semComentario = (t) => t.split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  const acoes = semComentario(ler('src/app/(app)/admin/acoes.ts'));
  const pagina = semComentario(ler('src/app/(app)/admin/tenants/[id]/page.tsx'));
  const cartao = semComentario(ler('src/app/(app)/admin/tenants/[id]/componentes.tsx'));
  chk('os fontes foram lidos (arquivo vazio aprovaria tudo)',
    acoes.length > 1000 && pagina.length > 1000 && cartao.length > 1000);
  chk('a Server Action GRAVA a coluna',
    /pausa_expira_minutos: validado\.valor\.pausa_expira_minutos/.test(acoes));
  /*
   * A COLUNA TEM DE ESTAR NO `select`, e não em qualquer lugar do arquivo.
   * Escrito primeiro como `/pausa_expira_minutos/.test(pagina)`, isto ficou
   * VERDE com a coluna removida do select — casava com a linha da prop logo
   * abaixo. Sem a coluna o PostgREST não a devolve, `?? 30` entra em cena e o
   * campo mostra 30 para todo cliente e grava 30 ao salvar: defeito calado,
   * asserção calada. A lista sai do próprio select que já tem a irmã da 66.
   */
  const selects = [...pagina.matchAll(/\.select\(\s*'([^']*)'/g)].map((m) => m[1]);
  const selectDoTenant = selects.find((c) => c.includes('memoria_silencio_minutos'));
  chk('achei o select que lê a config do tenant (sem ele nada abaixo conclui)',
    selectDoTenant !== undefined, `${selects.length} selects no arquivo`);
  chk('a página LÊ a coluna no SELECT',
    (selectDoTenant ?? '').includes('pausa_expira_minutos'), selectDoTenant ?? '(nenhum)');
  chk('...e a passa para o cartão', /pausaExpira=\{/.test(pagina));
  chk('o cartão tem o input com o NOME que o validador lê',
    /name="pausa_expira_minutos"/.test(cartao));
}

console.log(`\n${ok} passaram, ${falhas.length} falharam\n`);
if (falhas.length) process.exit(1);
