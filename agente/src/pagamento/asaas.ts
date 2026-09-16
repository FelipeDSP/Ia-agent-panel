/**
 * O Asaas — as quatro chamadas que o pagamento por link precisa, e nada mais.
 *
 *   criarLink          POST   /v3/paymentLinks              (a tool)
 *   desativarLink      PUT    /v3/paymentLinks/{id}  active=false   (encerramento, passo 1)
 *   cobrancasPendentes GET    /v3/payments?paymentLink={id}&status=PENDING   (encerramento, passo 2)
 *   removerCobranca    DELETE /v3/payments/{id}     (soft delete, restaurável)
 *
 * A chave e a base vêm POR CHAMADA, da linha do banco do tenant
 * (`api_n8n_gerar_cobranca` / `api_n8n_cobrancas_a_encerrar`): não há chave
 * global no serviço. A chave nunca vai ao log nem ao trace — só `status` e o
 * texto de erro do Asaas, cortado.
 *
 * O que está aqui foi medido pelas sondas A, B e D
 * (docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md §6): `endDate` é DATA; `active=false`
 * fecha a página mas não o Pix já gerado; DELETE do link com cobrança é 400 —
 * por isso remove-se a COBRANÇA, não o link.
 */
export interface RespostaAsaas { ok: boolean; status: number; corpo: Record<string, unknown> | null; detalhe: string }

export interface Asaas {
  criarLink(base: string, key: string, corpo: Record<string, unknown>): Promise<RespostaAsaas>;
  desativarLink(base: string, key: string, linkId: string): Promise<RespostaAsaas>;
  cobrancasPendentes(base: string, key: string, linkId: string): Promise<{ ok: boolean; status: number; ids: string[]; detalhe: string }>;
  removerCobranca(base: string, key: string, pagamentoId: string): Promise<RespostaAsaas>;
}

const TIMEOUT_MS = 15_000;

/** O texto de erro que o Asaas manda (`errors[].description` ou `message`), cortado — nunca a chave. */
function detalheDe(status: number, corpo: unknown): string {
  const c = corpo as { errors?: Array<{ description?: string }>; message?: string } | null;
  const txt = c?.errors?.map((e) => e.description).filter(Boolean).join('; ') || c?.message || '';
  return `HTTP ${status}${txt ? ': ' + String(txt).slice(0, 300) : ''}`;
}

export function criarAsaas(fetchFn: typeof fetch = fetch): Asaas {
  async function chamar(base: string, key: string, metodo: string, caminho: string, corpo?: unknown): Promise<RespostaAsaas> {
    const r = await fetchFn(`${base.replace(/\/+$/, '')}${caminho}`, {
      method: metodo,
      headers: { access_token: key, 'Content-Type': 'application/json', 'User-Agent': 'agente-chatyou' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json: Record<string, unknown> | null = null;
    try { json = (await r.json()) as Record<string, unknown>; } catch { json = null; }
    return { ok: r.ok, status: r.status, corpo: json, detalhe: detalheDe(r.status, json) };
  }
  return {
    criarLink: (base, key, corpo) => chamar(base, key, 'POST', '/v3/paymentLinks', corpo),
    desativarLink: (base, key, linkId) => chamar(base, key, 'PUT', `/v3/paymentLinks/${encodeURIComponent(linkId)}`, { active: false }),
    async cobrancasPendentes(base, key, linkId) {
      const r = await chamar(base, key, 'GET', `/v3/payments?paymentLink=${encodeURIComponent(linkId)}&status=PENDING&limit=100`);
      const data = (r.corpo?.data as Array<{ id?: string; status?: string }> | undefined) ?? [];
      return { ok: r.ok, status: r.status, ids: data.filter((p) => p.status === 'PENDING' && p.id).map((p) => String(p.id)), detalhe: r.detalhe };
    },
    removerCobranca: (base, key, pagamentoId) => chamar(base, key, 'DELETE', `/v3/payments/${encodeURIComponent(pagamentoId)}`),
  };
}
