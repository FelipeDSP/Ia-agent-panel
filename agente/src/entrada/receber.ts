/**
 * O que acontece com UM webhook do Chatwoot — o caminho do n8n até o
 * `Acumula Mensagem`, em ordem:
 *
 *   classificar -> [humano] humanoAssumiu (pausa + descarta pendentes)
 *               -> [cliente] extrair -> resolverTenant (+ runtime) -> portaoEntrada
 *                            -> [processar|midia|bloqueado] enfileirar
 *                            -> [ignorar] nada
 *
 * Responde ao Chatwoot em qualquer caso (o HTTP faz isso, fora daqui). Tudo
 * que NÃO enfileira volta com um `motivo`, e o receptor loga o motivo — é a
 * única visibilidade de "por que o agente não respondeu" antes de existir um
 * turno no trace.
 *
 * A caixa da URL tem de ser a caixa do corpo: um webhook apontado para
 * `/chatwoot/<token>/282` com `conversation.inbox_id = 279` é configuração
 * errada ou forja, e nos dois casos a resposta certa é não atender.
 */
import type { Db } from '../db.ts';
import type { Waha } from '../waha/notificar.ts';
import { classificar, type WebhookChatwoot } from './classificar.ts';
import { extrair, type Extraido } from './extrair.ts';
import { resolverTenant } from '../tenant/resolver.ts';
import { portaoEntrada } from '../pausa/portao-entrada.ts';
import { humanoAssumiu } from '../pausa/humano-assumiu.ts';
import { fnValor } from '../db.ts';

export interface Recebido {
  evento: 'cliente' | 'humano' | 'descartar';
  resultado: 'enfileirada' | 'ignorada' | 'pausada_na_entrada' | 'pausou' | 'nota_interna' | 'caixa_divergente' | 'tenant' | 'descartada';
  motivo?: string;
  filaId?: string;
  descartadas?: number;
  tenantSlug?: string;
  extraido?: Extraido;
}

export interface Deps { db: Db; waha: Waha | null; n8nJsDir: string }

export async function receber(deps: Deps, inboxDaUrl: number, body: WebhookChatwoot): Promise<Recebido> {
  const evento = classificar(body);
  if (evento === 'descartar') return { evento, resultado: 'descartada', motivo: 'evento_nao_roteado' };

  if (evento === 'humano') {
    const r = await humanoAssumiu(deps.db, body as Parameters<typeof humanoAssumiu>[1]);
    return { evento, resultado: r.acao === 'pausou' ? 'pausou' : r.acao === 'nota_interna' ? 'nota_interna' : 'tenant', motivo: r.acao, ...(r.descartadas ? { descartadas: r.descartadas } : {}) };
  }

  const ex = extrair(deps.n8nJsDir, body);
  if (ex.chatwoot_inbox_id !== inboxDaUrl) {
    return { evento, resultado: 'caixa_divergente', motivo: `url=${inboxDaUrl} corpo=${ex.chatwoot_inbox_id}`, extraido: ex };
  }
  const res = await resolverTenant(deps.db, ex.chatwoot_account_id, ex.chatwoot_inbox_id);
  if (!res.ok) return { evento, resultado: 'tenant', motivo: res.motivo, tenantSlug: res.tenant?.slug, extraido: ex };
  const { tenant } = res;

  if (ex.acao === 'ignorar') return { evento, resultado: 'ignorada', motivo: ex.motivo, tenantSlug: tenant.slug, extraido: ex };
  if (ex.conversation_id === null) return { evento, resultado: 'ignorada', motivo: 'sem_conversation_id', tenantSlug: tenant.slug, extraido: ex };

  const portao = await portaoEntrada(deps.db, deps.waha, tenant.tenant_id, ex.conversation_id);
  if (!portao.segue) {
    return { evento, resultado: 'pausada_na_entrada', motivo: `${portao.portao.motivo ?? 'pausada'}${portao.avisoWaha ? `/waha:${portao.avisoWaha}` : ''}`, tenantSlug: tenant.slug, extraido: ex };
  }

  // O que vai para a fila é o que o turno precisa e NADA mais. Nome e telefone
  // entram porque o `Sync Conversa` do turno os grava em `conversas` (como o
  // n8n faz); a fila tem RLS por tenant, e `conversas` já guarda os dois.
  // O corpo bruto do webhook NÃO entra.
  const mensagem = {
    acao: ex.acao, mensagem: ex.mensagem ?? null, anexo: ex.anexo ?? null,
    contact_name: ex.contact_name, phone: ex.phone,
    chatwoot_account_id: ex.chatwoot_account_id, chatwoot_inbox_id: ex.chatwoot_inbox_id,
    message_id: (body as { id?: number }).id ?? null,
  };
  const filaId = await fnValor<string>(deps.db, 'api_agente_enfileirar', [tenant.tenant_id, ex.conversation_id, JSON.stringify(mensagem), tenant.debounce_segundos]);
  return { evento, resultado: 'enfileirada', filaId, tenantSlug: tenant.slug, extraido: ex };
}
