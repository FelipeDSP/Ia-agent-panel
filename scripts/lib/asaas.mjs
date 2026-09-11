/**
 * Classificação de resposta do Asaas — pura, sem rede, sem credencial.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ISTO É UM MÓDULO E NÃO UM `if` DENTRO DA SONDA
 *
 * A exigência que o criou:
 *
 *   "Uma sonda que imprime «recusou o pagamento» porque a requisição falhou por
 *    OUTRO motivo — valor, formato, campo faltando — parece resposta e não é."
 *
 * Enquanto a lógica vivesse dentro da sonda, provar que ela distingue os dois
 * casos exigiria rodar a sonda, que exige credencial e cria objeto no Asaas.
 * Aqui, `tests/asaas-classificacao.mjs` roda na suíte, sem rede, contra as
 * respostas REAIS que o sandbox devolveu — inclusive o 400 de três erros que
 * derrubou a primeira execução.
 *
 * ---------------------------------------------------------------------------
 * A DISTINÇÃO QUE ESTE ARQUIVO EXISTE PARA FAZER
 *
 *   `falha_de_chamada`   — o Asaas recusou a REQUISIÇÃO: valor abaixo do
 *                          mínimo, campo obrigatório faltando, data inválida.
 *                          NÃO diz nada sobre o link estar ou não valendo.
 *   `link_indisponivel`  — o link em si não vale mais.
 *   `pagavel`            — a página se apresenta como paga-vel.
 *   `indeterminado`      — não deu para dizer. É RESULTADO, não falha: é o que
 *                          impede "medi algo parecido e assumi que vale".
 */

/** Sinais de que o Asaas recusou a REQUISIÇÃO, não o link. */
const CODIGOS_VALIDACAO = new Set(['invalid_action', 'invalid_value', 'invalid_object']);

/**
 * Frases de validação vistas de verdade. Fixture, não invenção: as três
 * primeiras são o corpo literal do 400 que o sandbox devolveu em 10/09/2026.
 */
export const VALIDACOES_CONHECIDAS = [
  'O valor mínimo para cobranças via Boleto e Pix é R$ 5,00.',
  'É necessário informar a quantidade de dias úteis para vencimento da cobrança.',
  'A data de encerramento do link de pagamento não pode ser inferior a data de hoje.',
];

/**
 * Uma resposta da API do Asaas.
 * @param {{status:number, json:any}} r
 * @returns {{classe:string, motivo:string, erros:string[]}}
 */
/**
 * A frase REAL do 403 de criação de subconta por conta PF — sandbox, 11/09/2026.
 * Vem em `message`, não em `errors[]`; foi por isso que a primeira leitura da
 * sonda C saiu como `autenticacao` (403 sem corpo reconhecível). Fixture.
 */
export const RECUSA_SUBCONTA_PF =
  'Contas de pessoa física (CPF) não podem criar subcontas no Asaas. Apenas contas de '
  + 'pessoa jurídica (CNPJ) podem acessar essa funcionalidade. Consulte as regras dos nossos produtos.';

export function classificarRespostaApi(r) {
  // `errors[]` é o formato de validação; `message` é o de recusa por regra de
  // conta. Os dois entram em `erros`, senão a recusa mais importante que esta
  // sonda já viu chegaria como "403 sem motivo".
  const erros = [
    ...(Array.isArray(r?.json?.errors)
      ? r.json.errors.map((e) => String(e?.description ?? '')).filter(Boolean)
      : []),
    ...(typeof r?.json?.message === 'string' && r.json.message.trim() ? [r.json.message.trim()] : []),
  ];

  if (r.status >= 200 && r.status < 300) {
    return { classe: 'ok', motivo: `HTTP ${r.status}`, erros };
  }
  if (r.status === 401) {
    return { classe: 'autenticacao', motivo: 'HTTP 401', erros };
  }
  if (r.status === 403) {
    // 403 COM mensagem é PERMISSÃO — a chave vale, a conta é que não pode. É o
    // caso "conta PF não cria subconta". 403 sem mensagem continua sendo
    // tratado como autenticação, que é o que ele costuma ser.
    return erros.length
      ? { classe: 'permissao', motivo: 'HTTP 403: a conta não pode fazer isto', erros }
      : { classe: 'autenticacao', motivo: 'HTTP 403', erros };
  }
  if (r.status === 404) {
    // 404 numa chamada de LEITURA de link é "esse link não existe (mais)".
    // Continua não sendo "expirou": removido e expirado são coisas diferentes.
    return { classe: 'nao_encontrado', motivo: 'HTTP 404', erros };
  }
  if (r.status === 400) {
    const codigos = Array.isArray(r?.json?.errors)
      ? r.json.errors.map((e) => String(e?.code ?? ''))
      : [];
    const ehValidacao = codigos.some((c) => CODIGOS_VALIDACAO.has(c)) || erros.length > 0;
    // 400 É VALIDAÇÃO, SEMPRE — e nunca "o link não vale mais". Esta linha é a
    // que a exigência pediu: um erro de valor não pode virar veredito sobre a
    // vida do link.
    return {
      classe: ehValidacao ? 'falha_de_chamada' : 'indeterminado',
      motivo: ehValidacao ? 'o Asaas recusou a REQUISIÇÃO (validação)' : 'HTTP 400 sem corpo reconhecível',
      erros,
    };
  }
  return { classe: 'indeterminado', motivo: `HTTP ${r.status}`, erros };
}

/**
 * Pistas de indisponibilidade na PÁGINA pública. Sem acento e minúsculas: o
 * HTML é comparado depois de `.toLowerCase()` e de tirar acento, porque
 * "indisponível" e "indisponivel" aparecem os dois.
 */
export const PISTAS_INDISPONIVEL = [
  'expirado', 'expirada', 'vencido', 'vencida', 'encerrado', 'encerrada',
  'indisponivel', 'inativo', 'inativa', 'nao esta mais', 'nao esta disponivel',
  'link invalido', 'nao encontrado', 'pagina nao encontrada',
  // A FRASE REAL, medida no sandbox em 10/09/2026 abrindo a página no
  // navegador: "Seu fornecedor desabilitou esse link de pagamento." Ela não
  // estava nesta lista, e a ausência dela produziu um veredito ERRADO — ver o
  // bloco abaixo.
  'desabilitou', 'desabilitado', 'desabilitada',
];

/**
 * Pistas de que a página está OFERECENDO pagamento.
 *
 * ATENÇÃO — ESTAS PISTAS SÃO FRACAS, E ISSO FOI MEDIDO, NÃO SUPOSTO.
 *
 * A página do Asaas é uma SPA: o HTML servido traz "pix", "boleto", "qr code" e
 * "forma de pagamento" no esqueleto, **mesmo quando o link não vale mais**. Em
 * 10/09/2026 a sonda classificou um link comprovadamente desativado
 * (`active:false` relido da API) como `pagavel` — e abrir a URL no navegador
 * mostrou "Seu fornecedor desabilitou esse link de pagamento".
 *
 * Por isso a ordem importa e não é estilo: `indisponivel` é avaliada PRIMEIRO.
 * Uma pista forte de recusa vence qualquer quantidade de pista fraca de oferta.
 *
 * E por isso `pagavel` continua sendo INDÍCIO. Se a decisão depender dele,
 * abra no navegador — foi assim que o erro apareceu.
 */
export const PISTAS_PAGAVEL = [
  'pix', 'boleto', 'copiar codigo', 'qr code', 'pagar', 'forma de pagamento',
];

const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * A PÁGINA pública do link. Ela é o que o cliente abre — não há API para
 * "pagar um link".
 *
 * ATENÇÃO AO QUE ISTO MEDE: se a página se OFERECE para pagamento, não se o
 * dinheiro consegue se mover. São coisas diferentes e a sonda diz isso.
 *
 * @param {{status:number, html:string}} r
 */
export function classificarPaginaPublica(r) {
  const html = semAcento(r?.html ?? '');
  const indisponivel = PISTAS_INDISPONIVEL.filter((p) => html.includes(p));
  const pagavel = PISTAS_PAGAVEL.filter((p) => html.includes(p));

  if (r.status === 404 || r.status === 410) {
    return { classe: 'link_indisponivel', motivo: `HTTP ${r.status}`, indisponivel, pagavel };
  }
  if (r.status >= 400) {
    return { classe: 'indeterminado', motivo: `HTTP ${r.status}`, indisponivel, pagavel };
  }
  if (indisponivel.length > 0) {
    return {
      classe: 'link_indisponivel',
      motivo: `a página diz: ${indisponivel.join(', ')}`,
      indisponivel, pagavel,
    };
  }
  if (pagavel.length > 0) {
    return {
      classe: 'pagavel',
      motivo: `a página oferece pagamento (${pagavel.join(', ')})`,
      indisponivel, pagavel,
    };
  }
  // NÃO É "pagável". Página que renderiza por JavaScript devolve casca vazia, e
  // chamar casca de "pagável" seria exatamente o "medi algo parecido".
  return {
    classe: 'indeterminado',
    motivo: 'HTML sem pista de nenhum dos lados (SPA? abra no navegador)',
    indisponivel, pagavel,
  };
}

/**
 * Tira qualquer coisa com forma de chave do Asaas de um texto antes de
 * imprimir. O `x-foto-secret` deste projeto vazou três vezes por estar em
 * lugar que alguém imprimiu ou exportou; uma chave que movimenta dinheiro não
 * repete esse caminho por falta de quatro linhas.
 */
export function redigir(texto) {
  return String(texto).replace(/\$?aact_[A-Za-z0-9_\-=+/:.]+/g, '$aact_***REDIGIDO***');
}

/**
 * O link LIDO PELA API depois de o dia do `endDate` ter virado.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ISTO NÃO LÊ HTML, E O QUE ISSO CUSTA
 *
 * A página do Asaas é uma SPA e serve "pix", "boleto" e "qr code" no esqueleto
 * mesmo com o link inválido — foi o que enganou a sonda de 10/09. Então a
 * pergunta "o link ainda aceita pagamento?" é respondida pelo que a API do
 * próprio Asaas diz do objeto, e não pelo que a página parece oferecer.
 *
 * O CUSTO, dito de frente: não existe API para "pagar um link". Então "AINDA
 * ACEITA" aqui significa "a API continua descrevendo o link como ativo e não
 * removido depois do endDate" — o Asaas não o desligou. E "RECUSA" significa
 * "a API passou a descrevê-lo como inativo" — e em 10/09 foi medido, abrindo a
 * página, que link com `active:false` recusa com "Seu fornecedor desabilitou
 * esse link de pagamento". A cadeia é essa e está escrita; não é observação
 * direta do pagamento sendo recusado.
 *
 * ---------------------------------------------------------------------------
 * AS TRÊS COISAS QUE NÃO PODEM SER CONFUNDIDAS
 *
 *   `expirou_recusa`      passou do endDate E a API diz inativo/removido
 *   `expirou_aceita`      passou do endDate E a API ainda diz ativo
 *   `falha_de_chamada`    a leitura falhou por OUTRO motivo (401, 404, 400,
 *                         rede) — NÃO diz nada sobre expiração
 *   `ainda_no_prazo`      o dia do endDate ainda não virou NO RELÓGIO DO ASAAS
 *                         (header `Date` da resposta). Rodar a sonda B cedo
 *                         demais mediria "link válido" e chamaria de "aceita".
 *
 * @param {{
 *   leitura: {status:number, json:any},
 *   endDate: string,             // 'YYYY-MM-DD', o gravado pela sonda A
 *   dataServidor: string|null,   // header `Date` da resposta, RFC 1123
 * }} p
 */
export function classificarLinkDepoisDoPrazo({ leitura, endDate, dataServidor }) {
  const api = classificarRespostaApi(leitura);
  if (api.classe !== 'ok') {
    // Qualquer falha de leitura é falha de leitura. Um 404 aqui NÃO é "expirou
    // e o Asaas removeu": removido é `deleted:true` num 200, e o 404 é o id
    // errado ou a chave errada.
    return { classe: 'falha_de_chamada', motivo: `${api.classe}: ${api.motivo}`, campos: {} };
  }

  // O RELÓGIO É O DO ASAAS, não o da máquina que roda a sonda. `Date` vem em
  // UTC; o Asaas fecha o dia em Brasília (UTC-3). Convertido para o dia em
  // Brasília antes de comparar — senão entre 21h e 00h de Brasília o UTC já
  // está no dia seguinte e a sonda diria "virou" sem ter virado.
  let diaAsaas = null;
  if (dataServidor) {
    const t = Date.parse(dataServidor);
    if (!Number.isNaN(t)) diaAsaas = new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10);
  }
  const campos = {
    active: leitura.json?.active ?? null,
    deleted: leitura.json?.deleted ?? null,
    endDate: leitura.json?.endDate ?? null,
    diaAsaas,
  };

  if (diaAsaas && diaAsaas <= endDate) {
    return {
      classe: 'ainda_no_prazo',
      motivo: `no relógio do Asaas ainda é ${diaAsaas}, e o link vale até ${endDate}`,
      campos,
    };
  }
  if (!diaAsaas) {
    return { classe: 'indeterminado', motivo: 'sem header Date — não sei que dia é no Asaas', campos };
  }
  if (campos.deleted === true || campos.active === false) {
    return {
      classe: 'expirou_recusa',
      motivo: `dia ${diaAsaas} > endDate ${endDate}, e a API diz `
        + (campos.deleted === true ? 'deleted:true' : 'active:false'),
      campos,
    };
  }
  if (campos.active === true) {
    return {
      classe: 'expirou_aceita',
      motivo: `dia ${diaAsaas} > endDate ${endDate}, e a API AINDA diz active:true`,
      campos,
    };
  }
  return { classe: 'indeterminado', motivo: 'a API não informou `active`', campos };
}

/**
 * A tentativa de COBRAR com a chave de uma SUBCONTA recém-criada.
 *
 * A pergunta que decide se o teste do agente é viável: a subconta já consegue
 * gerar cobrança, ou nasce pendente de documentação? E ela tem de ser separada
 * de "a chamada falhou por outro motivo" — valor abaixo do piso, campo faltando,
 * chave errada — que não diz nada sobre a subconta.
 *
 *   `ok`                  criou a cobrança: a subconta opera
 *   `pendencia_cadastro`  o Asaas recusou POR CAUSA DO CADASTRO da subconta
 *                         (documentação, aprovação, análise, conta bloqueada)
 *   `falha_de_chamada`    recusou a REQUISIÇÃO (valor, campo, formato)
 *   `autenticacao`        a chave não vale — chave errada NÃO é pendência
 *   `indeterminado`       não deu para dizer
 *
 * As pistas de cadastro vêm do vocabulário que o Asaas usa nas próprias telas e
 * erros (documentação, aprovação, análise, bloqueio). Uma recusa que não casa
 * nenhuma delas NÃO vira pendência por exclusão — vira `falha_de_chamada` se
 * for validação, ou `indeterminado`.
 */
export const PISTAS_PENDENCIA_CADASTRO = [
  'documentacao', 'documento', 'aprovacao', 'aprovada', 'aprovado', 'em analise',
  'analise de conta', 'analise cadastral', 'cadastro incompleto', 'cadastro pendente',
  'conta bloqueada', 'conta nao aprovada', 'nao esta habilitada', 'nao esta habilitado',
  'habilitacao', 'onboarding', 'pendente de',
];

export function classificarCobrancaDaSubconta(r) {
  const api = classificarRespostaApi(r);
  if (api.classe === 'ok') return { classe: 'ok', motivo: api.motivo, erros: api.erros };
  if (api.classe === 'autenticacao') return { classe: 'autenticacao', motivo: api.motivo, erros: api.erros };

  const texto = api.erros.map((e) => semAcentoLocal(e)).join(' | ');
  const pistas = PISTAS_PENDENCIA_CADASTRO.filter((p) => texto.includes(p));
  if (pistas.length > 0) {
    return { classe: 'pendencia_cadastro', motivo: `o Asaas cita: ${pistas.join(', ')}`, erros: api.erros };
  }
  if (api.classe === 'permissao') {
    // A conta não pode — e não é por documentação pendente (nenhuma pista).
    // Fica como permissão, com a frase, em vez de virar pendência por exclusão.
    return { classe: 'permissao', motivo: api.motivo, erros: api.erros };
  }
  if (api.classe === 'falha_de_chamada') {
    return { classe: 'falha_de_chamada', motivo: api.motivo, erros: api.erros };
  }
  return { classe: 'indeterminado', motivo: api.motivo, erros: api.erros };
}

function semAcentoLocal(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
