import 'server-only';

import { resolverDestinoLimpeza } from '@/lib/limpeza-memoria-destino';

/**
 * Dispara a limpeza da memória conversacional do agente — no lado que atende
 * o tenant (`tenants.agente_runtime`, migração 62):
 *
 * - `n8n`: o webhook do n8n. A memória mora no Redis, do lado do n8n, e só ele
 *   a alcança. As chaves são escopadas por tenant (`tenant_<uuid>_memory_<conv>`
 *   e `tenant_<uuid>_conv_<conv>_acumulo`), então o tenant_id na requisição é o
 *   que mantém o isolamento. `escopo: 'todas'` varre `tenant_<uuid>_*` — pega
 *   inclusive buffers de conversas que já não estão em `conversas`;
 * - `codigo`: `POST /limpar-memoria` do serviço `agente/`, mesmo contrato
 *   (header `x-limpeza-secret`, body `{ tenant_id, escopo, conversation_ids? }`).
 *   Lá nada é apagado: a memória vem de `mensagens_log` e a limpeza é o CORTE
 *   (`conversas.memoria_cortada_em`) — o agente deixa de ver o que veio antes.
 *
 * O painel apenas SINALIZA: tenant_id + escopo (+ os conversation_id, quando
 * específico) e um segredo compartilhado. Para conversas específicas, os ids
 * chegam JÁ validados contra o banco pela Server Action.
 *
 * Server-only: os segredos nunca podem ir ao browser.
 */
export type ResultadoLimparMemoria = { ok: true } | { ok: false; motivo: string };

export async function invocarLimparMemoria(params: {
  tenantId: string;
  /** `tenants.agente_runtime` do tenant — decide o destino. */
  runtime: unknown;
  escopo: 'todas' | 'conversas';
  conversationIds: number[];
}): Promise<ResultadoLimparMemoria> {
  const destino = resolverDestinoLimpeza(params.runtime, process.env);
  if (!destino.ok) return { ok: false, motivo: destino.motivo };

  const corpo =
    params.escopo === 'todas'
      ? { tenant_id: params.tenantId, escopo: 'todas' }
      : {
          tenant_id: params.tenantId,
          escopo: 'conversas',
          conversation_ids: params.conversationIds,
        };

  let resp: Response;
  try {
    // Timeout para não pendurar a ação num destino fora do ar.
    resp = await fetch(destino.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-limpeza-secret': destino.segredo,
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
  } catch (e) {
    const msg =
      e instanceof Error && e.name === 'TimeoutError' ? 'tempo esgotado' : 'sem resposta';
    return { ok: false, motivo: `Não foi possível falar com o ${destino.nome} (${msg}).` };
  }

  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      motivo: `O ${destino.nome} recusou o segredo. Verifique ${destino.runtime === 'codigo' ? 'AGENTE_LIMPEZA_SECRET' : 'N8N_LIMPEZA_SECRET'}.`,
    };
  }
  if (!resp.ok) {
    return { ok: false, motivo: `O ${destino.nome} respondeu ${resp.status}.` };
  }
  return { ok: true };
}
