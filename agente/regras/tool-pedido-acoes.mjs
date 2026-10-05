/**
 * AS CINCO AÇÕES DA FERRAMENTA DE PEDIDO — A ÚNICA FONTE.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTE ARQUIVO EXISTE
 *
 * A ferramenta fundida tem a lista de ações escrita em TRÊS lugares que o
 * modelo e o n8n leem:
 *
 *   1. o switch `Qual Acao?` do sub-workflow (decide para onde vai);
 *   2. a `description` do nó `Gerenciar Pedido` no principal (decide se o
 *      modelo CHAMA, e com qual `acao`);
 *   3. a seção `## Ferramenta: gerenciar_pedido` do system message (decide como
 *      o modelo USA).
 *
 * Três lugares, um texto — e a família fonte↔derivado mordeu quatro vezes nesta
 * semana. Então os três são DERIVADOS daqui: `scripts/gerar-tool-pedido.mjs`
 * monta o switch, `scripts/gerar-principal.mjs` escreve a description e a seção
 * do prompt, e `tests/tool-pedido-fundida.mjs` executa as queries daqui contra
 * o banco. Nenhum deles tem a lista escrita à mão.
 *
 * ---------------------------------------------------------------------------
 * O QUE ESTA FUSÃO É, E O QUE NÃO É
 *
 * Ela junta caminhos; não afrouxa regra nenhuma. `fechar` continua travando
 * alteração depois de fechado, `cancelar` continua perdendo o carrinho, e os
 * dois continuam chamando exatamente a mesma função do banco que chamavam
 * quando eram ferramentas separadas — as queries abaixo são as dos três
 * sub-workflows originais, verbatim.
 *
 * `cancelar` NÃO ganhou o parâmetro `alvo` que a migração 55 criou na função.
 * A ferramenta separada não o passava, e fundir não é o momento de estender:
 * seria mudança de comportamento dentro de um experimento cuja premissa é
 * "mesmo agente, mesmo prompt, três ferramentas a menos".
 *
 * ---------------------------------------------------------------------------
 * A `description` É CAMPO ÓRFÃO NO PRINCIPAL — ATÉ AGORA
 *
 * `docs/PENDENCIA-GERADOR-CAMPO-ORFAO.md`: o gerador não escrevia a description
 * de 7 das 8 ferramentas e nenhum validador a olhava. Para ESTA ferramenta isso
 * deixa de valer — `gerar-principal.mjs` passa a escrevê-la a partir daqui. As
 * outras seis continuam órfãs; a pendência continua aberta para elas.
 */

/** A linha de `catalogo_tools` que cobre as cinco ações. Uma só. */
export const TOOL_NOME = 'vendas';

/** Nome do nó no principal e do sub-workflow na instância. Não muda na fusão. */
export const NO_PRINCIPAL = 'Gerenciar Pedido';
export const NOME_WORKFLOW = 'Tool - Gerenciar Pedido (Multi-Tenant)';
export const ID_WORKFLOW = '5rMg40Lagy3OaIo7';

/**
 * Entradas do sub-workflow: a UNIÃO das três ferramentas originais. Ordem
 * importa só para o schema; o que cada ação usa está em `params`.
 */
export const ENTRADAS = [
  { name: 'tenant_id' },
  { name: 'conversation_id', type: 'number' },
  { name: 'acao' },
  { name: 'produto_id' },
  { name: 'quantidade', type: 'number' },
  { name: 'observacao' },
  { name: 'metadados' },
];

/**
 * Cada ação: o nó Postgres que a executa, a query (verbatim do sub-workflow
 * original), os parâmetros na ordem de `$1..$n`, e os dois textos derivados.
 *
 * `descricao` é a frase que entra na `description` da tool (o que o MODELO lê
 * para decidir chamar). `prompt` é o item da seção do system message.
 */
export const ACOES = [
  {
    acao: 'adicionar',
    no: 'Adiciona Item',
    funcao: 'api_n8n_adicionar_item',
    query:
      "SELECT public.api_n8n_adicionar_item($1::uuid, $2::bigint,\n"
      + "       nullif(btrim($3::text), '')::uuid,\n"
      + "       coalesce(nullif(btrim($4::text), '')::int, 1),\n"
      + "       nullif(btrim($5::text), '')) AS resultado;",
    params: ['tenant_id', 'conversation_id', 'produto_id', 'quantidade', 'observacao'],
    descricao: 'acao=adicionar (produto_id, quantidade, observacao)',
    prompt:
      '- `adicionar`: informe produto_id (vindo de consultar_catalogo), quantidade e, se houver, '
      + 'observação do cliente ("sem cebola", "bem passado").',
  },
  {
    acao: 'remover',
    no: 'Remove Item',
    funcao: 'api_n8n_remover_item',
    query: "SELECT public.api_n8n_remover_item($1::uuid, $2::bigint, nullif(btrim($3::text), '')::uuid) AS resultado;",
    params: ['tenant_id', 'conversation_id', 'produto_id'],
    descricao: 'acao=remover (produto_id)',
    prompt: '- `remover`: informe o produto_id do item a tirar.',
  },
  {
    acao: 'ver',
    no: 'Ve Pedido',
    funcao: 'api_n8n_ver_pedido',
    query: 'SELECT public.api_n8n_ver_pedido($1::uuid, $2::bigint) AS resultado;',
    params: ['tenant_id', 'conversation_id'],
    descricao: 'acao=ver (so consulta, nao altera)',
    prompt: '- `ver`: mostra o pedido atual sem alterar nada.',
  },
  {
    acao: 'fechar',
    no: 'Fecha Pedido',
    funcao: 'api_n8n_fechar_pedido',
    query: 'SELECT public.api_n8n_fechar_pedido($1::uuid, $2::bigint, $3::text) AS resultado;',
    params: ['tenant_id', 'conversation_id', 'metadados'],
    // As travas ficam no TEXTO da ferramenta, como estavam na separada: são
    // elas que o modelo lê.
    descricao:
      'acao=fechar (metadados: json com entrega/retirada/observacao geral, vazio se nao houver) — '
      + 'SO quando o cliente confirmar que quer fechar ("pode fechar", "sim", "so isso", ou dizendo '
      + 'retirada/entrega); depois de fechado nao aceita alteracao',
    prompt:
      '- `fechar`: SEMPRE que o cliente confirmar que quer fechar — "pode fechar", "sim", "só isso", '
      + '"retirada", "entrega" —, chame com esta ação ANTES de responder. Para repetir os itens e o '
      + 'total antes de ele confirmar, use `ver`; se ele só perguntou o valor, também é `ver`. '
      + 'Depois de fechado o pedido NÃO aceita mais alteração. Só esta ação fecha: dizer que o '
      + 'pedido está fechado, confirmado ou finalizado sem o retorno dela é erro.',
    // Só esta ação carrega a notificação ao dono (WAHA). O gerador sabe disso
    // por esta flag, não por nome de nó.
    notificaVenda: true,
  },
  {
    acao: 'cancelar',
    no: 'Cancela Pedido',
    funcao: 'api_n8n_cancelar_pedido',
    query: 'SELECT public.api_n8n_cancelar_pedido($1::uuid, $2::bigint) AS resultado;',
    params: ['tenant_id', 'conversation_id'],
    descricao:
      'acao=cancelar — SO quando o cliente desistir ou mandar recomecar E ja tiver confirmado que '
      + 'pode perder o carrinho (pergunte antes, o carrinho nao volta); comprar mais depois de um '
      + 'pedido fechado e pedido NOVO, nao cancele o anterior',
    prompt:
      '- `cancelar`: use quando o cliente desistir do pedido ou pedir para recomeçar. Cancela o '
      + 'carrinho em aberto. Confirme com o cliente antes — o carrinho é perdido. Se ele quer '
      + 'COMPRAR MAIS depois de um pedido fechado, isso é pedido novo: NÃO cancele o anterior. '
      + 'Só esta ação cancela: dizer que cancelou sem o retorno dela é erro.',
  },
];

export const NOMES_ACOES = ACOES.map((a) => a.acao);

/** "adicionar, remover, ver, fechar ou cancelar" */
export function listaFalada() {
  const n = NOMES_ACOES;
  return `${n.slice(0, -1).join(', ')} ou ${n[n.length - 1]}`;
}

/**
 * A `description` do nó `Gerenciar Pedido` no principal. É o texto que o modelo
 * lê para decidir SE chama e COM QUAL `acao`. Derivada, e portanto verificável:
 * o teste compara o que está no JSON com o que esta função devolve.
 */
export function descricaoFerramenta() {
  return (
    'Monta, le, fecha e cancela o pedido do cliente. '
    + ACOES.map((a) => a.descricao).join('; ')
    + '. Devolve SEMPRE o pedido inteiro com o total ja calculado. Use SEMPRE, ANTES de responder, '
    + 'que o cliente disser o que quer, mudar quantidade, mandar tirar item, confirmar que quer fechar '
    + 'ou desistir — e use acao=ver ANTES de repetir o pedido para ele. O texto do pedido e o que ESTA '
    + 'ferramenta devolveu: nunca descreva itens nem total de memoria, e nunca diga que fechou ou '
    + 'cancelou sem o retorno dela.'
  );
}

/** A seção `## Ferramenta: gerenciar_pedido` do system message. */
export function secaoPrompt() {
  return (
    '## Ferramenta: gerenciar_pedido\n'
    + 'Monta, fecha e cancela o pedido junto com o cliente. Ações:\n'
    + ACOES.map((a) => a.prompt).join('\n')
    + '\n'
    + 'A ferramenta SEMPRE devolve o pedido inteiro com o total. Repita ao cliente O RESUMO QUE ELA '
    + 'ACABOU DE DEVOLVER. Se você não chamou a ferramenta neste turno, chame com `acao=ver` antes '
    + 'de repetir — nunca monte o resumo de memória. O total vem calculado — nunca some você mesmo.\n'
  );
}

/** O texto do ramo `Acao Invalida`. */
export function textoAcaoInvalida() {
  return `Acao invalida. Use ${listaFalada()}.`;
}

/** O `$fromAI` do parâmetro `acao` no principal. */
export function dicaFromAI() {
  return listaFalada();
}
