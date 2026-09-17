/**
 * Aviso ao DONO sobre um pedido (migração 69) — pelos dois canais que a conta
 * escolheu em Configurações → Vendas: WhatsApp (WAHA, sessão da agência +
 * número do cliente) e/ou nota privada na conversa do Chatwoot.
 *
 * Quem decide SE avisa e monta o texto é o banco (`api_n8n_notificar_venda`
 * para a venda fechada; `api_agente_aviso_pedido` para os outros eventos), com
 * claim idempotente por evento. Aqui só se entrega e se confirma — e nunca se
 * derruba o que veio antes: a venda fechou, o pagamento caiu, o cancelamento
 * valeu, com ou sem aviso.
 */
import { fnUma, fnValor, type Db } from '../db.ts';
import type { Chatwoot } from '../chatwoot/enviar.ts';
import type { Waha } from '../waha/notificar.ts';
import { log, erroTexto } from '../log.ts';

export type Evento = 'pedido_fechado' | 'pagamento_confirmado' | 'pedido_cancelado';
export type ResultadoAviso = 'enviado' | 'falhou' | 'sem_destino' | 'sem_waha';

export interface DepsAviso { db: Db; chatwoot: Chatwoot; waha: Waha | null }

interface LinhaAviso {
  pedido_id: string | null; numero: number | null; sessao: string | null; destino: string | null;
  nota_chatwoot?: boolean | null; mensagem: string | null;
}

/**
 * Entrega o que o banco reivindicou e confirma. `nota` vem do banco para os
 * eventos novos e, para a venda fechada, do `config` que a tool já leu.
 */
async function entregar(deps: DepsAviso, tenantId: string, conversationId: number, n: LinhaAviso, nota: boolean): Promise<{ resultado: ResultadoAviso; ok: boolean; detalhe: string | null }> {
  const querWhats = Boolean(n.destino);
  if (!querWhats && !nota) return { resultado: 'sem_destino', ok: false, detalhe: 'sem destino nem nota' };

  const erros: string[] = [];
  let algumOk = false;
  if (nota && n.mensagem) {
    try { await deps.chatwoot.enviar({ tenantId, conversationId, content: n.mensagem, privada: true }); algumOk = true; }
    catch (e) { erros.push(`nota: ${erroTexto(e)}`); }
  }
  let resultado: ResultadoAviso = 'sem_destino';
  if (querWhats) {
    if (!deps.waha) { erros.push('WAHA nao configurado no agente'); resultado = 'sem_waha'; }
    else {
      try { await deps.waha.enviarTexto(n.sessao ?? '', n.destino ?? '', n.mensagem ?? ''); algumOk = true; resultado = 'enviado'; }
      catch (e) { erros.push(`waha: ${erroTexto(e)}`); resultado = 'falhou'; }
    }
  } else if (algumOk) resultado = 'enviado';
  else resultado = 'falhou';
  return { resultado, ok: algumOk, detalhe: erros.length ? erros.join('; ').slice(0, 500) : null };
}

/** Os eventos novos (pagamento confirmado, pedido cancelado). Nunca lança. */
export async function avisarDono(deps: DepsAviso, p: { tenantId: string; conversationId: number; evento: Exclude<Evento, 'pedido_fechado'>; pedidoId?: string | null }): Promise<ResultadoAviso> {
  try {
    const n = await fnUma<LinhaAviso>(deps.db, 'api_agente_aviso_pedido', [p.tenantId, p.conversationId, p.evento, p.pedidoId ?? null]);
    if (!n?.pedido_id) return 'sem_destino';
    const r = await entregar(deps, p.tenantId, p.conversationId, n, n.nota_chatwoot === true);
    if (r.resultado !== 'sem_destino') {
      await fnValor(deps.db, 'api_agente_confirmar_aviso', [p.tenantId, n.pedido_id, p.evento, r.ok, r.detalhe]);
    }
    return r.resultado;
  } catch (e) {
    log('erro', 'aviso_dono.falhou', { tenant: p.tenantId, conversa: p.conversationId, evento: p.evento, erro: erroTexto(e) });
    return 'falhou';
  }
}

/**
 * A venda fechada — a mesma `api_n8n_notificar_venda` + `confirmar_notificacao`
 * que o n8n congelado chama, com a nota privada por cima quando a conta pediu.
 */
export async function avisarVendaFechada(deps: DepsAviso, p: { tenantId: string; conversationId: number; nota: boolean }): Promise<ResultadoAviso> {
  try {
    const n = await fnUma<LinhaAviso>(deps.db, 'api_n8n_notificar_venda', [p.tenantId, p.conversationId]);
    if (!n?.pedido_id) return 'sem_destino';
    const r = await entregar(deps, p.tenantId, p.conversationId, n, p.nota);
    if (r.resultado !== 'sem_destino') {
      await fnValor(deps.db, 'api_n8n_confirmar_notificacao', [p.tenantId, n.pedido_id, r.ok, r.detalhe]);
    }
    return r.resultado;
  } catch (e) {
    log('erro', 'aviso_dono.falhou', { tenant: p.tenantId, conversa: p.conversationId, evento: 'pedido_fechado', erro: erroTexto(e) });
    return 'falhou';
  }
}
