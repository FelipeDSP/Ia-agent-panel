/**
 * `Tool - Enviar Foto do Produto`, em código:
 *   Pode Enviar? (`api_n8n_enviar_foto`) -> [permitido] Assina URL (Edge
 *   Function `foto-produto`, header `x-foto-secret` — do ENV, não de parâmetro
 *   de nó: é o segredo que vazava em todo export do n8n) -> Baixa Foto ->
 *   Envia ao Chatwoot (multipart, `attachments[]` + legenda = nome do produto)
 *   -> Resposta ao Agente (`enviar-foto-resposta.js`, o MESMO corpo do n8n).
 */
import { fnUma } from '../db.ts';
import { corpoN8n, rodarN8n } from '../n8n-js.ts';
import type { FerramentaDoModelo } from '../agente/modelo.ts';
import type { ContextoTool } from './contexto.ts';

export const DESCRICAO = 'Envia a foto de UM produto do catalogo ao cliente, com legenda. Use so quando o cliente pedir para ver o item. Uma foto por vez.';
export const FOTO_FUNCAO_URL_PADRAO = 'https://owxnjugkvnjbjkczzasm.supabase.co/functions/v1/foto-produto';

interface PodeEnviar { permitido: boolean; motivo: string | null; produto_nome: string | null; preco_centavos: number | null; foto_path: string | null; chatwoot_url: string | null; chatwoot_token: string | null }

export async function enviarFoto(ctx: ContextoTool, produtoId: string, funcaoUrl = FOTO_FUNCAO_URL_PADRAO): Promise<string> {
  const respostaAoAgente = (v: Record<string, unknown>) => String(rodarN8n(corpoN8n(ctx.n8nJsDir, 'enviar-foto-resposta.js'), { json: v }).resultado ?? '');

  let p: PodeEnviar | undefined;
  try {
    p = await fnUma<PodeEnviar>(ctx.db, 'api_n8n_enviar_foto', [ctx.tenant.tenant_id, ctx.conversationId, produtoId]);
  } catch (e) {
    // uuid inválido vindo do modelo (22P02) é "produto inválido", não falha do serviço.
    if ((e as { code?: string }).code === '22P02') return respostaAoAgente({ enviada: false, motivo: 'produto_invalido' });
    throw e;
  }
  if (!p || p.permitido !== true) return respostaAoAgente({ enviada: false, motivo: p?.motivo ?? null });
  if (!ctx.fotoSecret) return respostaAoAgente({ enviada: false, motivo: 'sem_segredo_de_foto' });

  const assinada = await ctx.fetchFn(funcaoUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-foto-secret': ctx.fotoSecret },
    body: JSON.stringify({ tenant_id: ctx.tenant.tenant_id, foto_path: p.foto_path }),
  });
  if (!assinada.ok) throw new Error(`foto-produto (assinar) -> HTTP ${assinada.status}`);
  const { url } = (await assinada.json()) as { url?: string };
  if (!url) throw new Error('foto-produto não devolveu url');

  const foto = await ctx.fetchFn(url);
  if (!foto.ok) throw new Error(`baixar foto -> HTTP ${foto.status}`);
  const bytes = new Uint8Array(await foto.arrayBuffer());
  const tipo = foto.headers.get('content-type') || 'image/jpeg';
  const nomeArquivo = (p.foto_path ?? 'foto.jpg').split('/').pop() || 'foto.jpg';

  const form = new FormData();
  form.append('attachments[]', new Blob([bytes], { type: tipo }), nomeArquivo);
  form.append('content', p.produto_nome ?? '');
  form.append('message_type', 'outgoing');
  form.append('private', 'false');
  const envio = await ctx.fetchFn(`${(p.chatwoot_url ?? '').replace(/\/+$/, '')}/api/v1/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/messages`, {
    method: 'POST', headers: { api_access_token: p.chatwoot_token ?? '' }, body: form,
  });
  if (!envio.ok) throw new Error(`Chatwoot messages (foto) -> HTTP ${envio.status}`);
  return respostaAoAgente({ enviada: true, produto_nome: p.produto_nome });
}

export function ferramentaEnviarFoto(ctx: ContextoTool): FerramentaDoModelo {
  return {
    nome: 'enviar_foto_produto',
    descricao: DESCRICAO,
    parametros: {
      type: 'object',
      properties: { produto_id: { type: 'string', description: 'id do produto vindo de consultar_catalogo' } },
      required: ['produto_id'],
      additionalProperties: false,
    },
    executar: (args) => enviarFoto(ctx, String(args.produto_id ?? '')),
  };
}
