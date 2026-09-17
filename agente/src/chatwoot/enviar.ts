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
 *
 * `enviarParaNumero` (17/09, aviso ao dono sem sessão WAHA por conta): abre —
 * ou reaproveita — a conversa com um NÚMERO na inbox do agente e posta nela.
 * Isso o bot não pode (`POST /contacts` e `POST /conversations` respondem
 * 401 "not authorized for bots" — medido), então usa o token de um USUÁRIO
 * administrador da agência, presente em todas as contas
 * (`CHATWOOT_AGENCIA_TOKEN`, uma credencial só). A inbox é `Channel::Api`: o
 * integrador roteia pelo `phone_number` do contato, o `source_id` é um UUID
 * que o próprio Chatwoot gera — provado em 17/09 (conversa 58 da conta 57).
 */
import { fnUma, type Db } from '../db.ts';

export interface Chatwoot {
  enviar(p: { tenantId: string; conversationId: number; content: string; privada?: boolean }): Promise<{ mensagemId: number | null }>;
  /** Manda `texto` a um número (dígitos com país, `+55…` ou `55…@c.us`) pela inbox do agente. Lança sem token da agência. */
  enviarParaNumero(p: { tenantId: string; numero: string; texto: string }): Promise<{ conversationId: number; mensagemId: number | null; contatoId: number }>;
  /** Se `enviarParaNumero` tem com que trabalhar. */
  temTokenDaAgencia(): boolean;
}

interface Credencial { chatwoot_url: string; chatwoot_token: string; chatwoot_account_id: number }
interface Par { chatwoot_account_id: number | string | null; chatwoot_inbox_id: number | string | null }

/** `55…@c.us` / `+55 69 9…` / dígitos → `+dígitos`. Vazio quando não há 10–15 dígitos. */
export function numeroE164(bruto: string): string | null {
  const d = String(bruto ?? '').replace(/@.*$/, '').replace(/\D/g, '');
  return d.length >= 10 && d.length <= 15 ? `+${d}` : null;
}

export function criarChatwoot(db: Db, fetchFn: typeof fetch = fetch, agenciaToken: string | null = null): Chatwoot {
  const token = agenciaToken?.trim() || null;
  const json = async (r: Response): Promise<Record<string, unknown> | null> => { try { return (await r.json()) as Record<string, unknown>; } catch { return null; } };

  return {
    temTokenDaAgencia: () => token !== null,

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

    async enviarParaNumero({ tenantId, numero, texto }) {
      if (!token) throw new Error('CHATWOOT_AGENCIA_TOKEN ausente: sem token de usuário não dá para abrir conversa');
      const fone = numeroE164(numero);
      if (!fone) throw new Error(`número inválido para aviso: ${numero}`);
      const cred = await fnUma<Credencial>(db, 'api_n8n_credencial_chatwoot', [tenantId]);
      const par = await fnUma<Par>(db, 'api_agente_par_chatwoot', [tenantId]);
      const inbox = Number(par?.chatwoot_inbox_id);
      if (!cred?.chatwoot_url || !Number.isFinite(inbox) || inbox <= 0) throw new Error('tenant sem URL do Chatwoot ou sem inbox');
      const base = `${cred.chatwoot_url.replace(/\/+$/, '')}/api/v1/accounts/${cred.chatwoot_account_id}`;
      const cab = { 'Content-Type': 'application/json', api_access_token: token };
      const chamar = async (metodo: string, caminho: string, corpo?: unknown) => {
        const r = await fetchFn(base + caminho, { method: metodo, headers: cab, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
        const j = await json(r);
        if (!r.ok) throw new Error(`Chatwoot ${metodo} ${caminho.replace(/\d+/g, 'N')} -> HTTP ${r.status}`);
        return j;
      };
      const digitos = fone.slice(1);

      // 1. o contato pelo telefone (a busca é textual; confere os dígitos)
      const busca = await chamar('GET', `/contacts/search?q=${encodeURIComponent(digitos)}`);
      const lista = (Array.isArray(busca?.['payload']) ? busca['payload'] : []) as Array<Record<string, unknown>>;
      let contato = lista.find((x) => String(x['phone_number'] ?? '').replace(/\D/g, '') === digitos) ?? null;
      if (!contato) {
        const criado = await chamar('POST', '/contacts', { inbox_id: inbox, name: `Aviso ${digitos}`, phone_number: fone });
        const payload = (criado?.['payload'] ?? criado) as Record<string, unknown>;
        contato = (payload['contact'] as Record<string, unknown> | undefined) ?? payload;
      }
      const contatoId = Number(contato['id']);
      if (!Number.isFinite(contatoId)) throw new Error('Chatwoot: contato sem id');

      // 2. o vínculo contato ↔ inbox (source_id); o Chatwoot gera o UUID
      const vinculos = (Array.isArray(contato['contact_inboxes']) ? contato['contact_inboxes'] : []) as Array<{ inbox?: { id?: number }; source_id?: string }>;
      let sourceId = vinculos.find((v) => Number(v.inbox?.id) === inbox)?.source_id ?? null;
      if (!sourceId) {
        const v = await chamar('POST', `/contacts/${contatoId}/contact_inboxes`, { inbox_id: inbox });
        sourceId = typeof v?.['source_id'] === 'string' ? (v['source_id'] as string) : null;
        if (!sourceId) throw new Error('Chatwoot: contact_inbox sem source_id');
      }

      // 3. a conversa nesta inbox — reaproveita a que não estiver resolvida
      const convs = await chamar('GET', `/contacts/${contatoId}/conversations`);
      const abertas = (Array.isArray(convs?.['payload']) ? convs['payload'] : []) as Array<{ id?: number; inbox_id?: number; status?: string }>;
      let conv = abertas.find((x) => Number(x.inbox_id) === inbox && x.status !== 'resolved') ?? null;
      if (!conv) {
        const nova = await chamar('POST', '/conversations', { source_id: sourceId, inbox_id: inbox, contact_id: contatoId, status: 'open' });
        conv = { id: Number(nova?.['id']) };
      }
      const conversationId = Number(conv.id);
      if (!Number.isFinite(conversationId)) throw new Error('Chatwoot: conversa sem id');

      // 4. a mensagem — com o token de usuário (o bot não está nesta conversa)
      const msg = await chamar('POST', `/conversations/${conversationId}/messages`, { content: texto, message_type: 'outgoing', private: false });
      return { conversationId, mensagemId: typeof msg?.['id'] === 'number' ? (msg['id'] as number) : null, contatoId };
    },
  };
}
