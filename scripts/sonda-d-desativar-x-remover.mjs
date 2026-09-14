#!/usr/bin/env node
/**
 * SONDA D — desativar x remover: o que acontece com a COBRANÇA já gerada.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE
 *
 * A sonda B respondeu `expirou_aceita` (14/09/2026): o Asaas não desliga o
 * link no `endDate`. Então o caminho de expiração do pedido PRECISA desligar o
 * link, e há duas formas — `PUT active=false` (desativar) e `DELETE` (remover).
 * As duas fecham a PÁGINA (medido em 10/09 para desativar; a doc diz que
 * remover "impede novos pagamentos por esse link"). O que nenhuma página da
 * documentação diz é o que acontece com a COBRANÇA que o cliente já gerou pela
 * página antes de o link fechar: ela é outro objeto (`payment`, com `id`,
 * `status`, `dueDate`, QR Code e `paymentLink` apontando para a origem).
 *
 * É exatamente o caso do cliente que abriu o link, gerou o Pix e foi pagar
 * quando a nossa janela já tinha vencido. Com `expirou_aceita`, isso acontece
 * todo dia — e a resposta decide se a expiração desativa ou remove, e se
 * "remover" apaga registro financeiro.
 *
 * ---------------------------------------------------------------------------
 * DUAS FASES, porque gerar a cobrança é ato na PÁGINA PÚBLICA, não na API
 *
 *   --criar   cria o link e grava em `.sonda-asaas/desativar-x-remover.json`.
 *             Depois disso alguém (ou um navegador automatizado) abre a URL,
 *             preenche o formulário e escolhe Pix — nasce a cobrança.
 *   --medir   RECUSA medir sem cobrança (uma medição sem objeto seria vácua),
 *             tira o retrato dela, DESATIVA o link, relê; tenta REMOVER o
 *             link, relê; se removeu, RESTAURA e relê.
 *   --limpar  remove a COBRANÇA (`DELETE /v3/payments/{id}`) e depois o link —
 *             e registra os dois códigos, porque a ordem é medição também: se
 *             o link só sai depois de a cobrança sair, isso é regra do Asaas.
 *
 * O QUE A PRIMEIRA EXECUÇÃO (14/09/2026) ENSINOU, e por que o passo 3 não
 * aborta mais: o Asaas RECUSA o DELETE de link com cobrança gerada —
 * HTTP 400, "Não é permitido remover links de pagamento com cobranças
 * geradas." A primeira versão tratou isso como "a mutação não entrou" e parou.
 * É veredito, não falha: para o caso que importa (cliente já gerou o Pix),
 * remover não é uma opção que exista. Fica registrado como `remocao_recusada`.
 *
 * ---------------------------------------------------------------------------
 * O QUE ELA NÃO MEDE, dito de frente: se o dinheiro se move. Não há como pagar
 * um Pix de sandbox por API. "Intacta" significa que a API do Asaas continua
 * descrevendo a cobrança como existente, não removida, no mesmo status e com
 * QR Code servido. É a mesma ressalva da sonda B, e vai junto com o veredito.
 *
 * NÃO RODA NA SUÍTE. Cria objeto no Asaas. Recusa chave que não seja de
 * sandbox, não cria subconta, não imprime a chave.
 *
 * Uso:
 *   npm run sonda:d-criar
 *   (gerar a cobrança pela URL impressa)
 *   npm run sonda:d-medir
 *   npm run sonda:d-limpar
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classificarCobrancaAposMutacaoDoLink,
  classificarLinkDepoisDoPrazo,
  classificarRemocaoDeLink,
  classificarRespostaApi,
  redigir,
} from './lib/asaas.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASTA = path.join(RAIZ, '.sonda-asaas');
const ARQ = path.join(PASTA, 'desativar-x-remover.json');
const BASE = 'https://api-sandbox.asaas.com';
const KEY = process.env.ASAAS_SANDBOX_KEY;
const FASE = ['criar', 'medir', 'limpar'].find((f) => process.argv.includes(`--${f}`)) ?? null;

if (!KEY) {
  console.error('FALTA ASAAS_SANDBOX_KEY em .env.local (o script do package.json passa --env-file).');
  process.exit(2);
}
if (!/^\$?aact_(hmlg|sandbox)/i.test(KEY)) {
  console.error('ABORTADO: a chave não tem prefixo de sandbox. Esta sonda cria e remove objetos.');
  process.exit(2);
}
if (!FASE) {
  console.error('Uso: --criar | --medir | --limpar');
  process.exit(2);
}

const req = async (metodo, caminho, corpo) => {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: { access_token: KEY, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* corpo não-JSON também é dado */ }
  return { status: r.status, json, dataServidor: r.headers.get('date') };
};
const hojeLocal = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();
const diaMais = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ===========================================================================
if (FASE === 'criar') {
// ===========================================================================
  if (fs.existsSync(ARQ)) {
    const ant = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    if (!ant.medido_em) {
      console.error(`JÁ EXISTE UM LINK GRAVADO E NÃO MEDIDO: ${ant.link_id}. Rode --medir, ou apague ${path.relative(RAIZ, ARQ)}.`);
      process.exit(1);
    }
  }
  console.log('== Sonda D — criar o link (fase 1 de 2) ==');
  // `endDate` de amanhã: o link tem de estar VIVO enquanto a cobrança é gerada
  // e medida; a expiração por data é assunto da sonda B, não desta.
  const criado = await req('POST', '/v3/paymentLinks', {
    name: 'Sonda D desativar x remover (descartavel)',
    description: 'Objeto de teste — scripts/sonda-d-desativar-x-remover.mjs. A fase --medir o remove.',
    billingType: 'PIX', chargeType: 'DETACHED',
    value: 5.0, endDate: diaMais(1), dueDateLimitDays: 1, notificationEnabled: false,
  });
  const cl = classificarRespostaApi(criado);
  console.log(`   POST /v3/paymentLinks -> HTTP ${criado.status} -> ${cl.classe}`);
  for (const e of cl.erros) console.log(`     · ${redigir(e)}`);
  if (cl.classe !== 'ok' || !criado.json?.id) { console.error('✗ NÃO CRIOU.'); process.exit(1); }

  fs.mkdirSync(PASTA, { recursive: true });
  fs.writeFileSync(ARQ, JSON.stringify({
    criado_em_iso: new Date().toISOString(),
    relogio_asaas_utc: criado.dataServidor,
    link_id: criado.json.id,
    url: criado.json.url,
    link_ao_criar: criado.json,
    medido_em: null,
  }, null, 2));
  console.log(`
✓ CRIADO  id: ${criado.json.id}
          URL: ${criado.json.url}

AGORA: abra a URL, preencha o formulário com dados SINTÉTICOS e escolha Pix,
até aparecer o QR Code — isso cria a cobrança. Depois:
  npm run sonda:d-medir
`);
  process.exit(0);
}

// ===========================================================================
// FASES 2 e 3 — medir, limpar
// ===========================================================================
if (!fs.existsSync(ARQ)) { console.error('Não há link gravado. Rode --criar primeiro.'); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
const L = reg.link_id;

const lerCobrancas = async (extra = '') => {
  const r = await req('GET', `/v3/payments?paymentLink=${L}&limit=50${extra}`);
  const lista = Array.isArray(r.json?.data) ? r.json.data : [];
  // O filtro do servidor é suposição; a coluna `paymentLink` da própria
  // cobrança é o que vale.
  return { http: r.status, total: r.json?.totalCount ?? null, itens: lista.filter((p) => p.paymentLink === L) };
};

// ===========================================================================
if (FASE === 'limpar') {
// ===========================================================================
  // A ORDEM É MEDIÇÃO: se o link só sai depois de a cobrança sair, isso é
  // regra do Asaas e fica registrado com os dois códigos.
  console.log('== Sonda D — limpar (fase 3 de 3) ==');
  const ids = reg.cobrancas_ids ?? (await lerCobrancas()).itens.map((p) => p.id);
  const limpeza = { cobrancas: {}, link_antes_de_remover_cobrancas: null, link: null };
  const tenta = await req('DELETE', `/v3/paymentLinks/${L}`);
  limpeza.link_antes_de_remover_cobrancas = { http: tenta.status, erros: classificarRespostaApi(tenta).erros };
  console.log(`    DELETE link COM cobrança viva -> HTTP ${tenta.status} ${limpeza.link_antes_de_remover_cobrancas.erros.join(' | ')}`);
  for (const id of ids) {
    const r = await req('DELETE', `/v3/payments/${id}`);
    const relida = await req('GET', `/v3/payments/${id}`);
    limpeza.cobrancas[id] = { delete_http: r.status, relida_http: relida.status, relida_deleted: relida.json?.deleted ?? null, relida_status: relida.json?.status ?? null };
    console.log(`    DELETE /v3/payments/${id} -> HTTP ${r.status}; relida: HTTP ${relida.status} deleted=${relida.json?.deleted} status=${relida.json?.status}`);
  }
  const del = await req('DELETE', `/v3/paymentLinks/${L}`);
  const relido = await req('GET', `/v3/paymentLinks/${L}`);
  limpeza.link = { delete_http: del.status, erros: classificarRespostaApi(del).erros, relido_http: relido.status, relido_deleted: relido.json?.deleted ?? null };
  console.log(`    DELETE link SEM cobrança viva -> HTTP ${del.status} ${limpeza.link.erros.join(' | ')}; relido: HTTP ${relido.status} deleted=${relido.json?.deleted}`);
  reg.limpeza = limpeza;
  reg.limpo_em = new Date().toISOString();
  fs.writeFileSync(ARQ, JSON.stringify(reg, null, 2));
  console.log(`\nregistrado em ${path.relative(RAIZ, ARQ)}`);
  process.exit(0);
}

// ===========================================================================
// FASE 2 — medir
// ===========================================================================
if (reg.medido_em) { console.error(`Já medido em ${reg.medido_em}. Para medir de novo, rode --criar.`); process.exit(1); }
let problemas = 0;

console.log('== Sonda D — desativar x remover, pela API (fase 2 de 3) ==');
console.log(`   link: ${L}   criado: ${reg.criado_em_iso}`);

// ---------------------------------------------------------------------------
console.log('\n######## 0. Autoteste: erro de VALOR não é veredito ########');
// ---------------------------------------------------------------------------
{
  const abaixo = await req('POST', '/v3/paymentLinks', {
    name: 'Sonda D — autoteste (deve ser RECUSADO)', billingType: 'PIX', chargeType: 'DETACHED',
    value: 1.0, endDate: hojeLocal, dueDateLimitDays: 1, notificationEnabled: false,
  });
  const cl = classificarLinkDepoisDoPrazo({ leitura: abaixo, endDate: hojeLocal, dataServidor: abaixo.dataServidor });
  console.log(`    HTTP ${abaixo.status} -> ${cl.classe}`);
  for (const e of classificarRespostaApi(abaixo).erros) console.log(`      · ${redigir(e)}`);
  if (abaixo.status >= 200 && abaixo.status < 300) {
    problemas++; console.log('  ✗ o Asaas ACEITOU R$ 1,00 — o piso mudou. Achado; reveja a §7 do doc.');
    if (abaixo.json?.id) await req('DELETE', `/v3/paymentLinks/${abaixo.json.id}`);
  } else if (cl.classe !== 'falha_de_chamada') {
    console.log(`  ✗ saiu como \`${cl.classe}\`. PARE AQUI.`); process.exit(1);
  } else console.log('  ✓ erro de valor saiu como `falha_de_chamada`');
  // E a classificação da cobrança com um 404 ANTES não pode opinar.
  const vacua = classificarCobrancaAposMutacaoDoLink({ antes: { status: 404, json: {} }, depois: { status: 200, json: { id: 'x', status: 'PENDING', deleted: false } } });
  if (vacua.classe !== 'indeterminado') { console.log(`  ✗ sem base de comparação saiu como ${vacua.classe}. PARE AQUI.`); process.exit(1); }
  console.log('  ✓ sem leitura ANTES válida, a classificação recusa opinar (`indeterminado`)');
}

// ---------------------------------------------------------------------------
console.log('\n######## 1. A cobrança gerada pelo link — existe? ########');
// ---------------------------------------------------------------------------
const lerUma = async (id) => ({
  cobranca: await req('GET', `/v3/payments/${id}`),
  pix: await req('GET', `/v3/payments/${id}/pixQrCode`),
});
const resumo = (r) => r.cobranca.status >= 200 && r.cobranca.status < 300
  ? `HTTP ${r.cobranca.status} status=${r.cobranca.json.status} deleted=${r.cobranca.json.deleted} dueDate=${r.cobranca.json.dueDate} | pixQrCode HTTP ${r.pix.status} payload=${typeof r.pix.json?.payload === 'string' && r.pix.json.payload.length > 0}`
  : `HTTP ${r.cobranca.status} ${JSON.stringify(r.cobranca.json).slice(0, 120)} | pixQrCode HTTP ${r.pix.status}`;

const lista0 = await lerCobrancas();
console.log(`    GET /v3/payments?paymentLink=${L} -> HTTP ${lista0.http}, ${lista0.itens.length} cobrança(s) com paymentLink=${L}`);
if (lista0.itens.length === 0) {
  console.log(`
✗ NADA A MEDIR: nenhuma cobrança nasceu deste link. Abra ${reg.url}, preencha o
  formulário com dados sintéticos e escolha Pix até o QR Code aparecer. Nada foi
  mutado e nada foi removido.
`);
  process.exit(1);
}
const IDS = lista0.itens.map((p) => p.id);

// O link tem de estar VIVO no retrato de partida — uma execução anterior pode
// tê-lo deixado desativado (foi o caso em 14/09, quando o passo 3 abortou).
let linkAntes = await req('GET', `/v3/paymentLinks/${L}`);
if (linkAntes.json?.active === false && linkAntes.json?.deleted === false) {
  await req('PUT', `/v3/paymentLinks/${L}`, { active: true });
  linkAntes = await req('GET', `/v3/paymentLinks/${L}`);
  console.log(`    (o link estava desativado; reativado: active=${linkAntes.json?.active})`);
}
const antes = {};
for (const id of IDS) { antes[id] = await lerUma(id); console.log(`    ${id}: ${resumo(antes[id])}`); }
console.log(`    link: active=${linkAntes.json?.active} deleted=${linkAntes.json?.deleted}`);
if (linkAntes.json?.active !== true) { console.log('  ✗ o link de partida não está ativo. PARE AQUI.'); process.exit(1); }

const medir = async (rotulo) => {
  const out = {};
  for (const id of IDS) {
    const d = await lerUma(id);
    const v = classificarCobrancaAposMutacaoDoLink({ antes: antes[id].cobranca, depois: d.cobranca, pixAntes: antes[id].pix, pixDepois: d.pix });
    console.log(`    ${id}: ${resumo(d)}`);
    console.log(`      -> ${v.classe}  (${v.motivo})`);
    out[id] = { leitura: d.cobranca.json, http: d.cobranca.status, pix_http: d.pix.status, veredito: v };
  }
  const lista = await lerCobrancas();
  console.log(`    lista por paymentLink: ${lista.itens.length} de ${IDS.length} (HTTP ${lista.http})`);
  return { rotulo, cobrancas: out, lista_por_link: lista.itens.length };
};

// ---------------------------------------------------------------------------
console.log('\n######## 2. DESATIVAR o link (PUT active=false) ########');
// ---------------------------------------------------------------------------
const put = await req('PUT', `/v3/paymentLinks/${L}`, { active: false });
const linkDesativado = await req('GET', `/v3/paymentLinks/${L}`);
console.log(`    PUT -> HTTP ${put.status}; relido: active=${linkDesativado.json?.active} deleted=${linkDesativado.json?.deleted}`);
if (linkDesativado.json?.active !== false) { console.log('  ✗ a mutação NÃO entrou (active continua true). PARE AQUI.'); process.exit(1); }
console.log('  ✓ a mutação entrou (active=false relido)');
const aposDesativar = await medir('desativado');

// ---------------------------------------------------------------------------
console.log('\n######## 3. REMOVER o link (DELETE) ########');
// ---------------------------------------------------------------------------
// Três saídas, e as três são resultado: removeu (mede a cobrança depois);
// RECUSOU por regra (a frase de 14/09 — para link com cobrança, remover não
// existe); ou falhou por outro motivo (isso sim é "não medido").
const del = await req('DELETE', `/v3/paymentLinks/${L}`);
const delCl = classificarRemocaoDeLink(del);
const linkRemovido = await req('GET', `/v3/paymentLinks/${L}`);
console.log(`    DELETE -> HTTP ${del.status} -> ${delCl.classe}  (${delCl.motivo})`);
for (const e of delCl.erros) console.log(`      · ${redigir(e)}`);
console.log(`    GET do link depois -> HTTP ${linkRemovido.status} active=${linkRemovido.json?.active} deleted=${linkRemovido.json?.deleted}`);
// A releitura é a prova de que a mutação entrou (ou não), independente do que
// o DELETE respondeu.
const removeu = linkRemovido.json?.deleted === true || linkRemovido.status === 404;
let remocao;
if (removeu) {
  console.log('  ✓ a remoção entrou (deleted:true relido)');
  remocao = { classe: 'removeu', medicao: await medir('removido') };
} else if (delCl.classe === 'remocao_recusada') {
  console.log('  ✓ RECUSA POR REGRA: o Asaas não remove link com cobrança gerada. É veredito, e o link continua deleted:false.');
  remocao = { classe: 'remocao_recusada', erros: delCl.erros, medicao: await medir('apos_delete_recusado') };
} else {
  problemas++;
  console.log(`  ✗ o DELETE saiu como \`${delCl.classe}\` e o link não foi removido — remoção NÃO MEDIDA.`);
  remocao = { classe: 'nao_medido', http: del.status, erros: delCl.erros };
}

// ---------------------------------------------------------------------------
console.log('\n######## 4. RESTAURAR o link (POST /restore) ########');
// ---------------------------------------------------------------------------
let restauracao = { classe: 'nao_se_aplica' };
if (removeu) {
  const rest = await req('POST', `/v3/paymentLinks/${L}/restore`);
  const linkRestaurado = await req('GET', `/v3/paymentLinks/${L}`);
  console.log(`    POST restore -> HTTP ${rest.status}; relido: HTTP ${linkRestaurado.status} active=${linkRestaurado.json?.active} deleted=${linkRestaurado.json?.deleted}`);
  restauracao = { classe: linkRestaurado.json?.deleted === false ? 'restaurou' : 'nao_restaurou', link: linkRestaurado.json, medicao: await medir('restaurado') };
} else {
  console.log('    não se aplica: o link não foi removido.');
}

// ---------------------------------------------------------------------------
console.log('\n######## 5. Veredito ########\n');
// ---------------------------------------------------------------------------
const classes = (m) => (m ? [...new Set(Object.values(m.cobrancas).map((c) => c.veredito.classe))].join(',') : '-');
const veredito = {
  desativado: classes(aposDesativar),
  remocao: remocao.classe,
  cobranca_apos_tentar_remover: classes(remocao.medicao),
  restauracao: restauracao.classe,
  cobranca_apos_restaurar: classes(restauracao.medicao),
};
console.log(`   cobrança após DESATIVAR o link:      ${veredito.desativado}`);
console.log(`   REMOVER o link com cobrança gerada:  ${veredito.remocao}`);
console.log(`   cobrança depois dessa tentativa:     ${veredito.cobranca_apos_tentar_remover}`);
console.log(`   restauração:                         ${veredito.restauracao}`);
console.log(`
   RESSALVA: mede o que a API DIZ da cobrança, não um pagamento real. "Intacta"
   = existe, não removida, mesmo status, QR Code servido. Ninguém pagou nada.`);

reg.medido_em = new Date().toISOString();
reg.medido_relogio_asaas_utc = linkAntes.dataServidor;
reg.cobrancas_ids = IDS;
reg.antes = Object.fromEntries(IDS.map((id) => [id, { cobranca: antes[id].cobranca.json, pix_http: antes[id].pix.status }]));
reg.apos_desativar = aposDesativar;
reg.remocao = remocao;
reg.restauracao = restauracao;
reg.link_apos = { desativado: linkDesativado.json, apos_delete: { http: linkRemovido.status, json: linkRemovido.json } };
reg.veredito = veredito;
fs.writeFileSync(ARQ, JSON.stringify(reg, null, 2));
console.log(`\nregistrado em ${path.relative(RAIZ, ARQ)} (NÃO versionado)`);
console.log(`
O link fica DESATIVADO e a cobrança fica no sandbox (para abrir a fatura no
navegador e ver o que o cliente vê). Quando terminar: npm run sonda:d-limpar
============================================================
ESCREVA em docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md §6.11:
  - os vereditos acima, com o rótulo EXATO, e o dia;
  - a ressalva (descrição pela API, não pagamento real);
  - qual das duas o caminho de expiração usa, e por quê.
============================================================`);
process.exit(problemas ? 1 : 0);
