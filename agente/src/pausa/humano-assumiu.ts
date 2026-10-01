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
import { log, erroTexto } from '../log.ts';
import type { WebhookChatwoot } from '../entrada/classificar.ts';

export interface ResultadoPausa {
  acao: 'pausou' | 'nota_interna' | 'tenant_desconhecido' | 'sem_conversa' | 'runtime_n8n';
  descartadas?: number;
  /** 01/10: se a fala do atendente entrou em `mensagens_log`. */
  registrou?: boolean;
}

/**
 * O TEXTO DO ATENDENTE, que até 01/10 era jogado fora.
 *
 * Duas coisas dependiam dele e as duas doíam:
 *
 *  - CONTINUIDADE. A pausa por humano expira (`pausa_expira_minutos`, 30 por
 *    padrão) e o agente volta a responder a mesma conversa. Medido em 30/09:
 *    em 6 das 15 transferências do CEEJAAR o agente retomou — sem nada do que
 *    o atendente tinha dito, porque a memória é `mensagens_log` e a fala dele
 *    não estava lá. O agente voltava cego, podendo contradizer a própria casa;
 *  - APRENDIZADO. É a matéria-prima do ciclo: a resposta certa, escrita por
 *    quem tem autoridade para dá-la.
 *
 * Grava como `saida` porque foi isso que o cliente viu naquele número: do lado
 * dele, agente e atendente são o mesmo contato. `fonte: 'humano'` marca a
 * origem — zero tokens, não é consumo de IA e a aba de custo não a conta.
 *
 * `execucao_id = 'humano:<id da mensagem>'` dá idempotência pelo índice
 * `uq_mensagens_log_execucao`: o Chatwoot reentrega webhook, e sem a chave a
 * mesma fala entraria duas vezes na memória.
 *
 * Nota privada NÃO chega aqui: `falaComOCliente` barra antes. O que o atendente
 * combina internamente não é fala ao cliente e não entra na memória.
 */
async function registrarFalaDoAtendente(db: Db, tenantId: string, conversationId: number, body: WebhookChatwoot): Promise<boolean> {
  const texto = typeof body.content === 'string' ? body.content.trim() : '';
  const id = Number(body['id'] ?? NaN);
  if (!texto || !Number.isFinite(id)) return false;
  try {
    await fnValor(db, 'api_n8n_registrar_mensagem', [
      tenantId, conversationId, 'saida', texto, 0, 0, null, null, `humano:${id}`,
      JSON.stringify({ fonte: 'humano', chamadas: 0 }),
    ]);
    return true;
  } catch (e) {
    // onError: continue. Perder o registro é ruim; não pausar a conversa
    // porque o registro falhou seria pior — o humano já está escrevendo.
    log('erro', 'humano.registro_falhou', { tenant: tenantId, conversa: conversationId, erro: erroTexto(e) });
    return false;
  }
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
  // ANTES de pausar e de descartar: a fala do atendente é o que a conversa
  // tem de mais valioso, e a pausa não depende dela.
  const registrou = await registrarFalaDoAtendente(db, t.tenant_id, conversationId, body);
  await fnValor(db, 'api_n8n_definir_status_conversa', [t.tenant_id, conversationId, 'pausado']);
  const descartadas = await fnValor<number>(db, 'api_agente_descartar_pendentes', [t.tenant_id, conversationId, 'humano_assumiu']);
  return { acao: 'pausou', descartadas: Number(descartadas ?? 0), registrou };
}
