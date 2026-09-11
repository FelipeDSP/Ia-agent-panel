#!/usr/bin/env node
/**
 * SONDA C — subconta no SANDBOX, e a chave que ela produz.
 *
 * ---------------------------------------------------------------------------
 * POR QUE SUBCONTA, E POR QUE SÓ EM SANDBOX
 *
 * O modelo de produto é BaaS: cada cliente da agência com subconta própria no
 * Asaas, recebendo na conta dele. Em PRODUÇÃO a primeira subconta via API
 * inicia o período de avaliação regulatória de 60 dias (10 subcontas, R$ 2.000
 * cada) — decisão que não é técnica. Em SANDBOX não há esse custo: até 20
 * subcontas por dia, e-mails para a conta raiz, cliente nenhum envolvido.
 *
 * Esta sonda RECUSA qualquer chave que não seja de sandbox. Não é aviso: é
 * `process.exit` antes da primeira chamada.
 *
 * ---------------------------------------------------------------------------
 * O QUE ELA MEDE, NA ORDEM DO ENUNCIADO
 *
 *   1. a criação PASSA com a conta raiz atual? Só CNPJ cria subconta e só CNPJ
 *      pode ser criado (Resoluções Conjuntas 16/17 do BC). Antes de tentar, ela
 *      lê `GET /v3/myAccount` e diz se a raiz é PF ou PJ — se for PF, a falha
 *      é de CADASTRO, não de código, e ela para;
 *   2. o `walletId` e a CHAVE DE API DA SUBCONTA. É a chave da SUBCONTA que
 *      vai para `tenant_credenciais.asaas_api_key_sandbox` — nunca a da raiz.
 *      A doc diz que `apiKey` só vem NA CRIAÇÃO e não pode ser recuperada:
 *      gravada no ato, em arquivo gitignored;
 *   3. a subconta JÁ CONSEGUE COBRAR, ou nasce pendente de documentação? Medido
 *      criando um link de pagamento COM A CHAVE DA SUBCONTA. É a pergunta que
 *      decide se o teste do agente é viável nos próximos dias;
 *   4. o que mais a resposta traz: campos que eu não conheço são LISTADOS, não
 *      ignorados.
 *
 * ---------------------------------------------------------------------------
 * "SUBCONTA CRIADA" PORQUE VOLTOU 200 NÃO PROVA QUE ELA FUNCIONA. A prova é
 * por EFEITO: o link criado com a chave da subconta existe quando consultado
 * com a chave da subconta — e a conta RAIZ NÃO o enxerga como dela (404 com a
 * chave raiz). Os dois lados; um só não basta.
 *
 * E "a subconta não pode cobrar" é separado de "a chamada falhou por outro
 * motivo": o §3 força um erro de VALOR com a chave da subconta e exige que ele
 * NÃO saia como pendência de cadastro (`classificarCobrancaDaSubconta`, provada
 * sem rede em `teste:asaas-classificacao` §3c).
 *
 * ---------------------------------------------------------------------------
 * SEGURANÇA. A chave da subconta movimenta dinheiro tanto quanto a da raiz:
 * não sai impressa (`redigir` em tudo que vai para o console), vai só para
 * `.sonda-asaas/subconta.json` (gitignored), e a varredura de
 * `teste:asaas-classificacao` §5 passa a cobri-la também.
 *
 * Uso:
 *   npm run sonda:c-subconta
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classificarCobrancaDaSubconta, classificarRespostaApi, redigir,
} from './lib/asaas.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASTA = path.join(RAIZ, '.sonda-asaas');
const ARQ = path.join(PASTA, 'subconta.json');
const BASE = 'https://api-sandbox.asaas.com';
const KEY = process.env.ASAAS_SANDBOX_KEY;

if (!KEY) { console.error('FALTA ASAAS_SANDBOX_KEY em .env.local.'); process.exit(2); }
if (!/^\$?aact_(hmlg|sandbox)/i.test(KEY)) {
  console.error(`
ABORTADO: a chave não tem prefixo de sandbox (\`$aact_hmlg_...\`).
Esta sonda CRIA SUBCONTA. Em produção isso inicia o prazo regulatório de 60 dias
— decisão que não é técnica e não é desta sonda.`);
  process.exit(2);
}

const req = async (metodo, caminho, corpo, chave = KEY) => {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: { access_token: chave, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* corpo não-JSON também é dado */ }
  return { status: r.status, json, txt, dataServidor: r.headers.get('date') };
};
const mostra = (rot, r) => {
  const cl = classificarRespostaApi(r);
  console.log(`\n--- ${rot}\n    HTTP ${r.status}  ->  ${cl.classe}  (${cl.motivo})`);
  for (const e of cl.erros) console.log(`      · ${redigir(e)}`);
  return cl;
};
const dia = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);

/** CNPJ sintético com dígitos verificadores VÁLIDOS — o Asaas valida a forma. */
function cnpjValido(semente) {
  const base = String(semente).replace(/\D/g, '').padStart(8, '0').slice(0, 8) + '0001';
  const dv = (nums, pesos) => {
    const s = nums.split('').reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return base + d1 + d2;
}

// Campos que a doc lista para a resposta de criação. O que vier ALÉM disto é
// listado como "não pedido" — o item 4 do enunciado.
const CAMPOS_ESPERADOS = new Set([
  'object', 'id', 'name', 'email', 'loginEmail', 'phone', 'mobilePhone', 'address',
  'addressNumber', 'complement', 'province', 'postalCode', 'cpfCnpj', 'birthDate',
  'personType', 'companyType', 'city', 'cityName', 'state', 'country', 'site',
  'apiKey', 'walletId', 'accountNumber', 'incomeValue', 'webhooks', 'tradingName',
]);

let problemas = 0;
const registro = {
  iniciado_em: new Date().toISOString(),
  raiz: null, criacao: null, subconta: null, cobranca: null, efeito: null, autoteste: null,
  campos_nao_pedidos: [],
};
fs.mkdirSync(PASTA, { recursive: true });
const gravar = () => fs.writeFileSync(ARQ, JSON.stringify(registro, null, 2));

console.log('== Sonda C — subconta no SANDBOX ==');
console.log(`   hora local: ${new Date().toString()}`);

try {
  // =======================================================================
  // 1. QUEM É A CONTA RAIZ — PF ou PJ? Decide antes de tentar.
  // =======================================================================
  console.log('\n######## 1. A conta raiz ########');
  const me = await req('GET', '/v3/myAccount');
  mostra('GET /v3/myAccount', me);
  const doc = String(me.json?.cpfCnpj ?? '').replace(/\D/g, '');
  const tipoRaiz = me.json?.personType ?? (doc.length === 14 ? 'JURIDICA' : doc.length === 11 ? 'FISICA' : null);
  registro.raiz = {
    http: me.status, personType: me.json?.personType ?? null, companyType: me.json?.companyType ?? null,
    documento_digitos: doc.length, tipo_inferido: tipoRaiz,
    // nome/documento NÃO são gravados: são dados pessoais do titular do sandbox.
  };
  console.log(`    personType=${registro.raiz.personType}  companyType=${registro.raiz.companyType}  documento com ${doc.length} dígitos  -> ${tipoRaiz}`);
  if (tipoRaiz === 'FISICA') {
    console.log('  ! a raiz é PESSOA FÍSICA. A doc diz que só PJ cria subconta. Vou tentar mesmo');
    console.log('    assim — a recusa, se vier, é o DADO, e o motivo dela vai para o registro.');
  }
  gravar();

  // =======================================================================
  // 2. CRIAR A SUBCONTA (CNPJ sintético válido, endereço real de CEP válido)
  // =======================================================================
  console.log('\n######## 2. Criar a subconta ########');
  const semente = Date.now() % 100000000;
  const corpo = {
    name: `Sonda C — subconta de teste ${semente}`,
    email: `sonda-c-${semente}@example.com`,
    cpfCnpj: cnpjValido(semente),
    companyType: 'MEI',
    mobilePhone: '11999990000',
    incomeValue: 5000,
    address: 'Avenida Paulista',
    addressNumber: '1000',
    province: 'Bela Vista',
    postalCode: '01310100',
  };
  console.log(`    cpfCnpj sintético: ${corpo.cpfCnpj}  companyType=${corpo.companyType}  CEP=${corpo.postalCode}`);
  const cri = await req('POST', '/v3/accounts', corpo);
  const clCri = mostra('POST /v3/accounts', cri);
  registro.criacao = { http: cri.status, classe: clCri.classe, erros: clCri.erros, enviado: { ...corpo } };

  if (clCri.classe !== 'ok' || !cri.json?.id) {
    problemas++;
    const cadastro = clCri.classe === 'permissao'
      && clCri.erros.some((e) => /jur[ií]dic|cnpj|pessoa f[ií]sica/i.test(e));
    registro.criacao.veredito = cadastro
      ? 'BLOQUEIO DE CADASTRO: a conta raiz é PESSOA FÍSICA e o Asaas só deixa PJ criar subconta. Não é código.'
      : 'a criação falhou por outro motivo — ver `erros`';
    registro.criacao.medicoes_2_3_4 = 'NÃO MEDIDAS: sem subconta não há walletId, apiKey nem cobrança para medir.';
    gravar();
    console.log(`\n✗ NÃO CRIOU. ${registro.criacao.veredito}`);
    if (cadastro) {
      console.log('  As medições 2, 3 e 4 (walletId, apiKey, cobrança pela subconta) NÃO foram feitas —');
      console.log('  não há como. O que destrava é o CADASTRO da conta raiz virar PJ (o painel tem o');
      console.log('  seletor em Minha conta > Informações > Dados comerciais), e isso é decisão sua.');
    }
    console.log(`  registrado em ${path.relative(RAIZ, ARQ)}`);
    process.exit(1);
  }

  // A apiKey SÓ VEM AGORA. Gravada antes de qualquer outra coisa.
  const sub = cri.json;
  registro.subconta = {
    id: sub.id, walletId: sub.walletId ?? null,
    apiKey: sub.apiKey ?? null,                    // gitignored; nunca impressa
    apiKey_veio_na_criacao: typeof sub.apiKey === 'string' && sub.apiKey.length > 0,
    apiKey_prefixo: typeof sub.apiKey === 'string' ? sub.apiKey.slice(0, 11) + '…' : null,
    personType: sub.personType ?? null, companyType: sub.companyType ?? null,
    accountNumber: sub.accountNumber ?? null,
    objeto_sem_chave: Object.fromEntries(Object.entries(sub).filter(([k]) => k !== 'apiKey')),
  };
  registro.campos_nao_pedidos = Object.keys(sub).filter((k) => !CAMPOS_ESPERADOS.has(k));
  gravar();
  console.log(`  ✓ criada: id=${sub.id}  walletId=${sub.walletId ?? '(ausente)'}`);
  console.log(`    apiKey veio na criação: ${registro.subconta.apiKey_veio_na_criacao}  (prefixo ${registro.subconta.apiKey_prefixo})`);
  console.log(`    campos NÃO pedidos na resposta: ${registro.campos_nao_pedidos.length ? registro.campos_nao_pedidos.join(', ') : 'nenhum'}`);
  if (!registro.subconta.apiKey_veio_na_criacao) {
    problemas++;
    console.log('  ✗ SEM apiKey na resposta — sem ela não há como a subconta cobrar por API. Pare aqui.');
    process.exit(1);
  }
  const SUBKEY = sub.apiKey;

  // =======================================================================
  // 3. AUTOTESTE, com a chave da SUBCONTA: erro de valor NÃO é pendência
  // =======================================================================
  console.log('\n######## 3. Autoteste: erro de VALOR com a chave da subconta ########');
  const abaixo = await req('POST', '/v3/paymentLinks', {
    name: 'Sonda C — autoteste (deve ser RECUSADO por valor)', billingType: 'PIX', chargeType: 'DETACHED',
    value: 1.0, endDate: dia(1), dueDateLimitDays: 1, notificationEnabled: false,
  }, SUBKEY);
  const clAb = classificarCobrancaDaSubconta(abaixo);
  console.log(`    HTTP ${abaixo.status}  ->  ${clAb.classe}  (${clAb.motivo})`);
  for (const e of clAb.erros) console.log(`      · ${redigir(e)}`);
  registro.autoteste = { http: abaixo.status, classe: clAb.classe, erros: clAb.erros };
  if (clAb.classe === 'falha_de_chamada') {
    console.log('  ✓ erro de valor saiu como `falha_de_chamada`, não como pendência de cadastro');
  } else if (clAb.classe === 'pendencia_cadastro') {
    // Não é falha da discriminação: é a subconta de fato não podendo cobrar, e
    // o Asaas dizendo isso ANTES de olhar o valor. Vai para o §4 como está.
    console.log('  ! o Asaas recusou por CADASTRO antes de olhar o valor — a subconta não opera. Ver §4.');
  } else if (clAb.classe === 'ok') {
    problemas++;
    console.log('  ✗ ACEITOU R$ 1,00 com a chave da subconta — o piso não vale aqui?! Achado.');
    if (abaixo.json?.id) await req('DELETE', `/v3/paymentLinks/${abaixo.json.id}`, null, SUBKEY);
  } else {
    problemas++;
    console.log(`  ✗ saiu como \`${clAb.classe}\` — a sonda não está discriminando. Ver os erros acima.`);
  }
  gravar();

  // =======================================================================
  // 4. A SUBCONTA COBRA? Link válido, com a chave DELA.
  // =======================================================================
  console.log('\n######## 4. A subconta já cobra? ########');
  const link = await req('POST', '/v3/paymentLinks', {
    name: 'Sonda C — link da subconta (descartavel)', billingType: 'PIX', chargeType: 'DETACHED',
    value: 5.0, endDate: dia(1), dueDateLimitDays: 1, notificationEnabled: false,
  }, SUBKEY);
  const clLink = classificarCobrancaDaSubconta(link);
  console.log(`    POST /v3/paymentLinks (chave da subconta)  ->  HTTP ${link.status}  ->  ${clLink.classe}  (${clLink.motivo})`);
  for (const e of clLink.erros) console.log(`      · ${redigir(e)}`);
  registro.cobranca = { http: link.status, classe: clLink.classe, erros: clLink.erros, link_id: link.json?.id ?? null, url: link.json?.url ?? null };
  gravar();

  if (clLink.classe !== 'ok') {
    console.log(`\n✗ A SUBCONTA NÃO COBRA: ${clLink.classe}.`);
    if (clLink.classe === 'pendencia_cadastro') {
      console.log('  Nasce pendente. O teste do agente com subconta está BLOQUEADO até o cadastro');
      console.log('  ser aprovado — ver o que o Asaas pediu acima e a §6.10 do doc.');
    }
    process.exit(1);
  }
  console.log(`  ✓ a subconta criou o link ${link.json.id}`);

  // =======================================================================
  // 5. EFEITO, dos DOIS lados: a subconta vê; a raiz NÃO vê como dela
  // =======================================================================
  console.log('\n######## 5. O link existe para a subconta e NÃO para a raiz ########');
  const vSub = await req('GET', `/v3/paymentLinks/${link.json.id}`, null, SUBKEY);
  const vRaiz = await req('GET', `/v3/paymentLinks/${link.json.id}`, null, KEY);
  console.log(`    GET com a chave da SUBCONTA -> HTTP ${vSub.status}  active=${JSON.stringify(vSub.json?.active)}`);
  console.log(`    GET com a chave da RAIZ     -> HTTP ${vRaiz.status}  ${vRaiz.status === 404 ? '(não é dela)' : '(!!! a raiz enxerga)'}`);
  registro.efeito = { subconta_ve: vSub.status, raiz_ve: vRaiz.status };
  const efeitoOk = vSub.status === 200 && vSub.json?.id === link.json.id && vRaiz.status === 404;
  if (efeitoOk) console.log('  ✓ o link pertence à subconta: ela vê, a raiz não');
  else { problemas++; console.log('  ✗ o efeito não fechou dos dois lados — ver acima'); }

  // E o inverso, para a prova não ser vácua: um link da RAIZ a subconta NÃO vê.
  const daRaiz = await req('POST', '/v3/paymentLinks', {
    name: 'Sonda C — link da raiz (descartavel)', billingType: 'PIX', chargeType: 'DETACHED',
    value: 5.0, endDate: dia(1), dueDateLimitDays: 1, notificationEnabled: false,
  }, KEY);
  if (daRaiz.json?.id) {
    const vCruz = await req('GET', `/v3/paymentLinks/${daRaiz.json.id}`, null, SUBKEY);
    console.log(`    ESPELHO: link da raiz lido com a chave da subconta -> HTTP ${vCruz.status} ${vCruz.status === 404 ? '(isolado)' : '(!!! vazou)'}`);
    registro.efeito.espelho_subconta_ve_link_da_raiz = vCruz.status;
    if (vCruz.status !== 404) { problemas++; }
    await req('DELETE', `/v3/paymentLinks/${daRaiz.json.id}`, null, KEY);
  }
  gravar();

  // limpeza do link da subconta
  const del = await req('DELETE', `/v3/paymentLinks/${link.json.id}`, null, SUBKEY);
  console.log(`\n--- remover o link da subconta -> HTTP ${del.status}`);
} catch (e) {
  problemas++;
  console.log(`\n  EXCEÇÃO: ${redigir(e.message)}`);
  gravar();
}

registro.terminado_em = new Date().toISOString();
gravar();
console.log(`
============================================================
registro em ${path.relative(RAIZ, ARQ)} (gitignored; contém a apiKey da subconta)
A subconta NÃO é removida — o sandbox permite 20/dia e ela é o objeto que o
desenho da ferramenta vai usar. id: ${registro.subconta?.id ?? '(não criada)'}

ESCREVA na §6.10 de docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md: o que foi medido,
o que não foi, e o que muda no desenho conforme cada resposta.
============================================================`);
process.exit(problemas ? 1 : 0);
