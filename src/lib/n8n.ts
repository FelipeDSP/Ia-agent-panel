import 'server-only';

/**
 * Dispara o webhook do n8n que limpa a memória conversacional (Redis) do agente.
 *
 * A memória do agente NÃO fica neste banco — mora no Redis, do lado do n8n. Só o
 * n8n a alcança. Por isso o painel apenas SINALIZA: manda tenant_id + escopo (+
 * os conversation_id, quando específico) e um segredo compartilhado. O n8n
 * confere o segredo e apaga as chaves de sessão no Redis.
 *
 * As chaves do Redis são escopadas por tenant (`tenant_<uuid>_memory_<conv>` e
 * `tenant_<uuid>_conv_<conv>_acumulo`), então o tenant_id na requisição é o que
 * mantém o isolamento: um cliente nunca alcança a chave de outro.
 *
 * `escopo: 'todas'` deixa o n8n varrer `tenant_<uuid>_*` — pega inclusive chaves
 * de conversas que já não estão na tabela `conversas` (buffers órfãos). Para
 * conversas específicas, os conversation_id chegam JÁ validados contra o banco
 * pela Server Action.
 *
 * Server-only: o segredo nunca pode ir ao browser.
 */
export type ResultadoLimparMemoria = { ok: true } | { ok: false; motivo: string };

export async function invocarLimparMemoria(params: {
  tenantId: string;
  escopo: 'todas' | 'conversas';
  conversationIds: number[];
}): Promise<ResultadoLimparMemoria> {
  const url = process.env.N8N_LIMPEZA_URL;
  const segredo = process.env.N8N_LIMPEZA_SECRET;
  if (!url || !segredo) {
    return {
      ok: false,
      motivo:
        'Limpeza de memória não configurada. Defina N8N_LIMPEZA_URL e ' +
        'N8N_LIMPEZA_SECRET no ambiente do painel.',
    };
  }

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
    // Timeout para não pendurar a ação num n8n fora do ar.
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-limpeza-secret': segredo,
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
  } catch (e) {
    const msg =
      e instanceof Error && e.name === 'TimeoutError' ? 'tempo esgotado' : 'sem resposta';
    return { ok: false, motivo: `Não foi possível falar com o n8n (${msg}).` };
  }

  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      motivo: 'n8n recusou o segredo. Verifique N8N_LIMPEZA_SECRET.',
    };
  }
  if (!resp.ok) {
    return { ok: false, motivo: `n8n respondeu ${resp.status}.` };
  }
  return { ok: true };
}
