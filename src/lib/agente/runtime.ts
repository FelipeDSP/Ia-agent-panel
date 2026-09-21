/**
 * A URL do Agent Bot — a mesma para todos os clientes.
 *
 * `<AGENTE_URL>/chatwoot/<AGENTE_WEBHOOK_TOKEN>` (18/09: sem inbox; conta e
 * caixa vêm do corpo do webhook, e a forma com `/<inbox>` no fim segue aceita
 * pelo serviço). Sem `AGENTE_URL`, deriva da origem de `AGENTE_LIMPEZA_URL`;
 * sem o token no ambiente do painel, devolve a URL com `<WEBHOOK_TOKEN>` no
 * lugar (a agência completa à mão; o token é o do Coolify do agente).
 *
 * 21/09: o n8n foi desligado — todo cliente é atendido pelo serviço, então
 * não há mais "quem atende" para trocar nem URL alternativa. A coluna
 * `tenants.agente_runtime` continua existindo (o serviço descarta tenant fora
 * de `codigo`, e a migração 75 fez `codigo` o default); o painel só não a
 * expõe mais.
 *
 * Puro: o teste importa. A URL vem do ambiente do painel, nunca do form.
 */
export function urlDoBot(env: Record<string, string | undefined>): string | null {
  const base = (env.AGENTE_URL?.trim() || origemDe(env.AGENTE_LIMPEZA_URL))?.replace(/\/+$/, '') ?? null;
  const token = env.AGENTE_WEBHOOK_TOKEN?.trim() || '<WEBHOOK_TOKEN>';
  return base ? `${base}/chatwoot/${token}` : null;
}

function origemDe(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}
