import 'server-only';

import { VARIAVEIS_LIMPEZA, resolverDestinoLimpeza } from '@/lib/limpeza-memoria-destino';

/**
 * Dispara a limpeza da memória conversacional do agente: `POST /limpar-memoria`
 * do serviço `agente/` (header `x-limpeza-secret`, body
 * `{ tenant_id, escopo, conversation_ids? }`). Lá nada é apagado: a memória
 * vem de `mensagens_log` e a limpeza é o CORTE (`conversas.memoria_cortada_em`)
 * — o agente deixa de ver o que veio antes.
 *
 * O painel apenas SINALIZA: tenant_id + escopo (+ os conversation_id, quando
 * específico) e um segredo compartilhado. Para conversas específicas, os ids
 * chegam JÁ validados contra o banco pela Server Action.
 *
 * Server-only: o segredo nunca pode ir ao browser.
 */
export type ResultadoLimparMemoria = { ok: true } | { ok: false; motivo: string };

export async function invocarLimparMemoria(params: {
  tenantId: string;
  escopo: 'todas' | 'conversas';
  conversationIds: number[];
}): Promise<ResultadoLimparMemoria> {
  const destino = resolverDestinoLimpeza(process.env);
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
    return { ok: false, motivo: `Não foi possível falar com o agente (${msg}).` };
  }

  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, motivo: `O agente recusou o segredo. Verifique ${VARIAVEIS_LIMPEZA.segredo}.` };
  }
  if (!resp.ok) {
    return { ok: false, motivo: `O agente respondeu ${resp.status}.` };
  }
  return { ok: true };
}
