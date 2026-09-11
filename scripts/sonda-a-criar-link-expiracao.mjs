#!/usr/bin/env node
/**
 * SONDA A — criar o link que vai expirar sozinho. Rodar HOJE, CEDO.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE UMA SONDA A E UMA SONDA B
 *
 * A medição de link genuinamente EXPIRADO ficou sem resposta em 10/09: `endDate`
 * é DATA, não data-hora, e o Asaas recusa data no passado tanto na criação
 * quanto no `PUT`. O único caminho é criar com `endDate` de HOJE e conferir
 * depois da virada do dia. Isso não cabe numa execução — cabe em duas.
 *
 *   A (esta)  cria o link com `endDate` = hoje e grava o que precisa em arquivo
 *             local NÃO versionado.
 *   B         amanhã, lê o arquivo e mede AQUELE link, pela API.
 *
 * `scripts/sonda-asaas-expiracao.mjs` mede link DESATIVADO — pergunta parecida,
 * não a pergunta. Não é reaproveitada aqui, de propósito.
 *
 * ---------------------------------------------------------------------------
 * O QUE ELA RESPONDE DE GRAÇA: O FUSO
 *
 * Se o Asaas ACEITAR `endDate` de hoje, lá ainda é hoje. Se recusar com "não
 * pode ser inferior a data de hoje", o dia já virou no fuso dele — e aí a
 * resposta é rodar amanhã cedo. Os dois casos ficam registrados com a hora
 * local e a hora que o Asaas reportou (header `Date` da resposta, que é o
 * relógio DELE, em UTC).
 *
 * ---------------------------------------------------------------------------
 * NÃO RODA NA SUÍTE. Cria objeto no Asaas. E não cria subconta, não usa chave
 * de produção (recusa qualquer prefixo que não seja de homologação) e não deixa
 * a chave sair impressa.
 *
 * Uso:
 *   npm run sonda:a-criar
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classificarRespostaApi, redigir } from './lib/asaas.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASTA = path.join(RAIZ, '.sonda-asaas');            // gitignored
const ARQ = path.join(PASTA, 'link-expiracao.json');
const BASE = 'https://api-sandbox.asaas.com';
const KEY = process.env.ASAAS_SANDBOX_KEY;

// Mesmos parâmetros da sonda anterior, pelos mesmos motivos: R$ 5,00 é o piso
// medido; `dueDateLimitDays` = 1 é o menor prazo do lado do Asaas, para não
// criar um segundo prazo competindo com o nosso.
const VALOR = 5.0;
const DIAS_UTEIS = 1;

if (!KEY) {
  console.error('FALTA ASAAS_SANDBOX_KEY em .env.local (o script do package.json passa --env-file).');
  process.exit(2);
}
if (!/^\$?aact_(hmlg|sandbox)/i.test(KEY)) {
  console.error('ABORTADO: a chave não tem prefixo de sandbox (`$aact_hmlg_...`). Esta sonda cria objeto.');
  process.exit(2);
}

// NÃO CRIA DOIS. Se já existe um link gravado e ele ainda não foi medido pela
// B, criar outro deixaria dois objetos vivos no sandbox e o arquivo apontando
// para o segundo — o primeiro viraria lixo sem dono.
if (fs.existsSync(ARQ)) {
  const ant = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
  if (!ant.medido_em) {
    console.error(`
JÁ EXISTE UM LINK GRAVADO E NÃO MEDIDO: ${ant.id} (endDate ${ant.endDate}).
Rode a sonda B primeiro (npm run sonda:b-conferir). Se ela disser que ainda não
virou o dia, espere. Para descartar este e criar outro, apague ${path.relative(RAIZ, ARQ)}.
`);
    process.exit(1);
  }
}

// Data LOCAL de hoje, no formato do Asaas. A resposta dele é que diz se "hoje"
// aqui é "hoje" lá.
const hojeLocal = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

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

console.log('== Sonda A — criar o link com endDate = HOJE ==');
console.log(`   hora local: ${new Date().toString()}`);
console.log(`   endDate pedido: ${hojeLocal}`);

const criado = await req('POST', '/v3/paymentLinks', {
  name: 'Sonda de expiracao A/B (descartavel)',
  description: 'Objeto de teste — scripts/sonda-a-criar-link-expiracao.mjs. A sonda B o remove.',
  billingType: 'PIX', chargeType: 'DETACHED',
  value: VALOR,
  endDate: hojeLocal,
  dueDateLimitDays: DIAS_UTEIS,
  notificationEnabled: false,
});
const cl = classificarRespostaApi(criado);

console.log(`\n--- POST /v3/paymentLinks (endDate=${hojeLocal})`);
console.log(`    HTTP ${criado.status}  ->  ${cl.classe}  (${cl.motivo})`);
for (const e of cl.erros) console.log(`      · ${redigir(e)}`);
console.log(`    relógio do Asaas (header Date, UTC): ${criado.dataServidor ?? '(ausente)'}`);

// ---------------------------------------------------------------------------
// A PERGUNTA DO FUSO, respondida pelo que aconteceu — e registrada nos dois
// casos. Um arquivo de registro que só existe quando dá certo esconde o "dia já
// virou lá" que é exatamente o dado que decide QUANDO rodar de novo.
// ---------------------------------------------------------------------------
fs.mkdirSync(PASTA, { recursive: true });
const registro = {
  criado_em_local: new Date().toString(),
  criado_em_iso: new Date().toISOString(),
  relogio_asaas_utc: criado.dataServidor ?? null,
  endDate_pedido: hojeLocal,
  http: criado.status,
  classe: cl.classe,
  erros: cl.erros,
};

if (cl.classe !== 'ok' || !criado.json?.id) {
  const recusouData = cl.erros.some((e) => /inferior a data de hoje/i.test(e));
  registro.fuso = recusouData
    ? 'O DIA JÁ VIROU NO ASAAS: endDate de hoje (local) foi recusado como passado. Rode amanhã cedo.'
    : 'a criação falhou por outro motivo — ver `erros`';
  fs.writeFileSync(path.join(PASTA, 'ultima-tentativa-falhou.json'), JSON.stringify(registro, null, 2));
  console.log(`\n✗ NÃO CRIOU. ${registro.fuso}`);
  console.log(`  registrado em ${path.relative(RAIZ, path.join(PASTA, 'ultima-tentativa-falhou.json'))}`);
  process.exit(1);
}

registro.fuso = `ACEITOU endDate=${hojeLocal}: no relógio do Asaas ainda é hoje.`;
registro.id = criado.json.id;
registro.url = criado.json.url;
registro.endDate = criado.json.endDate ?? hojeLocal;
// TUDO que o Asaas devolveu sobre o objeto, para a B comparar campo a campo.
// Se um campo novo aparecer ou mudar de valor amanhã, é ali que a expiração se
// manifesta — e eu não sei de antemão qual campo é.
registro.objeto_ao_criar = criado.json;

// Releitura imediata: o objeto como a API o descreve AGORA, no dia do endDate.
// É a base de comparação da B.
const relido = await req('GET', `/v3/paymentLinks/${registro.id}`);
registro.objeto_relido = relido.json;
registro.relido_http = relido.status;
registro.medido_em = null;

fs.writeFileSync(ARQ, JSON.stringify(registro, null, 2));

console.log(`
✓ CRIADO   id: ${registro.id}
           URL: ${registro.url}
           endDate: ${registro.endDate}
           active agora: ${JSON.stringify(relido.json?.active)}   deleted: ${JSON.stringify(relido.json?.deleted)}

  ${registro.fuso}

  registrado em ${path.relative(RAIZ, ARQ)} (NÃO versionado)

AMANHÃ: npm run sonda:b-conferir
  Ela recusa rodar enquanto o relógio do Asaas ainda estiver em ${registro.endDate}.
`);
process.exit(0);
