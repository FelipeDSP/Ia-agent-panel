#!/usr/bin/env node
/**
 * SONDA — o que o Asaas faz com um link de pagamento que não vale mais.
 *
 * ---------------------------------------------------------------------------
 * A PRIMEIRA VERSÃO DESTA SONDA TINHA UMA ESTRATÉGIA IMPOSSÍVEL
 *
 * Ela criava o link com `endDate` no passado, para nascer expirado. O sandbox
 * recusou com HTTP 400 e três erros de uma vez, em 10/09/2026:
 *
 *   "O valor mínimo para cobranças via Boleto e Pix é R$ 5,00."
 *   "É necessário informar a quantidade de dias úteis para vencimento da cobrança."
 *   "A data de encerramento do link de pagamento não pode ser inferior a data de hoje."
 *
 * A recusa É O DADO, e o terceiro erro mata o plano: **não dá para criar um link
 * já expirado.** A chave e a autenticação estavam certas — nenhum dos três erros
 * é de credencial.
 *
 * ---------------------------------------------------------------------------
 * EXPIRADO E DESATIVADO NÃO SÃO A MESMA COISA, E ESTA SONDA NÃO OS CONFUNDE
 *
 * A pergunta original é sobre link EXPIRADO. O caminho fácil é criar válido e
 * desativar (`active=false`) — mas isso responde uma pergunta PARECIDA, não A
 * pergunta: nada garante que o Asaas trate os dois estados igual.
 *
 * Então ela tenta os dois, separadamente, e ROTULA cada resultado pelo estado
 * que de fato produziu:
 *
 *   TENTATIVA A (expirado)   `PUT endDate` para ontem. Se o Asaas aceitar, temos
 *                            um link genuinamente expirado. Se recusar — e a
 *                            recusa na criação sugere que vai recusar —, isso
 *                            fica registrado como "não consegui medir".
 *   TENTATIVA B (desativado) `PUT active=false`. Sempre mensurável.
 *
 * Os outros caminhos até um link genuinamente expirado foram avaliados e
 * descartados, com motivo:
 *
 *   - **esperar a virada do dia** com `endDate` de hoje: funciona e é a única
 *     forma limpa de obter expiração de verdade, mas leva até 24 h e não cabe
 *     numa sonda que se roda para decidir agora. Fica REGISTRADO como o caminho
 *     definitivo se a tentativa A não passar — é barato (um link, um `GET` no
 *     dia seguinte) e responde sem aproximação;
 *   - **cobrança avulsa (`/v3/payments`) com `dueDate` no passado**: mede outra
 *     coisa. Cobrança vencida é `PAYMENT_OVERDUE` e continua pagável por
 *     desenho — é o boleto atrasado de sempre. Não é link de pagamento fora da
 *     janela, que é o que o nosso fluxo produz.
 *
 * ---------------------------------------------------------------------------
 * O QUE ELA MEDE DE VERDADE, E O QUE ELA NÃO MEDE
 *
 * Não existe API para "pagar um link" — a página pública é que gera a cobrança
 * quando alguém a preenche. Então o que dá para medir daqui é **se a página
 * ainda se oferece para pagamento**, não se o dinheiro consegue se mover. A
 * sonda diz isso em vez de arredondar, e devolve `indeterminado` quando o HTML
 * não dá pista — que é resultado, não falha.
 *
 * ---------------------------------------------------------------------------
 * NÃO RODA NA SUÍTE, e não deve: fala com serviço externo e cria objeto lá.
 * `npm run teste` varre o prefixo `teste:`; esta é `sonda:`, de propósito.
 *
 * O que PRECISA ser provado sem rede — que ela distingue "o link não vale mais"
 * de "a chamada falhou" — mora em `scripts/lib/asaas.mjs` e é medido por
 * `npm run teste:asaas-classificacao`, na suíte, contra o 400 real acima.
 *
 * ---------------------------------------------------------------------------
 * Uso:
 *   npm run sonda:asaas-expiracao
 *
 * A chave sai de `.env.local` (`ASAAS_SANDBOX_KEY`) pelo `--env-file` do script
 * do package.json. NÃO passe na linha de comando: isso põe uma chave que
 * movimenta dinheiro no histórico do shell, e o `x-foto-secret` deste projeto
 * já vazou três vezes por estar onde alguém não esperava.
 *
 * Ela recusa qualquer chave que não seja de sandbox/homologação.
 */
import { classificarPaginaPublica, classificarRespostaApi, redigir } from './lib/asaas.mjs';

const BASE = 'https://api-sandbox.asaas.com';
const KEY = process.env.ASAAS_SANDBOX_KEY;

// ---------------------------------------------------------------------------
// PARÂMETROS, e o porquê de cada um
// ---------------------------------------------------------------------------
// R$ 5,00: o PISO do Asaas para Pix e boleto, descoberto pela recusa. A sonda
// usa exatamente o piso porque é o menor valor criável — quanto menor o objeto
// de teste, menos ele parece movimento real no sandbox.
const VALOR = 5.0;

// `dueDateLimitDays` = 1, e é o MENOR que faz sentido, não um número redondo.
// Ele é "dias úteis que o cliente pode pagar depois do boleto gerado" — ou
// seja, um SEGUNDO prazo, do lado do Asaas. A autoridade sobre o prazo no nosso
// desenho é `pedido_cobrancas.expira_em`, em MINUTOS. Um valor maior aqui
// criaria um prazo mais longo competindo com o nosso, e a pergunta "está fora
// do prazo?" passaria a ter duas respostas diferentes conforme quem pergunta.
const DIAS_UTEIS = 1;

const dia = (offsetDias) =>
  new Date(Date.now() + offsetDias * 86400000).toISOString().slice(0, 10);

let problemas = 0;
const nota = [];
const diz = (m) => { console.log(m); nota.push(m); };

if (!KEY) {
  console.error(`
FALTA A CREDENCIAL.

  npm run sonda:asaas-expiracao

Ele carrega \`.env.local\` pelo \`--env-file\`. Se a chave não estiver lá, ponha
\`ASAAS_SANDBOX_KEY=$aact_hmlg_...\` nela — e NÃO na linha de comando.
`);
  process.exit(2);
}
if (!/^\$?aact_/.test(KEY)) {
  console.error('ABORTADO: isso não tem forma de chave do Asaas (`$aact_...`).');
  process.exit(2);
}
// TRAVA DE AMBIENTE. As chaves do Asaas carregam o ambiente no prefixo
// (`hmlg` = homologação/sandbox). Uma chave de produção aqui criaria cobrança
// de verdade contra a base de sandbox — e "eu conferi antes de rodar" não é
// controle, é lembrança.
if (!/^\$?aact_(hmlg|sandbox)/i.test(KEY)) {
  console.error(`
ABORTADO: a chave não tem prefixo de sandbox (\`$aact_hmlg_...\`).

Esta sonda CRIA e REMOVE objetos. Rodá-la com chave de produção mexeria em
cobrança de cliente. Se a sua chave de sandbox tiver outro prefixo, mude esta
verificação de propósito — não contorne por fora.
`);
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
  return { status: r.status, json, txt };
};

const pagina = async (url) => {
  try {
    const r = await fetch(url, { redirect: 'follow' });
    return { status: r.status, html: await r.text() };
  } catch (e) {
    return { status: 0, html: '', erro: e.message };
  }
};

const mostraApi = (rot, r) => {
  const cl = classificarRespostaApi(r);
  console.log(`\n--- ${rot}`);
  console.log(`    HTTP ${r.status}  ->  ${cl.classe}  (${cl.motivo})`);
  for (const e of cl.erros) console.log(`      · ${redigir(e)}`);
  return cl;
};

const mostraPagina = (rot, p) => {
  const cl = classificarPaginaPublica(p);
  console.log(`\n--- ${rot}`);
  console.log(`    HTTP ${p.status} (${p.html.length} bytes)  ->  ${cl.classe}  (${cl.motivo})`);
  return cl;
};

console.log('== Sonda: link de pagamento fora do prazo (SANDBOX) ==');
console.log(`   valor R$ ${VALOR.toFixed(2)} (o piso do Asaas)   dueDateLimitDays=${DIAS_UTEIS}`);

let saida = 0;
let id = null;
let bytesBase = null;

try {
  // =========================================================================
  // 0. AUTOTESTE: ela distingue erro de VALOR de veredito sobre o link?
  // =========================================================================
  // Feito ANTES de qualquer medição, e contra o Asaas de verdade: uma sonda
  // que não sabe separar os dois casos não deve chegar a opinar sobre nenhum.
  console.log('\n\n######## 0. Autoteste da discriminação ########');
  const abaixo = await req('POST', '/v3/paymentLinks', {
    name: 'Sonda — autoteste de valor (deve ser RECUSADO)',
    billingType: 'PIX', chargeType: 'DETACHED',
    value: 1.0,                                   // abaixo do piso, de propósito
    endDate: dia(1), dueDateLimitDays: DIAS_UTEIS,
    notificationEnabled: false,
  });
  const clAbaixo = mostraApi('criar link de R$ 1,00 (esperado: recusa por VALOR)', abaixo);
  if (clAbaixo.classe === 'falha_de_chamada') {
    diz('  ✓ erro de valor foi classificado como `falha_de_chamada`, NÃO como link inválido');
  } else if (clAbaixo.classe === 'ok') {
    problemas++;
    diz('  ✗ o Asaas ACEITOU R$ 1,00 — o piso de R$ 5,00 mudou, ou não vale para este caminho.');
    diz('    ISSO É ACHADO: reveja a §6 do doc de entrega antes de confiar no piso.');
    if (abaixo.json?.id) await req('DELETE', `/v3/paymentLinks/${abaixo.json.id}`);
  } else {
    problemas++;
    diz(`  ✗ recusa veio como \`${clAbaixo.classe}\` — a sonda não está discriminando. Pare aqui.`);
  }

  // =========================================================================
  // 1. O link VÁLIDO — a base de comparação
  // =========================================================================
  console.log('\n\n######## 1. Link válido (a base) ########');
  const criado = await req('POST', '/v3/paymentLinks', {
    name: 'Sonda de expiracao (descartavel)',
    description: 'Objeto de teste — scripts/sonda-asaas-expiracao.mjs',
    billingType: 'PIX', chargeType: 'DETACHED',
    value: VALOR,
    endDate: dia(1),                              // amanhã: nasce VÁLIDO
    dueDateLimitDays: DIAS_UTEIS,
    notificationEnabled: false,
  });
  const clCriado = mostraApi(`criar link válido (endDate=${dia(1)})`, criado);
  id = criado.json?.id ?? null;
  const url = criado.json?.url ?? null;

  if (clCriado.classe !== 'ok' || !id || !url) {
    problemas++;
    diz('  ✗ não consegui criar o link válido — nada a sondar. A resposta acima é o dado.');
    throw new Error('sem link para sondar');
  }
  diz(`  ✓ link criado: ${id}`);

  const pagBase = await pagina(url);
  const base = mostraPagina('a página do link VÁLIDO', pagBase);
  bytesBase = pagBase.html.length;
  diz(`  · base (válido): ${base.classe}, ${bytesBase} bytes`);
  if (base.classe !== 'pagavel') {
    diz('  ! a base não deu `pagavel`. Sem base, "mudou depois de expirar" não tem contra o quê');
    diz('    comparar — trate os resultados abaixo como INDETERMINADOS e abra a URL no navegador.');
  }

  // =========================================================================
  // 2. TENTATIVA A — link genuinamente EXPIRADO
  // =========================================================================
  console.log('\n\n######## 2. Tentativa A: EXPIRADO (endDate no passado) ########');
  const recuar = await req('PUT', `/v3/paymentLinks/${id}`, { endDate: dia(-1) });
  const clRecuar = mostraApi(`PUT endDate=${dia(-1)} (ontem)`, recuar);

  let veredito_expirado = null;
  if (clRecuar.classe === 'ok') {
    diz('  ✓ o Asaas ACEITOU recuar o endDate — este link está genuinamente EXPIRADO');
    const p = mostraPagina('a página do link EXPIRADO', await pagina(url));
    veredito_expirado = p.classe;
    diz(`  · EXPIRADO -> ${p.classe} (${p.motivo})`);
  } else {
    diz('  ✗ NÃO CONSEGUI PRODUZIR UM LINK EXPIRADO por este caminho.');
    diz('    O `PUT` recusou pelo mesmo motivo que a criação recusou.');
    diz('    O caminho que resta é `endDate` = HOJE e um `GET` amanhã. Ver §6 do doc.');
    veredito_expirado = 'NAO_MEDIDO';
  }

  // =========================================================================
  // 3. TENTATIVA B — link DESATIVADO (pergunta parecida, NÃO a mesma)
  // =========================================================================
  console.log('\n\n######## 3. Tentativa B: DESATIVADO (active=false) ########');
  const desativar = await req('PUT', `/v3/paymentLinks/${id}`, { active: false });
  const clDesativar = mostraApi('PUT active=false', desativar);

  let veredito_desativado = null;
  if (clDesativar.classe === 'ok') {
    // CONFIRMA QUE A MUTAÇÃO ENTROU antes de acreditar no que a página diz.
    // Sem esta leitura, "continua pagável" e "o PUT não fez nada" são
    // indistinguíveis — e a segunda leitura é a confortável.
    const relido = await req('GET', `/v3/paymentLinks/${id}`);
    const ativo = relido.json?.active;
    console.log(`\n--- reler o link -> HTTP ${relido.status}  active=${JSON.stringify(ativo)}`
      + `  endDate=${JSON.stringify(relido.json?.endDate)}`);
    if (ativo === false) {
      diz('  ✓ o Asaas CONFIRMA `active: false` — a desativação entrou');
      const pagDes = await pagina(url);
      const p = mostraPagina('a página do link DESATIVADO', pagDes);
      veredito_desativado = p.classe;
      diz(`  · DESATIVADO -> ${p.classe} (${p.motivo})`);
      // O TAMANHO É SINAL, NÃO VEREDITO. A página pode mudar bastante e
      // continuar oferecendo pagamento; pode mudar nada e ter mudado o
      // comportamento por JavaScript. Fica registrado para quem for abrir no
      // navegador saber o que procurar.
      if (bytesBase !== null) {
        const d = pagDes.html.length - bytesBase;
        const pct = Math.round((d / bytesBase) * 100);
        diz(`  · a página mudou de tamanho: ${bytesBase} -> ${pagDes.html.length} bytes (${pct}%)`);
        if (Math.abs(pct) > 5 && p.classe === 'pagavel') {
          diz('    ! mudou MUITO e ainda assim deu `pagavel`: o HTML é indício, não prova.');
          diz('      ABRA A URL NO NAVEGADOR antes de escrever isto como conclusão.');
        }
      }
    } else {
      problemas++;
      veredito_desativado = 'NAO_MEDIDO';
      diz(`  ✗ o PUT devolveu 200 mas o link relido tem active=${JSON.stringify(ativo)}.`);
      diz('    Nada foi medido: sem a mutação confirmada, o que a página diz não é sobre desativação.');
    }
  } else {
    veredito_desativado = 'NAO_MEDIDO';
    diz('  ✗ não consegui desativar — ver a resposta acima.');
  }

  // =========================================================================
  // 4. O VEREDITO, rotulado pelo estado que foi de fato produzido
  // =========================================================================
  console.log('\n\n######## 4. Veredito ########\n');
  console.log(`   EXPIRADO   (a pergunta original) : ${veredito_expirado}`);
  console.log(`   DESATIVADO (pergunta parecida)   : ${veredito_desativado}`);
  console.log('');
  if (veredito_expirado === 'NAO_MEDIDO') {
    console.log('   NÃO MEDI LINK EXPIRADO. O que está acima sobre DESATIVADO é sobre');
    console.log('   desativado — não escreva no doc como se fosse sobre expirado.');
  }
} catch (e) {
  problemas++;
  console.log(`\n  EXCEÇÃO: ${redigir(e.message)}`);
} finally {
  // Limpeza: o objeto foi criado por esta sonda e não deve ficar.
  if (id) {
    const r = await req('DELETE', `/v3/paymentLinks/${id}`);
    console.log(`\n--- remover o link da sonda -> HTTP ${r.status}`);
  }
}

console.log(`
============================================================
ESCREVA O RESULTADO em docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md §6,
com o RÓTULO CERTO — expirado é expirado, desativado é desativado.

"Não consegui medir" é resultado. "Medi algo parecido e assumi que
vale" é como se acumula caso que passou pelo motivo errado.
============================================================`);

saida = problemas ? 1 : 0;
// `process.exit` explícito: o agente de keep-alive do `fetch` segura handles no
// encerramento e o Node no Windows estoura
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` DEPOIS de tudo já ter
// sido impresso. É problema conhecido do Node no Windows, não da sonda — sair
// aqui evita que o ruído se misture ao resultado.
process.exit(saida);
