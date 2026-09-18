/**
 * `Tool - Enviar Foto do Produto`, em código:
 *   Pode Enviar? (`api_n8n_enviar_foto`) -> [permitido] Assina URL (Edge
 *   Function `foto-produto`, header `x-foto-secret` — do ENV, não de parâmetro
 *   de nó: é o segredo que vazava em todo export do n8n) -> Baixa Foto ->
 *   Envia ao Chatwoot (multipart, `attachments[]` + legenda = nome do produto)
 *   -> Resposta ao Agente (`enviar-foto-resposta.js`, o MESMO corpo do n8n).
 *
 * 18/09 (Felipe): o cliente recebia DUAS mensagens — a foto com o nome do
 * produto e, logo depois, o comentário do modelo. Agora a tool só PREPARA a
 * foto (`ctx.fotoPendente`) e o turno a envia no fim, com a resposta do
 * modelo como legenda, numa mensagem só — depois do portão, como todo texto
 * que vai ao cliente. O `.js` de resposta continua sendo usado nas recusas.
 */
import { fnUma } from '../db.ts';
import { corpoN8n, rodarN8n } from '../n8n-js.ts';
import type { FerramentaDoModelo } from '../agente/modelo.ts';
import type { ContextoTool, FotoPendente } from './contexto.ts';

export const DESCRICAO = 'Envia a foto de UM produto do catalogo ao cliente, com legenda. Use so quando o cliente pedir para ver o item. Uma foto por vez.';
export const FOTO_FUNCAO_URL_PADRAO = 'https://owxnjugkvnjbjkczzasm.supabase.co/functions/v1/foto-produto';

interface PodeEnviar { permitido: boolean; motivo: string | null; produto_nome: string | null; preco_centavos: number | null; foto_path: string | null; chatwoot_url: string | null; chatwoot_token: string | null }

export const TEXTO_FOTO_PREPARADA = (nome: string) =>
  `Foto de "${nome}" vai JUNTO com a sua proxima resposta, como legenda. Escreva agora UMA frase curta sobre o item `
  + '(ex.: "Aqui esta o X, quer saber mais?") — ela e a legenda da foto. NAO diga que "enviou" a foto em outra frase, '
  + 'NAO peca outra foto e NAO chame esta ferramenta de novo nesta resposta.';

/** Envia a foto pendente com a legenda (a resposta do modelo pós-portão), numa mensagem só. */
export async function enviarFotoComLegenda(ctx: ContextoTool, foto: FotoPendente, legenda: string): Promise<{ mensagemId: number | null }> {
  const form = new FormData();
  form.append('attachments[]', new Blob([foto.bytes], { type: foto.tipo }), foto.nomeArquivo);
  form.append('content', legenda);
  form.append('message_type', 'outgoing');
  form.append('private', 'false');
  const envio = await ctx.fetchFn(`${foto.chatwootUrl.replace(/\/+$/, '')}/api/v1/accounts/${ctx.accountId}/conversations/${ctx.conversationId}/messages`, {
    method: 'POST', headers: { api_access_token: foto.chatwootToken }, body: form,
  });
  if (!envio.ok) throw new Error(`Chatwoot messages (foto) -> HTTP ${envio.status}`);
  let id: number | null = null;
  try { const j = (await envio.json()) as { id?: number }; id = typeof j.id === 'number' ? j.id : null; } catch { /* sem id */ }
  return { mensagemId: id };
}

export async function enviarFoto(ctx: ContextoTool, produtoId: string, funcaoUrl = FOTO_FUNCAO_URL_PADRAO): Promise<string> {
  if (ctx.fotoPendente) return 'Ja ha uma foto preparada para esta resposta. Uma foto por vez: escreva a legenda e siga; se o cliente quiser outra, espere ele pedir.';
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

  // 18/09: não envia aqui — o turno envia no fim, com a resposta como legenda
  ctx.fotoPendente = { bytes, tipo, nomeArquivo, produtoNome: p.produto_nome ?? '', chatwootUrl: p.chatwoot_url ?? '', chatwootToken: p.chatwoot_token ?? '' };
  return TEXTO_FOTO_PREPARADA(p.produto_nome ?? '');
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
    executar: async (args) => {
      const texto = await enviarFoto(ctx, String(args.produto_id ?? ''));
      return { texto, diagnostico: { preparada: ctx.fotoPendente !== null && ctx.fotoPendente !== undefined } };
    },
  };
}
