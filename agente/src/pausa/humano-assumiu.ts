/**
 * O ramo `humano` do `Roteia Evento`: um atendente escreveu na conversa.
 *
 *   Fala com o Cliente?  private == false  OU  content contém "Enviado do
 *                        WhatsApp"/"Enviado do Instagram" — senão é nota
 *                        interna e NADA acontece;
 *   Resolve Tenant (pausa)  só exige tenant_id (não olha agente_ativo);
 *   Pausa Conversa       api_n8n_conversa_sync + api_n8n_definir_status_conversa('pausado')
 *   Limpa Redis Debounce (DEL do acúmulo)  -> aqui: DESCARTA as mensagens
 *                        pendentes desta conversa na fila. É a divergência
 *                        esperada do modelo (`tests/lib/debounce-modelo.mjs`):
 *                        no n8n a execução pendente morre em "corrida"; aqui
 *                        ela vira `descartada`, em silêncio, que é o que se
 *                        quer quando um humano assumiu.
 */
import { fnUma, fnValor, type Db } from '../db.ts';
import type { WebhookChatwoot } from '../entrada/classificar.ts';

export interface ResultadoPausa {
  acao: 'pausou' | 'nota_interna' | 'tenant_desconhecido' | 'sem_conversa' | 'runtime_n8n';
  descartadas?: number;
}

export function falaComOCliente(body: WebhookChatwoot): boolean {
  const content = typeof body.content === 'string' ? body.content : '';
  return body.private === false || content.includes('Enviado do WhatsApp') || content.includes('Enviado do Instagram');
}

export async function humanoAssumiu(db: Db, body: WebhookChatwoot & { conversation?: { id?: number; inbox_id?: number; meta?: { sender?: { name?: string } } }; account?: { id?: number }; inbox?: { id?: number } }): Promise<ResultadoPausa> {
  if (!falaComOCliente(body)) return { acao: 'nota_interna' };
  const conversationId = body.conversation?.id ?? null;
  const accountId = body.account?.id ?? null;
  const inboxId = body.conversation?.inbox_id ?? body.inbox?.id ?? null;
  if (conversationId === null || inboxId === null) return { acao: 'sem_conversa' };

  const t = await fnUma<{ tenant_id: string }>(db, 'api_n8n_tenant_por_chatwoot', [accountId, inboxId]);
  if (!t?.tenant_id) return { acao: 'tenant_desconhecido' };
  // O mesmo portão de runtime do caminho do cliente: tenant em 'n8n' não é
  // nosso — nem para pausar. Bot mal apontado não pode mexer no que o n8n cuida.
  if ((await fnValor<string | null>(db, 'api_agente_runtime', [t.tenant_id])) !== 'codigo') return { acao: 'runtime_n8n' };

  const nome = body.conversation?.meta?.sender?.name ?? 'Cliente';
  await fnUma(db, 'api_n8n_conversa_sync', [t.tenant_id, conversationId, nome, null]);
  await fnValor(db, 'api_n8n_definir_status_conversa', [t.tenant_id, conversationId, 'pausado']);
  const descartadas = await fnValor<number>(db, 'api_agente_descartar_pendentes', [t.tenant_id, conversationId, 'humano_assumiu']);
  return { acao: 'pausou', descartadas: Number(descartadas ?? 0) };
}
