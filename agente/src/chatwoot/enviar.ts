/**
 * `Credencial (resposta)` + `Envia Mensagem Chatwoot` (e os avisos e a nota
 * privada, que são o mesmo POST com outro corpo).
 *
 *   POST {chatwoot_url}/api/v1/accounts/{account}/conversations/{conv}/messages
 *   header api_access_token = token do AGENT BOT (api_n8n_credencial_chatwoot)
 *   body { content, message_type: 'outgoing', private }
 *
 * O token é o de Agent Bot de propósito: é o que faz o Chatwoot carimbar
 * `sender.type = 'agent_bot'` no webhook de volta, e é o que o `classificar`
 * usa para NÃO pausar a conversa com a própria resposta.
 */
import { fnUma, type Db } from '../db.ts';

export interface Chatwoot {
  enviar(p: { tenantId: string; conversationId: number; content: string; privada?: boolean }): Promise<{ mensagemId: number | null }>;
}

interface Credencial { chatwoot_url: string; chatwoot_token: string; chatwoot_account_id: number }

export function criarChatwoot(db: Db, fetchFn: typeof fetch = fetch): Chatwoot {
  return {
    async enviar({ tenantId, conversationId, content, privada = false }) {
      const cred = await fnUma<Credencial>(db, 'api_n8n_credencial_chatwoot', [tenantId]);
      if (!cred?.chatwoot_url || !cred.chatwoot_token) throw new Error('tenant sem credencial de Chatwoot');
      const url = `${cred.chatwoot_url.replace(/\/+$/, '')}/api/v1/accounts/${cred.chatwoot_account_id}/conversations/${conversationId}/messages`;
      const r = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', api_access_token: cred.chatwoot_token },
        body: JSON.stringify({ content, message_type: 'outgoing', private: privada }),
      });
      if (!r.ok) throw new Error(`Chatwoot messages -> HTTP ${r.status}`);
      let id: number | null = null;
      try { const j = (await r.json()) as { id?: number }; id = typeof j.id === 'number' ? j.id : null; } catch { /* corpo não-JSON: id fica nulo */ }
      return { mensagemId: id };
    },
  };
}
