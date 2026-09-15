/**
 * `Roteia Evento`, em código — o switch que decide se o webhook é mensagem de
 * CLIENTE (o agente responde), de HUMANO (um atendente assumiu: pausa) ou
 * nada (descarta).
 *
 * As três regras vêm do `agente-principal.json`, e `tests/agente-fatia1.mjs`
 * as lê de lá e executa contra os mesmos payloads que esta função recebe —
 * por isso não há como as duas divergirem sem o teste acusar.
 *
 * O guarda-corpo que importa: `sender.type` DIFERENTE de `agent_bot` E não
 * vazio. Sem as duas, a notificação que o próprio agente manda (outgoing,
 * carimbada `agent_bot`) voltaria como "humano" e pausaria a conversa —
 * `tests/notificacao-nao-pausa.mjs`.
 */
export type Evento = 'cliente' | 'humano' | 'descartar';

export interface WebhookChatwoot {
  event?: string;
  message_type?: string;
  private?: boolean;
  sender?: { type?: string | null } | null;
  [k: string]: unknown;
}

export function classificar(body: WebhookChatwoot): Evento {
  if (body.event !== 'message_created') return 'descartar';
  if (body.message_type === 'incoming' && body.private === false) return 'cliente';
  const tipo = body.sender?.type ?? '';
  if (body.message_type === 'outgoing' && tipo !== 'agent_bot' && tipo !== '') return 'humano';
  return 'descartar';
}
