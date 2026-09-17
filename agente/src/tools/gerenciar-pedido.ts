/**
 * `Tool - Gerenciar Pedido` (as 5 ações), em código — e a FONTE continua sendo
 * `n8n/tool-pedido-acoes.mjs`: as queries (verbatim dos sub-workflows
 * originais), a `description` e o texto de ação inválida saem de lá. Este
 * arquivo só executa.
 *
 *   Busca Config (`vendas`) -> Vendas Ativa? -> Qual Acao? -> a query da ação
 *   -> [fechar] Reivindica Notificacao (`api_n8n_notificar_venda`) ->
 *      [tem destino] Notifica Venda WAHA -> Confirma Notificacao
 *      (os três com onError: continue — notificação nunca derruba o fechamento)
 *
 * Os parâmetros da query são passados NA ORDEM de `params`, e `$n` casa por
 * posição — o mesmo contrato do `queryReplacement`.
 */
import { fnUma } from '../db.ts';
import { ACOES, TOOL_NOME, descricaoFerramenta, dicaFromAI, textoAcaoInvalida } from '../../../n8n/tool-pedido-acoes.mjs';
import type { FerramentaDoModelo } from '../agente/modelo.ts';
import type { ConfigTool, ContextoTool } from './contexto.ts';
import { TEXTO_VENDAS_INDISPONIVEL } from './consultar-catalogo.ts';
import { avisarDono, avisarVendaFechada, type ResultadoAviso } from '../pedido/aviso.ts';
import { lerOferta } from '../pedido/oferta.ts';

export interface ArgsPedido { acao: string; produto_id: string | null; quantidade: number | null; observacao: string | null; metadados: string | null; pagamento?: string | null }

/**
 * `pagamento` (69) entra no jsonb que `api_n8n_fechar_pedido` já recebia — a
 * assinatura da função é a mesma que o n8n congelado chama; a chave nova é o
 * que ela passou a ler. Metadados que não são JSON-objeto viram `observacao`,
 * como a função faria sozinha.
 */
export function metadadosComPagamento(metadados: string | null, pagamento: string | null | undefined): string | null {
  const pg = String(pagamento ?? '').trim().toLowerCase();
  if (!pg) return metadados;
  let base: Record<string, unknown> = {};
  const bruto = String(metadados ?? '').trim();
  if (bruto) {
    try { const j: unknown = JSON.parse(bruto); base = j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : { observacao: bruto }; }
    catch { base = { observacao: bruto }; }
  }
  return JSON.stringify({ ...base, pagamento: pg });
}

export async function gerenciarPedido(ctx: ContextoTool, a: ArgsPedido): Promise<{ resultado: string; acao: string; notificacao?: ResultadoAviso }> {
  const cfg = await fnUma<ConfigTool>(ctx.db, 'api_n8n_config_tool', [ctx.tenant.tenant_id, TOOL_NOME]);
  if (cfg?.tool_ativa !== true) return { resultado: TEXTO_VENDAS_INDISPONIVEL, acao: a.acao };

  const acao = ACOES.find((x) => x.acao === String(a.acao ?? '').trim().toLowerCase());
  if (!acao) return { resultado: textoAcaoInvalida(), acao: a.acao };

  const valores: Record<string, unknown> = {
    tenant_id: ctx.tenant.tenant_id, conversation_id: ctx.conversationId,
    produto_id: a.produto_id ?? null, quantidade: a.quantidade ?? null,
    observacao: a.observacao ?? null, metadados: metadadosComPagamento(a.metadados ?? null, a.pagamento),
  };
  const params = acao.params.map((p) => valores[p] === undefined ? null : valores[p]);
  const r = await ctx.db.query<{ resultado: string }>(acao.query, params);
  const resultado = String(r.rows[0]?.resultado ?? '');

  const deps = { db: ctx.db, chatwoot: ctx.chatwoot, waha: ctx.waha };
  // A notificação de venda ao dono, com os três `onError: continue` do n8n —
  // e a nota privada (69) quando a conta pediu.
  if (acao.notificaVenda) {
    const notificacao = await avisarVendaFechada(deps, { tenantId: ctx.tenant.tenant_id, conversationId: ctx.conversationId, nota: lerOferta(cfg.config).notaChatwoot });
    return { resultado, acao: acao.acao, notificacao };
  }
  // 69: cancelar uma venda já FECHADA ("Pedido nº N (...) cancelado.") avisa o
  // dono; descartar carrinho não é evento de ninguém.
  if (acao.acao === 'cancelar' && /^Pedido nº \d+ .*cancelado\./.test(resultado)) {
    const notificacao = await avisarDono(deps, { tenantId: ctx.tenant.tenant_id, conversationId: ctx.conversationId, evento: 'pedido_cancelado' });
    return { resultado, acao: acao.acao, notificacao };
  }
  return { resultado, acao: acao.acao };
}

export function ferramentaGerenciarPedido(ctx: ContextoTool): FerramentaDoModelo {
  return {
    nome: 'gerenciar_pedido',
    descricao: descricaoFerramenta(),
    parametros: {
      type: 'object',
      properties: {
        acao: { type: 'string', enum: ACOES.map((a) => a.acao), description: dicaFromAI() },
        produto_id: { type: ['string', 'null'], description: 'id do produto vindo de consultar_catalogo; null quando acao=ver, fechar ou cancelar' },
        quantidade: { type: ['integer', 'null'], description: 'quantas unidades; 1 se o cliente nao disser; null fora de adicionar' },
        observacao: { type: ['string', 'null'], description: 'observacao do cliente sobre o item, ex: sem cebola. null se nao houver' },
        metadados: { type: ['string', 'null'], description: 'json com observacao geral do pedido, ex: {"observacao":"retirar as 7h"}; null se nao houver' },
        pagamento: { type: ['string', 'null'], enum: ['link', 'na_retirada', null], description: 'so em acao=fechar: como o cliente vai pagar — "link" (Pix/cartao agora) ou "na_retirada" (paga quando buscar). Se a loja oferece os dois, pergunte antes. null fora de fechar' },
      },
      required: ['acao', 'produto_id', 'quantidade', 'observacao', 'metadados', 'pagamento'],
      additionalProperties: false,
    },
    executar: async (args) => {
      const r = await gerenciarPedido(ctx, {
        acao: String(args.acao ?? ''),
        produto_id: args.produto_id == null ? null : String(args.produto_id),
        quantidade: args.quantidade == null ? null : Number(args.quantidade),
        observacao: args.observacao == null ? null : String(args.observacao),
        metadados: args.metadados == null ? null : String(args.metadados),
        pagamento: args.pagamento == null ? null : String(args.pagamento),
      });
      return { texto: r.resultado, diagnostico: { acao: r.acao, ...(r.notificacao ? { notificacao: r.notificacao } : {}) } };
    },
  };
}
