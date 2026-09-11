/**
 * A FERRAMENTA DE GERAR LINK DE PAGAMENTO — A ÚNICA FONTE.
 *
 * Mesmo padrão de `tool-pedido-acoes.mjs`: o que o modelo lê (description, dica
 * do `$fromAI`), o que o n8n executa (nomes de nó, queries) e o que o teste
 * confere saem daqui. Nada disto é escrito em dois lugares.
 *
 * ---------------------------------------------------------------------------
 * DECISÃO: FERRAMENTA SEPARADA, NÃO SEXTA AÇÃO DA FUNDIDA
 *
 * Acabamos de reduzir de 8 para 6 ferramentas de propósito, e uma tool nova
 * devolve uma. Mesmo assim é separada, por três motivos que não são de gosto:
 *
 *   1. CONTRATO. `pagamento` é uma linha própria de `catalogo_tools` (migração
 *      61), separada de `vendas`. A ferramenta fundida checa `vendas` em
 *      `Busca Config`; uma sexta ação teria de checar `pagamento` num segundo
 *      nó dentro do mesmo sub-workflow, e a `description` da fundida passaria a
 *      anunciar uma ação que um tenant com vendas-sem-pagamento não tem — o
 *      modelo chamaria e receberia "indisponível". Uma tool = um contrato é o
 *      que a regra de superfície do CLAUDE.md exige.
 *   2. O EXPERIMENTO. A `description` da fundida é a variável medida pelas 10
 *      conversas. Engordá-la depois contaminaria qualquer comparação futura:
 *      "a fabricação mudou porque são menos tools ou porque a description
 *      mudou?" deixaria de ter resposta.
 *   3. DINHEIRO ATRÁS DE `$fromAI('acao')`. A nota da fatia 2 temia `fechar`
 *      chamada em "quanto ficou?". Gerar cobrança atrás do MESMO parâmetro que
 *      `ver` é o mesmo risco com dinheiro em cima. Ferramenta própria carrega
 *      condição própria ("só depois de fechar"), e o modelo escolhe a
 *      FERRAMENTA, não um valor de string.
 *
 * O preço: 7 ferramentas em vez de 6, e o `S` sobe pelo tamanho deste schema —
 * medido em `scripts/estimar-s.mjs`, escrito no doc.
 *
 * ---------------------------------------------------------------------------
 * O QUE ELA NÃO RECEBE: valor, produto, nome de item. Recebe tenant e conversa
 * (do fluxo, nunca do `$fromAI`) e mais NADA — o schema que o modelo vê tem
 * ZERO propriedades. O servidor decide quanto (`pedidos.total_centavos`, dentro
 * de `api_n8n_gerar_cobranca`).
 *
 * ---------------------------------------------------------------------------
 * A CHAVE É A DO TENANT. `api_n8n_gerar_cobranca` devolve `api_key` e
 * `base_url` da linha de `tenant_credenciais` do tenant, no ambiente que
 * `asaas_ambiente` diz. Ela viaja no item do n8n até o nó HTTP — o que
 * significa que fica nos DADOS DE EXECUÇÃO da instância (ver o doc, §11.4).
 */

export const NO_PRINCIPAL = 'Gerar Link de Pagamento';
export const NOME_WORKFLOW = 'Tool - Gerar Link de Pagamento (Multi-Tenant)';
export const TOOL_NOME = 'pagamento';

/**
 * O id do sub-workflow NA INSTÂNCIA. Só existe depois do import; enquanto for
 * este placeholder, `gerar-principal.mjs` se RECUSA a gerar o principal com a
 * ferramenta — a fatia 2 já teve placeholder chegando ao workflow ativo e
 * quebrando em runtime, no meio de um atendimento.
 */
export const ID_WORKFLOW = 'PENDENTE_IMPORT_TOOL_PAGAMENTO';

export const ENTRADAS = [
  { name: 'tenant_id' },
  { name: 'conversation_id', type: 'number' },
];

/** `dueDateLimitDays` = 1: o menor prazo do lado do Asaas (achado da sonda A). */
export const DUE_DATE_LIMIT_DAYS = 1;

/**
 * POLÍTICA DE EXPIRAÇÃO — PENDENTE DA SONDA B (roda em 12/09).
 *
 *   'expirou_recusa'  o Asaas fecha o link ao fim do dia do endDate: o
 *                     descompasso com a nossa janela (minutos) é inofensivo, e
 *                     pagamento fora do prazo é a corrida rara do último minuto.
 *                     Desativar ao fim da janela é redundância barata.
 *   'expirou_aceita'  o link fica válido além do endDate: a diferença é de
 *                     HORAS todo dia, e desativar o link (`PUT active=false`)
 *                     ao fim da nossa janela deixa de ser opcional.
 *
 * NOS DOIS CASOS: pedido expirado que recebe pagamento NÃO reabre sozinho — o
 * webhook grava `fora_do_prazo_em`, retém o `pagamento_id`, devolve
 * `precisa_humano` e a nota privada vai ao atendente. Isso já está na 61 e no
 * webhook; o que a política muda é se existe um passo ATIVO de desativação.
 *
 * `null` enquanto a sonda B não responder. O gerador do webhook e o teste leem
 * daqui e reprovam se alguém tentar ligar a desativação sem a política decidida.
 */
export const POLITICA_EXPIRACAO = null; // 'expirou_recusa' | 'expirou_aceita'

/** Texto que o modelo lê para decidir SE chama. */
export function descricaoFerramenta() {
  return (
    'Gera o LINK DE PAGAMENTO do pedido ja fechado desta conversa e devolve a URL. '
    + 'Nao recebe valor nem itens: o valor e o do pedido no sistema. '
    + 'Use SOMENTE depois de o pedido estar fechado (gerenciar_pedido acao=fechar) e o cliente '
    + 'confirmar que vai pagar por link. Mande ao cliente a URL exatamente como ela vier, sem '
    + 'encurtar e sem transformar em texto clicavel. '
    + 'Se a resposta disser que o pedido esta ABAIXO DO MINIMO, sugira completar o pedido com o '
    + 'valor que falta; so transfira para um atendente se o cliente nao quiser. '
    + 'ESTA FERRAMENTA NAO CONFIRMA PAGAMENTO e nenhuma outra confirma: o sistema avisa quando o '
    + 'pagamento cair. Nunca diga que o pagamento foi feito, recebido ou confirmado.'
  );
}

/** A seção do system message. */
export function secaoPrompt() {
  return (
    '## Ferramenta: gerar_link_pagamento\n'
    + 'Depois de fechar o pedido, se o cliente quiser pagar por link, chame esta ferramenta. Ela '
    + 'devolve a URL; mande a URL exatamente como veio, sozinha numa linha, sem encurtar e sem '
    + 'texto clicável. Se ela disser que o pedido está abaixo do mínimo, sugira completar com o '
    + 'valor que falta; só transfira para um atendente se o cliente não quiser.\n'
    + 'VOCÊ NUNCA CONFIRMA PAGAMENTO. Nenhuma ferramenta confirma. Quando o pagamento cair, o sistema '
    + 'avisa o cliente sozinho. Se o cliente perguntar "caiu?", diga que ainda não apareceu a '
    + 'confirmação do seu lado e que ele será avisado — nunca diga que caiu.\n'
  );
}
