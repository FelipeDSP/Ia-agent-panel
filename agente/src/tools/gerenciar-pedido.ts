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
import { fnUma, fnValor } from '../db.ts';
import { ACOES, TOOL_NOME, descricaoFerramenta, dicaFromAI, textoAcaoInvalida } from '../../../n8n/tool-pedido-acoes.mjs';
import type { FerramentaDoModelo } from '../agente/modelo.ts';
import type { ConfigTool, ContextoTool } from './contexto.ts';
import { TEXTO_VENDAS_INDISPONIVEL } from './consultar-catalogo.ts';

export interface ArgsPedido { acao: string; produto_id: string | null; quantidade: number | null; observacao: string | null; metadados: string | null }

export async function gerenciarPedido(ctx: ContextoTool, a: ArgsPedido): Promise<{ resultado: string; acao: string; notificacao?: 'enviada' | 'falhou' | 'sem_destino' | 'sem_waha' }> {
  const cfg = await fnUma<ConfigTool>(ctx.db, 'api_n8n_config_tool', [ctx.tenant.tenant_id, TOOL_NOME]);
  if (cfg?.tool_ativa !== true) return { resultado: TEXTO_VENDAS_INDISPONIVEL, acao: a.acao };

  const acao = ACOES.find((x) => x.acao === String(a.acao ?? '').trim().toLowerCase());
  if (!acao) return { resultado: textoAcaoInvalida(), acao: a.acao };

  const valores: Record<string, unknown> = {
    tenant_id: ctx.tenant.tenant_id, conversation_id: ctx.conversationId,
    produto_id: a.produto_id ?? null, quantidade: a.quantidade ?? null,
    observacao: a.observacao ?? null, metadados: a.metadados ?? null,
  };
  const params = acao.params.map((p) => valores[p] === undefined ? null : valores[p]);
  const r = await ctx.db.query<{ resultado: string }>(acao.query, params);
  const resultado = String(r.rows[0]?.resultado ?? '');

  if (!acao.notificaVenda) return { resultado, acao: acao.acao };

  // A notificação de venda ao dono, com os três `onError: continue` do n8n.
  let notificacao: 'enviada' | 'falhou' | 'sem_destino' | 'sem_waha' = 'sem_destino';
  try {
    const n = await fnUma<{ pedido_id: string | null; numero: number | null; sessao: string | null; destino: string | null; mensagem: string | null }>(
      ctx.db, 'api_n8n_notificar_venda', [ctx.tenant.tenant_id, ctx.conversationId]);
    if (n?.destino && n.pedido_id) {
      if (!ctx.waha) {
        notificacao = 'sem_waha';
        await fnValor(ctx.db, 'api_n8n_confirmar_notificacao', [ctx.tenant.tenant_id, n.pedido_id, false, 'WAHA nao configurado no agente']);
      } else {
        let erro: string | null = null;
        try { await ctx.waha.enviarTexto(n.sessao ?? '', n.destino, n.mensagem ?? ''); } catch (e) { erro = e instanceof Error ? e.message : String(e); }
        notificacao = erro ? 'falhou' : 'enviada';
        await fnValor(ctx.db, 'api_n8n_confirmar_notificacao', [ctx.tenant.tenant_id, n.pedido_id, !erro, erro ? erro.slice(0, 500) : null]);
      }
    }
  } catch {
    notificacao = 'falhou';
  }
  return { resultado, acao: acao.acao, notificacao };
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
        metadados: { type: ['string', 'null'], description: 'json com entrega/retirada/observacao geral, ex: {"entrega":"retirada"}; null se nao houver' },
      },
      required: ['acao', 'produto_id', 'quantidade', 'observacao', 'metadados'],
      additionalProperties: false,
    },
    executar: async (args) => (await gerenciarPedido(ctx, {
      acao: String(args.acao ?? ''),
      produto_id: args.produto_id == null ? null : String(args.produto_id),
      quantidade: args.quantidade == null ? null : Number(args.quantidade),
      observacao: args.observacao == null ? null : String(args.observacao),
      metadados: args.metadados == null ? null : String(args.metadados),
    })).resultado,
  };
}
