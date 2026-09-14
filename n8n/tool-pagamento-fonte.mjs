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
 * POLÍTICA DE EXPIRAÇÃO — DECIDIDA PELA SONDA B EM 14/09/2026: `expirou_aceita`.
 *
 * Medido três dias depois do `endDate` (link criado em 11/09 com endDate
 * 2026-09-11; lido em 14/09, relógio do Asaas Mon, 14 Sep 2026 12:26:34 GMT):
 *
 *   GET /v3/paymentLinks/uc21d65el566a7nq -> HTTP 200
 *   active: true | deleted: false | endDate: 2026-09-11 | dia no Asaas: 2026-09-14
 *   campos que mudaram desde a criação: NENHUM
 *
 * O Asaas NÃO desliga o link no `endDate`. A ressalva vai junto e não separada:
 * a sonda mediu a DESCRIÇÃO do link pela API, não uma tentativa de pagamento.
 * `active:true` diz que o Asaas não o desligou; não prova que um pagamento
 * seria aceito. A ressalva empurra para o lado conservador, então o desenho
 * não muda — o que segue assume que o link continua pagável.
 *
 * O que isso muda de peso: a nossa janela é de MINUTOS e o link fica de pé por
 * DIAS. Pagamento fora do prazo deixa de ser a corrida do último segundo e
 * vira caminho central — é o que acontece com todo cliente que demora. Três
 * consequências, e as três estão em `ENCERRAMENTO` abaixo:
 *
 *   1. DESATIVAR O LINK AO FIM DA JANELA DEIXA DE SER OPCIONAL. Se ninguém
 *      desliga, ele fica pagável indefinidamente. Entra no caminho de expiração
 *      do pedido.
 *   2. O tratamento de dinheiro que chega fora do prazo existe de verdade, não
 *      como exceção defensiva. O pedido NÃO reabre sozinho: vira caso para
 *      humano, com o pagamento retido e a divergência registrada (61 + nota
 *      privada do webhook — já estão escritos).
 *   3. Expiração curta fica mais atraente, não menos: quanto antes desativamos,
 *      menor a janela em que o link é pagável e o pedido já morreu.
 *
 * E A SONDA D (14/09) DECIDIU COMO SE DESLIGA — ver `ENCERRAMENTO`.
 *
 * Os dois valores, para quem ler isto sem o histórico:
 *   'expirou_recusa'  o Asaas fecharia o link ao fim do dia do endDate — NÃO É
 *                     O CASO. Ficou registrado porque a sonda foi escrita para
 *                     separar os dois e provou que separa.
 *   'expirou_aceita'  o link fica válido além do endDate. É o medido.
 */
export const POLITICA_EXPIRACAO = 'expirou_aceita'; // 'expirou_recusa' | 'expirou_aceita' | null

/**
 * O ENCERRAMENTO — o que o caminho de expiração faz com o link e com a
 * cobrança quando `expira_em` passa. DERIVADO da política, não escrito ao lado
 * dela: se alguém trocar `POLITICA_EXPIRACAO`, isto acompanha, e o teste
 * (`teste:tool-pagamento` §3b) afirma que o doc §6.9 diz o mesmo rótulo.
 *
 * ---------------------------------------------------------------------------
 * A SONDA D (14/09/2026) — desativar x remover, medido com uma cobrança REAL
 * gerada pela página pública (`pay_2lrx883a88py0uk1`, link `nty7sshjm68rd0nq`):
 *
 *   DESATIVAR o link (PUT active=false)   a PÁGINA recusa (10/09), mas a
 *                                         COBRANÇA já gerada fica INTACTA:
 *                                         PENDING, deleted:false, QR Code Pix
 *                                         servido, fatura oferecendo Pix e
 *                                         Open Finance (visto no navegador)
 *   REMOVER o link (DELETE) com cobrança  o Asaas RECUSA — HTTP 400, "Não é
 *                                         permitido remover links de pagamento
 *                                         com cobranças geradas." Só remove link
 *                                         sem cobrança (a sonda B removeu o dela)
 *   REMOVER a cobrança (DELETE /payments) registro CONTINUA legível (200,
 *                                         deleted:true, status PENDING); a fatura
 *                                         vira "Fatura cancelada — Esta fatura foi
 *                                         removida pelo seu fornecedor. Não é
 *                                         possivel realizar o pagamento";
 *                                         restaurável (`POST /payments/{id}/restore`,
 *                                         pela doc). Histórico NÃO some
 *
 * Então "desativar OU remover" era a pergunta errada: o link se DESATIVA (a
 * única mutação que existe para link com cobrança) e a COBRANÇA pendente se
 * REMOVE (soft delete, restaurável). Sem o segundo passo, o cliente que gerou
 * o Pix no minuto 29 paga na hora 5 — e cai em `fora_do_prazo` todo dia.
 *
 * `disparo: 'agendado'`, e não preguiçoso como a expiração de pedido: o
 * preguiçoso só roda quando a MESMA conversa age, e o cliente que nunca volta é
 * exatamente o que deixa o link pagável para sempre. Uma varredura a cada
 * `intervalo_minutos` põe teto no excesso: o link é pagável por, no máximo,
 * `expira_em + intervalo`.
 *
 * RESSALVA, a mesma da sonda B: tudo isto mede o que a API DIZ do objeto, não
 * dinheiro se movendo. Não há como pagar Pix de sandbox por API. O caminho
 * `fora_do_prazo` da 61 continua obrigatório para a corrida (pagamento entre a
 * janela fechar e o encerramento rodar) e para o encerramento falhar.
 *
 * NADA DISTO ESTÁ IMPLEMENTADO. É desenho: a migração (colunas + funções de
 * varredura) e o workflow agendado são a próxima entrega, e a pendência com
 * gatilho está em docs/PENDENCIA-ENCERRAMENTO-LINK.md.
 */
export function encerramentoDaPolitica(politica) {
  if (politica === null) {
    return { obrigatorio: null, motivo: 'política não decidida' };
  }
  if (politica === 'expirou_recusa') {
    return {
      obrigatorio: false,
      motivo: 'o Asaas fecha o link ao fim do dia; desativar é redundância barata',
      desativa_link: false, remove_cobrancas_pendentes: false, disparo: null, intervalo_minutos: null,
    };
  }
  if (politica === 'expirou_aceita') {
    return {
      obrigatorio: true,
      motivo: 'o Asaas nunca fecha o link; sem encerramento ele fica pagável indefinidamente',
      // PUT active=false: fecha a PÁGINA para quem ainda não gerou cobrança.
      desativa_link: true,
      // DELETE /v3/payments/{id} em cada cobrança PENDING do link (soft delete,
      // restaurável): fecha o Pix de quem já gerou. Remover o LINK não existe
      // para link com cobrança (400, medido).
      remove_cobrancas_pendentes: true,
      // Varredura agendada, não preguiçosa — ver o comentário acima.
      disparo: 'agendado',
      intervalo_minutos: 5,
    };
  }
  throw new Error(`POLITICA_EXPIRACAO invalida: ${politica}`);
}

export const ENCERRAMENTO = encerramentoDaPolitica(POLITICA_EXPIRACAO);

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
