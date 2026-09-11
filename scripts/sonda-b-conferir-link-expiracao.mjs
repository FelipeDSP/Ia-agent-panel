#!/usr/bin/env node
/**
 * SONDA B — medir o link que a sonda A criou, DEPOIS da virada do dia.
 *
 * ---------------------------------------------------------------------------
 * NÃO LÊ HTML. A página do Asaas é SPA e serve "pix", "boleto" e "qr code" no
 * esqueleto mesmo com o link inválido — foi o que enganou a sonda de 10/09, e
 * ela mesma avisou que HTML é indício e não prova. Aqui a verificação é pela
 * API, e o que isso custa está escrito em `classificarLinkDepoisDoPrazo`
 * (scripts/lib/asaas.mjs): "aceita" significa que a API continua descrevendo o
 * link como ativo depois do endDate; "recusa" significa que passou a descrevê-lo
 * como inativo — e link inativo recusa na página, medido em 10/09.
 *
 * ---------------------------------------------------------------------------
 * AS TRÊS COISAS QUE ELA SEPARA, E A PROVA DE QUE SEPARA
 *
 *   expirou_recusa      passou do endDate e a API diz inativo/removido
 *   expirou_aceita      passou do endDate e a API ainda diz ativo
 *   falha_de_chamada    a chamada falhou por OUTRO motivo (valor, campo, 401,
 *                       404) — não diz nada sobre expiração
 *
 * A prova sem rede está em `npm run teste:asaas-classificacao` §3b. A prova
 * COM rede está no §0 abaixo, antes de qualquer medição: ela força um erro de
 * VALOR contra o Asaas de verdade e exige que ele NÃO saia como expiração. Uma
 * sonda que não separa os dois não deveria chegar a opinar sobre nenhum.
 *
 * ---------------------------------------------------------------------------
 * ELA RECUSA RODAR CEDO DEMAIS. O relógio que vale é o do Asaas (header `Date`,
 * convertido para Brasília), não o da máquina. Rodar antes da virada mediria um
 * link válido e chamaria de "aceita depois de expirar" — o falso resultado mais
 * fácil de produzir nesta medição.
 *
 * Uso:
 *   npm run sonda:b-conferir            (mede e REMOVE o link no fim)
 *   npm run sonda:b-conferir -- --manter (mede e deixa o link no sandbox)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classificarLinkDepoisDoPrazo,
  classificarRespostaApi,
  redigir,
} from './lib/asaas.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARQ = path.join(RAIZ, '.sonda-asaas', 'link-expiracao.json');
const BASE = 'https://api-sandbox.asaas.com';
const KEY = process.env.ASAAS_SANDBOX_KEY;
const MANTER = process.argv.includes('--manter');

if (!KEY) {
  console.error('FALTA ASAAS_SANDBOX_KEY em .env.local (o script do package.json passa --env-file).');
  process.exit(2);
}
if (!/^\$?aact_(hmlg|sandbox)/i.test(KEY)) {
  console.error('ABORTADO: a chave não tem prefixo de sandbox.');
  process.exit(2);
}
if (!fs.existsSync(ARQ)) {
  console.error(`Não há link gravado (${path.relative(RAIZ, ARQ)}). Rode a sonda A primeiro: npm run sonda:a-criar`);
  process.exit(2);
}

const reg = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
if (reg.medido_em) {
  console.error(`Este link já foi medido em ${reg.medido_em}: ${reg.veredito?.classe}. Para medir de novo, rode a A.`);
  process.exit(1);
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
  return { status: r.status, json, txt, dataServidor: r.headers.get('date') };
};

const diaBrasilia = (rfc) => {
  const t = Date.parse(rfc ?? '');
  return Number.isNaN(t) ? null : new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10);
};

let problemas = 0;

console.log('== Sonda B — o link depois do endDate, pela API ==');
console.log(`   link: ${reg.id}   endDate: ${reg.endDate}   criado: ${reg.criado_em_local}`);
console.log(`   hora local agora: ${new Date().toString()}`);

// =========================================================================
// 0. AUTOTESTE DA DISCRIMINAÇÃO, contra o Asaas de verdade
// =========================================================================
console.log('\n######## 0. Autoteste: erro de VALOR não é expiração ########');
{
  const abaixo = await req('POST', '/v3/paymentLinks', {
    name: 'Sonda B — autoteste (deve ser RECUSADO)',
    billingType: 'PIX', chargeType: 'DETACHED',
    value: 1.0,                              // abaixo do piso, de propósito
    endDate: diaBrasilia(reg.relogio_asaas_utc) ?? reg.endDate,
    dueDateLimitDays: 1, notificationEnabled: false,
  });
  // A MESMA função que vai classificar o link de verdade, alimentada com a
  // resposta do erro de valor. Se ela disser qualquer `expirou_*`, pare.
  const cl = classificarLinkDepoisDoPrazo({
    leitura: abaixo, endDate: reg.endDate, dataServidor: abaixo.dataServidor,
  });
  console.log(`    HTTP ${abaixo.status}  ->  ${cl.classe}  (${cl.motivo})`);
  for (const e of classificarRespostaApi(abaixo).erros) console.log(`      · ${redigir(e)}`);
  if (cl.classe === 'falha_de_chamada') {
    console.log('  ✓ erro de valor saiu como `falha_de_chamada`, não como expiração');
  } else if (abaixo.status >= 200 && abaixo.status < 300) {
    problemas++;
    console.log('  ✗ o Asaas ACEITOU R$ 1,00 — o piso mudou. Achado; reveja a §7 do doc.');
    if (abaixo.json?.id) await req('DELETE', `/v3/paymentLinks/${abaixo.json.id}`);
  } else {
    problemas++;
    console.log(`  ✗ saiu como \`${cl.classe}\` — a sonda não está discriminando. PARE AQUI.`);
    process.exit(1);
  }
  // E um id que não existe: 404 tem de ser falha de chamada, não "removeu".
  const fantasma = await req('GET', '/v3/paymentLinks/naoexiste0000000');
  const clF = classificarLinkDepoisDoPrazo({
    leitura: fantasma, endDate: reg.endDate, dataServidor: fantasma.dataServidor,
  });
  console.log(`    GET id inexistente -> HTTP ${fantasma.status} -> ${clF.classe}`);
  if (clF.classe !== 'falha_de_chamada') {
    problemas++;
    console.log('  ✗ 404 não saiu como falha_de_chamada. PARE AQUI.');
    process.exit(1);
  }
  console.log('  ✓ 404 saiu como `falha_de_chamada`, não como "expirou e removeu"');
}

// =========================================================================
// 1. O RELÓGIO DO ASAAS — virou o dia?
// =========================================================================
console.log('\n######## 1. Que dia é no Asaas? ########');
const leitura = await req('GET', `/v3/paymentLinks/${reg.id}`);
const dia = diaBrasilia(leitura.dataServidor);
console.log(`    header Date (UTC): ${leitura.dataServidor}`);
console.log(`    dia em Brasília:   ${dia}   (endDate do link: ${reg.endDate})`);

// =========================================================================
// 2. A MEDIÇÃO
// =========================================================================
console.log('\n######## 2. O link, pela API ########');
console.log(`    GET /v3/paymentLinks/${reg.id} -> HTTP ${leitura.status}`);
const veredito = classificarLinkDepoisDoPrazo({
  leitura, endDate: reg.endDate, dataServidor: leitura.dataServidor,
});
console.log(`    ->  ${veredito.classe}  (${veredito.motivo})`);
console.log(`    campos: ${JSON.stringify(veredito.campos)}`);

// O que MUDOU no objeto desde a criação. A expiração pode se manifestar num
// campo que eu não conheço; comparar tudo é o que impede assumir que só
// `active` importa.
if (leitura.json && reg.objeto_relido) {
  const chaves = new Set([...Object.keys(reg.objeto_relido), ...Object.keys(leitura.json)]);
  const mudou = [...chaves].filter((k) =>
    JSON.stringify(reg.objeto_relido[k]) !== JSON.stringify(leitura.json[k]));
  console.log(`    campos que mudaram desde a criação: ${mudou.length ? mudou.join(', ') : 'NENHUM'}`);
  for (const k of mudou) {
    console.log(`      ${k}: ${JSON.stringify(reg.objeto_relido[k])} -> ${JSON.stringify(leitura.json[k])}`);
  }
}

if (veredito.classe === 'ainda_no_prazo') {
  console.log(`
✗ CEDO DEMAIS. No relógio do Asaas ainda é ${dia}, e o link vale até ${reg.endDate}.
  Nada foi medido, e nada foi removido. Rode de novo depois da virada em Brasília.
`);
  process.exit(1);
}

// =========================================================================
// 3. VEREDITO, gravado
// =========================================================================
reg.medido_em = new Date().toISOString();
reg.medido_relogio_asaas_utc = leitura.dataServidor;
reg.objeto_depois = leitura.json;
reg.veredito = veredito;
fs.writeFileSync(ARQ, JSON.stringify(reg, null, 2));

console.log('\n######## 3. Veredito ########\n');
const explica = {
  expirou_recusa: 'EXPIRADO -> o Asaas passou a descrever o link como INATIVO/REMOVIDO. Link inativo recusa na página (medido em 10/09).',
  expirou_aceita: 'EXPIRADO -> o Asaas AINDA descreve o link como ATIVO. Pela API, nada o desligou.',
  falha_de_chamada: 'NÃO MEDIDO: a leitura falhou por outro motivo. Ver acima.',
  indeterminado: 'NÃO MEDIDO: a API não deu base para dizer. Ver `campos`.',
};
console.log(`   ${veredito.classe}`);
console.log(`   ${explica[veredito.classe] ?? ''}`);

// Limpeza: o objeto foi criado pela sonda A e não deve ficar — salvo pedido
// explícito para manter (por exemplo, para abrir no navegador e confirmar).
if (!MANTER) {
  const del = await req('DELETE', `/v3/paymentLinks/${reg.id}`);
  console.log(`\n--- remover o link -> HTTP ${del.status}`);
} else {
  console.log(`\n--- --manter: o link ${reg.id} fica no sandbox. URL: ${reg.url}`);
}

console.log(`
============================================================
ESCREVA em docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md §6.9:
  - o veredito acima, com o rótulo EXATO;
  - que dia era no Asaas quando mediu, e os campos que mudaram;
  - o que muda no desenho (RECUSA -> descompasso inofensivo;
    ACEITA -> pagamento fora do prazo vira caminho central).
============================================================`);

process.exit(problemas ? 1 : 0);
