/**
 * `Tool - Consultar Catalogo`, em código:
 *   Busca Config (`vendas`) -> Vendas Ativa? -> `api_n8n_buscar_produtos(t, termo)`.
 * O texto que volta é o que a função devolve (ela já formata para o modelo).
 */
import { fnUma } from '../db.ts';
import type { FerramentaDoModelo } from '../agente/modelo.ts';
import type { ConfigTool, ContextoTool } from './contexto.ts';

export const DESCRICAO = 'Consulta o catálogo do cliente e devolve produtos com preço, unidade e id. Use SEMPRE antes de falar preço ou oferecer item. Nunca invente valores.';
export const DICA_TERMO = 'o que o cliente procura, ex: pizza, camisa, lavagem';
export const TEXTO_VENDAS_INDISPONIVEL = 'Nao e possivel montar pedido por aqui. Ofereca ajuda pelos outros meios ou transfira para um atendente.';

export async function consultarCatalogo(ctx: ContextoTool, termo: string | null): Promise<string> {
  const cfg = await fnUma<ConfigTool>(ctx.db, 'api_n8n_config_tool', [ctx.tenant.tenant_id, 'vendas']);
  if (cfg?.tool_ativa !== true) return TEXTO_VENDAS_INDISPONIVEL;
  const r = await ctx.db.query<{ resultado: string }>('SELECT texto AS resultado FROM public.api_n8n_buscar_produtos($1::uuid, $2::text)', [ctx.tenant.tenant_id, termo]);
  return String(r.rows[0]?.resultado ?? '');
}

export function ferramentaConsultarCatalogo(ctx: ContextoTool): FerramentaDoModelo {
  return {
    nome: 'consultar_catalogo',
    descricao: DESCRICAO,
    parametros: {
      type: 'object',
      properties: { termo: { type: ['string', 'null'], description: DICA_TERMO + '; null para listar' } },
      required: ['termo'],
      additionalProperties: false,
    },
    executar: (args) => consultarCatalogo(ctx, args.termo === null || args.termo === undefined ? null : String(args.termo)),
  };
}
