/**
 * Para ONDE o botão "Limpar memória" manda o pedido: o serviço `agente/`
 * (`POST /limpar-memoria`). Até 21/09 o destino dependia de
 * `tenants.agente_runtime` (n8n × código); com o n8n desligado sobrou um lado.
 *
 * Sem as duas variáveis a resposta é ERRO nomeando-as — nunca um "limpou" em
 * silêncio que o cliente não tem como notar.
 *
 * Puro (sem `server-only`) para o teste importar. Os SEGREDOS continuam
 * server-side: quem chama é a Server Action, que passa `process.env`.
 */
export type DestinoLimpeza =
  | { ok: true; url: string; segredo: string }
  | { ok: false; motivo: string };

export const VARIAVEIS_LIMPEZA = { url: 'AGENTE_LIMPEZA_URL', segredo: 'AGENTE_LIMPEZA_SECRET' } as const;

export function resolverDestinoLimpeza(env: Record<string, string | undefined>): DestinoLimpeza {
  const url = env[VARIAVEIS_LIMPEZA.url]?.trim();
  const segredo = env[VARIAVEIS_LIMPEZA.segredo]?.trim();
  if (!url || !segredo) {
    return {
      ok: false,
      motivo:
        'Limpeza de memória não configurada. ' +
        `Defina ${VARIAVEIS_LIMPEZA.url} e ${VARIAVEIS_LIMPEZA.segredo} no ambiente do painel.`,
    };
  }
  return { ok: true, url, segredo };
}
