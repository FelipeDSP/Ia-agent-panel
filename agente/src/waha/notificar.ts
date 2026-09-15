/**
 * WAHA — o nó `Send Text` do n8n (`POST /api/sendText`, header `X-Api-Key`).
 * É transporte: recebe sessão, chat e texto, e não sabe de tenant nenhum.
 * Injetável, para o teste trocar por um fake.
 */
export interface Waha {
  enviarTexto(sessao: string, chatId: string, texto: string): Promise<void>;
}

export function criarWaha(url: string, apiKey: string, fetchFn: typeof fetch = fetch): Waha {
  return {
    async enviarTexto(sessao, chatId, texto) {
      const r = await fetchFn(`${url}/api/sendText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({ session: sessao, chatId, text: texto }),
      });
      if (!r.ok) throw new Error(`WAHA sendText -> HTTP ${r.status}`);
    },
  };
}
