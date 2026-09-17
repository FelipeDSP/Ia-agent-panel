/**
 * O WEBHOOK do Asaas — porte do workflow `Webhook - Pagamento Asaas` que o n8n
 * nunca importou (docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md §11.3):
 *
 *   Extrai Evento   n8n/webhook-pagamento-extrai.js  (o MESMO corpo: token do header,
 *                   ids, valor em centavos — e NADA do pagador)
 *   Aplica Webhook  api_n8n_pagamento_webhook: a ÚNICA função que escreve `pago`
 *   Responde 200    SEMPRE, com só o estado, ANTES de qualquer HTTP para fora
 *     aplicou?        -> mensagem ao cliente pelo Chatwoot (bot) + registra no log + confirma notificado
 *     precisa_humano? -> nota privada ao atendente (fora do prazo: NÃO reabre, NÃO estorna)
 *
 * Por que 200 sempre: 15 falhas consecutivas interrompem a fila do Asaas; 401
 * a um forjador não protege nada (o token errado já vira `reconhecido=false`
 * sem efeito), e 401 ao Asaas de verdade por token mal configurado nosso
 * derrubaria a fila.
 *
 * A mensagem "Pagamento confirmado!" TAMBÉM entra em `mensagens_log` como
 * saída: é o que faz o agente, no turno seguinte, SABER que caiu (a memória
 * vem do log) — e é o que o prompt manda ele usar para confirmar ao cliente.
 */
import { fnUma, fnValor, type Db } from '../db.ts';
import { avisarDono } from '../pedido/aviso.ts';
import type { Waha } from '../waha/notificar.ts';
import { corpoN8n, rodarN8n } from '../n8n-js.ts';
import type { Chatwoot } from '../chatwoot/enviar.ts';
import { log, erroTexto } from '../log.ts';

export interface DepsWebhook { db: Db; chatwoot: Chatwoot; n8nJsDir: string; waha?: Waha | null }

export interface EstadoWebhook { reconhecido: boolean; ja_processado: boolean; aplicou: boolean; motivo: string | null }

interface LinhaWebhook extends EstadoWebhook {
  tenant_id: string | null; cobranca_id: string | null; pedido_id: string | null; pedido_numero: number | null;
  conversation_id: number | string | null; total_centavos: number | null; precisa_humano: boolean; mensagem: string | null;
}

export const NOTA_FORA_DO_PRAZO = (numero: number | null, centavos: number | null) =>
  `⚠️ *Pagamento FORA DO PRAZO* — pedido nº ${numero ?? '?'} (R$ ${((centavos ?? 0) / 100).toFixed(2).replace('.', ',')}).\n\n`
  + 'O link já tinha vencido quando o pagamento caiu. O pedido NÃO foi reaberto e nada foi estornado. '
  + 'Decida: entregar e reabrir à mão, ou estornar pelo Asaas.';

/**
 * Processa um POST do Asaas. Devolve o estado para a resposta HTTP e uma
 * promessa `pos` com os efeitos externos (Chatwoot), para o servidor responder
 * antes e os testes esperarem depois.
 */
export async function receberWebhookAsaas(deps: DepsWebhook, headers: Record<string, string | string[] | undefined>, body: unknown): Promise<{ estado: EstadoWebhook; pos: Promise<void> }> {
  const extraido = rodarN8n(corpoN8n(deps.n8nJsDir, 'webhook-pagamento-extrai.js'), { json: { headers, body: (body ?? {}) as Record<string, unknown> } }) as {
    webhook_token: string; evento_id: string; evento: string; pagamento_id: string | null; link_id: string | null; referencia: string | null; valor_centavos: number | null;
  };

  const r = await fnUma<LinhaWebhook>(deps.db, 'api_n8n_pagamento_webhook', [
    extraido.webhook_token, extraido.evento_id, extraido.evento, extraido.pagamento_id, extraido.link_id, extraido.referencia, extraido.valor_centavos,
  ]);
  const estado: EstadoWebhook = { reconhecido: r?.reconhecido === true, ja_processado: r?.ja_processado === true, aplicou: r?.aplicou === true, motivo: r?.motivo ?? null };
  log(estado.reconhecido ? 'info' : 'aviso', 'asaas.webhook', { evento: extraido.evento, ...estado, tenant: r?.tenant_id ?? null, pedido: r?.pedido_numero ?? null });

  const pos = (async () => {
    if (!r || !r.tenant_id) return;
    const conversationId = Number(r.conversation_id);
    if (r.aplicou && r.mensagem && Number.isFinite(conversationId)) {
      let ok = false; let detalhe: string | null = null;
      try {
        await deps.chatwoot.enviar({ tenantId: r.tenant_id, conversationId, content: r.mensagem });
        ok = true;
        // a saída no log: memória do agente + auditoria (tokens 0; execucao = o evento)
        try { await fnValor(deps.db, 'api_n8n_registrar_mensagem', [r.tenant_id, conversationId, 'saida', r.mensagem, 0, 0, null, null, `asaas:${extraido.evento_id}`, JSON.stringify({ fonte: 'webhook_pagamento', chamadas: 0 })]); }
        catch (e) { log('erro', 'asaas.webhook.log_falhou', { erro: erroTexto(e) }); }
      } catch (e) {
        detalhe = erroTexto(e);
        log('erro', 'asaas.webhook.notificar_falhou', { tenant: r.tenant_id, conversa: conversationId, erro: detalhe });
      }
      try { await fnValor(deps.db, 'api_n8n_confirmar_pagamento_notificado', [r.tenant_id, r.cobranca_id, ok, detalhe]); }
      catch (e) { log('erro', 'asaas.webhook.confirmar_falhou', { erro: erroTexto(e) }); }
      // 69: o dono fica sabendo que o dinheiro entrou (WhatsApp e/ou nota).
      // `avisarDono` nunca lança; a função no banco cala se a conta não pediu.
      const aviso = await avisarDono({ db: deps.db, chatwoot: deps.chatwoot, waha: deps.waha ?? null }, { tenantId: r.tenant_id, conversationId, evento: 'pagamento_confirmado', pedidoId: r.pedido_id });
      if (aviso !== 'sem_destino') log('info', 'asaas.webhook.aviso_dono', { tenant: r.tenant_id, pedido: r.pedido_numero, aviso });
    }
    if (r.precisa_humano && Number.isFinite(conversationId)) {
      try { await deps.chatwoot.enviar({ tenantId: r.tenant_id, conversationId, content: NOTA_FORA_DO_PRAZO(r.pedido_numero, r.total_centavos), privada: true }); }
      catch (e) { log('erro', 'asaas.webhook.nota_falhou', { erro: erroTexto(e) }); }
    }
  })();

  return { estado, pos };
}
