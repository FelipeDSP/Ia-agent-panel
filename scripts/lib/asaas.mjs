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
export function classificarRespostaApi(r) {
  const erros = Array.isArray(r?.json?.errors)
    ? r.json.errors.map((e) => String(e?.description ?? '')).filter(Boolean)
    : [];

  if (r.status >= 200 && r.status < 300) {
    return { classe: 'ok', motivo: `HTTP ${r.status}`, erros };
  }
  if (r.status === 401 || r.status === 403) {
    return { classe: 'autenticacao', motivo: `HTTP ${r.status}`, erros };
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
