/**
 * `Tool - Resolver Conversa`, em código:
 *   Busca Config (`api_n8n_config_tool(t,'resolver_conversa')`) -> Tool Ativa?
 *   -> Tem Pedido Pendente (`api_n8n_tem_pedido_pendente`) -> [sim] "Pedido em
 *   Aberto" -> [não] Resolve no Chatwoot (toggle_status resolved) -> sucesso.
 * Textos verbatim do sub-workflow.
 */
import { fnUma, fnValor } from '../db.ts';
import type { FerramentaDoModelo } from '../agente/modelo.ts';
import type { ConfigTool, ContextoTool } from './contexto.ts';

export const DESCRICAO = 'Use quando o cliente se despedir, agradecer e encerrar, ou quando a conversa claramente chegou ao fim SEM nenhuma pergunta pendente. Envie a mensagem de despedida ANTES de finalizar. Nunca finalize no meio de um atendimento em andamento.';
export const TEXTO_INDISPONIVEL = 'Nao foi possivel encerrar por aqui. Despeca-se do cliente normalmente.';
export const TEXTO_PEDIDO_ABERTO = 'Ha um pedido em aberto nesta conversa. Confirme com o cliente se ele quer fechar ou cancelar o pedido ANTES de encerrar o atendimento.';
export const TEXTO_RESOLVIDA = 'Conversa finalizada e marcada como resolvida. Despeca-se do cliente de forma cordial.';

export async function resolverConversa(ctx: ContextoTool): Promise<string> {
  const cfg = await fnUma<ConfigTool>(ctx.db, 'api_n8n_config_tool', [ctx.tenant.tenant_id, 'resolver_conversa']);
  if (cfg?.tool_ativa !== true) return TEXTO_INDISPONIVEL;
  const pendente = await fnValor<boolean>(ctx.db, 'api_n8n_tem_pedido_pendente', [ctx.tenant.tenant_id, ctx.conversationId]);
  if (pendente === true) return TEXTO_PEDIDO_ABERTO;
  if (!cfg.chatwoot_url || !cfg.chatwoot_token) throw new Error('tenant sem credencial de Chatwoot');
  const url = `${cfg.chatwoot_url.replace(/\/+$/, '')}/api/v1/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/toggle_status`;
  const r = await ctx.fetchFn(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', api_access_token: cfg.chatwoot_token },
    body: JSON.stringify({ status: 'resolved' }),
  });
  if (!r.ok) throw new Error(`Chatwoot toggle_status -> HTTP ${r.status}`);
  return TEXTO_RESOLVIDA;
}

export function ferramentaResolverConversa(ctx: ContextoTool): FerramentaDoModelo {
  return {
    nome: 'resolver_conversa',
    descricao: DESCRICAO,
    parametros: { type: 'object', properties: {}, required: [], additionalProperties: false },
    executar: () => resolverConversa(ctx),
  };
}
