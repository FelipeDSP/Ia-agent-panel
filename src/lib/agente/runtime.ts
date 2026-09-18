/**
 * Quem atende cada cliente — `tenants.agente_runtime` (migração 62) como o
 * painel o mostra e o troca.
 *
 * Trocar de lado é DUAS coisas, e a ORDEM importa (DESENHO §8, ensaiado em
 * 16/09 no rollback do sendbox):
 *
 *   para código:  1) apontar o bot da conta no Chatwoot para a URL do serviço
 *                 2) só então `agente_runtime = 'codigo'`
 *   para n8n:     1) `agente_runtime = 'n8n'` primeiro
 *                 2) só então a URL antiga no bot
 *
 * Invertida, a ida deixa o cliente MUDO (o serviço descarta tenant que não é
 * dele; o n8n já não recebe) e a volta dá resposta DUPLA por um instante. O
 * painel não consegue conferir a URL do bot (o token que ele tem é de Agent
 * Bot, que não lê `agent_bots`), então ele mostra a URL certa e exige a
 * confirmação humana antes de virar a coluna.
 *
 * Puro: o teste importa. As URLs vêm do ambiente do painel, nunca do form.
 */
export type RuntimeAgente = 'n8n' | 'codigo';

export const ROTULO_RUNTIME: Record<RuntimeAgente, string> = { n8n: 'n8n', codigo: 'código' };

export function normalizarRuntime(v: unknown): RuntimeAgente {
  return v === 'codigo' ? 'codigo' : 'n8n';
}

export interface UrlsDoBot { codigo: string | null; n8n: string | null }

/**
 * A URL que o bot da conta precisa ter no Chatwoot para cada runtime.
 * - código: `<AGENTE_URL>/chatwoot/<AGENTE_WEBHOOK_TOKEN>` (18/09: sem inbox; a forma com `/<inbox>` segue aceita) — sem o
 *   token no ambiente do painel, devolve a URL com `<WEBHOOK_TOKEN>` no lugar
 *   (a agência completa à mão; o token é o do Coolify do agente);
 * - n8n: `<N8N_WEBHOOK_BASE>/<path>`; `path` é o do workflow principal, e a
 *   base vem de `N8N_WEBHOOK_BASE` ou da origem de `N8N_LIMPEZA_URL`.
 */
export function urlsDoBot(env: Record<string, string | undefined>, inbox: number | null, pathN8n = 'agente-lavanderia-chatwoot-teste-teste'): UrlsDoBot {
  const base = (env.AGENTE_URL?.trim() || origemDe(env.AGENTE_LIMPEZA_URL))?.replace(/\/+$/, '') ?? null;
  const token = env.AGENTE_WEBHOOK_TOKEN?.trim() || '<WEBHOOK_TOKEN>';
  // 18/09: uma URL só para todos os clientes — conta e inbox vêm do corpo do
  // webhook. A forma com `/<inbox>` no fim continua aceita pelo serviço.
  const codigo = base ? `${base}/chatwoot/${token}` : null;
  const baseN8n = (env.N8N_WEBHOOK_BASE?.trim() || (origemDe(env.N8N_LIMPEZA_URL) ? `${origemDe(env.N8N_LIMPEZA_URL)}/webhook` : null))?.replace(/\/+$/, '') ?? null;
  const n8n = baseN8n ? `${baseN8n}/${pathN8n}` : null;
  return { codigo, n8n };
}

function origemDe(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

/** O passo a passo para ir de `de` para `para`, na ordem certa. */
export function roteiroDaTroca(de: RuntimeAgente, para: RuntimeAgente, urls: UrlsDoBot): string[] {
  if (de === para) return [];
  if (para === 'codigo') {
    return [
      `No Chatwoot, mude a outgoing_url do Agent Bot da conta para: ${urls.codigo ?? '(URL do serviço indisponível: defina AGENTE_URL)'}`,
      'Só depois confirme aqui: o serviço passa a aceitar este cliente (antes disso ele descarta — é o que evita resposta dupla).',
      'Mande uma mensagem de teste e confira o turno em Agente.',
    ];
  }
  return [
    'Confirme aqui primeiro: o serviço passa a descartar este cliente.',
    `Depois, no Chatwoot, mude a outgoing_url do Agent Bot para a URL do n8n: ${urls.n8n ?? '(URL do n8n indisponível: defina N8N_WEBHOOK_BASE)'}`,
    'A memória fica: os dois lados escrevem em mensagens_log.',
  ];
}

/** O que a ação exige para virar a coluna: a confirmação explícita de quem apontou o bot. */
export function podeTrocar(de: RuntimeAgente, para: RuntimeAgente, confirmou: boolean): { ok: true } | { ok: false; motivo: string } {
  if (de === para) return { ok: false, motivo: `Já está em ${ROTULO_RUNTIME[para]}.` };
  if (!confirmou) {
    return { ok: false, motivo: para === 'codigo' ? 'Confirme que o bot já aponta para o serviço — sem isso o cliente fica mudo.' : 'Confirme que vai apontar o bot para o n8n em seguida.' };
  }
  return { ok: true };
}
