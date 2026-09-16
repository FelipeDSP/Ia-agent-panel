/**
 * `Tool - Busca KB Multi-Tenant`, em código:
 *   Gera Embedding (OpenAI) -> Busca Vetorial (`api_n8n_buscar_kb`, 5, e o
 *   `vende` do tenant na mesma consulta) -> Consolida Resultado
 *   (`busca-kb-consolida.js`, o MESMO corpo do n8n).
 *
 * A description e a dica do argumento são as do nó `Busca Conhecimento` do
 * principal, verbatim — é o que o modelo lê hoje.
 */
import type { Db } from '../db.ts';
import { corpoN8n, rodarN8n } from '../n8n-js.ts';
import type { FerramentaDoModelo } from '../agente/modelo.ts';
import type { ContextoTool } from './contexto.ts';

export const DESCRICAO = 'Busca informações sobre serviços, produtos, preços, horários de funcionamento e processos da empresa. Use SEMPRE que o cliente fizer uma pergunta sobre o negócio.';
export const DICA_PERGUNTA = 'FERRAMENTA PRINCIPAL. Use esta ferramenta PRIMEIRO, sempre que o cliente perguntar QUALQUER coisa sobre o negócio: produtos, serviços, preços, horários, formas de pagamento, localização, funcionamento, políticas ou qualquer informação da empresa. É OBRIGATÓRIO buscar aqui antes de dizer que não sabe ou de transferir. Nunca responda sobre o negócio sem consultar esta ferramenta.';

interface Trecho { text: string; similarity: number; vende: boolean }

export async function buscarConhecimento(ctx: ContextoTool, pergunta: string): Promise<string> {
  if (!ctx.embeddings) return 'NENHUM_RESULTADO: a busca na base de conhecimento está indisponível agora. Diga que não consegue consultar e ofereça transferir para um atendente.';
  const vetor = await ctx.embeddings.gerar(pergunta);
  if (!Array.isArray(vetor) || vetor.length !== 1536) throw new Error(`Embedding invalido: esperado array de 1536, recebido ${vetor?.length ?? typeof vetor}`);
  const literal = '[' + vetor.join(',') + ']';
  const trechos = await buscarTrechos(ctx.db, ctx.tenant.tenant_id, literal);
  const saida = rodarN8n(corpoN8n(ctx.n8nJsDir, 'busca-kb-consolida.js'), trechos.map((t) => ({ json: t as unknown as Record<string, unknown> })));
  return String(saida.resposta ?? '');
}

/** A MESMA consulta do nó `Busca Vetorial`, com o `vende` na mesma ida. */
export async function buscarTrechos(db: Db, tenantId: string, embeddingLiteral: string): Promise<Trecho[]> {
  const r = await db.query<Trecho>(
    `SELECT k.text, k.similarity,
            exists(select 1 from public.api_n8n_tools_ativas($1::uuid) a where a.tool_nome = 'vendas') AS vende
       FROM public.api_n8n_buscar_kb($1::uuid, $2::extensions.vector, 5, '{}'::jsonb) k
      ORDER BY k.similarity DESC`, [tenantId, embeddingLiteral]);
  return r.rows;
}

export function ferramentaBuscaConhecimento(ctx: ContextoTool): FerramentaDoModelo {
  return {
    nome: 'busca_conhecimento',
    descricao: DESCRICAO,
    parametros: {
      type: 'object',
      properties: { pergunta: { type: 'string', description: DICA_PERGUNTA } },
      required: ['pergunta'],
      additionalProperties: false,
    },
    executar: (args) => buscarConhecimento(ctx, String(args.pergunta ?? '')),
  };
}
