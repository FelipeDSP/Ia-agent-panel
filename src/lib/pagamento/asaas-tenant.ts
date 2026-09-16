/**
 * Credencial Asaas por tenant — a parte PURA da tela da agência.
 *
 * O que a tela promete (docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md §3):
 * - ambiente é enum (`sandbox` | `producao`); a URL base é DERIVADA dele,
 *   nunca guardada;
 * - a chave é write-only: o formulário nunca a recebe de volta; em branco =
 *   "mantém a que está";
 * - a chave tem de bater com o ambiente: chave de sandbox começa com
 *   `$aact_hmlg_`, e gravá-la como produção (ou o inverso) é o estado
 *   impossível que a coluna única evitaria — então o validador recusa;
 * - o token do webhook é gerado aqui (48 hex, atende o CHECK 32..255) e nunca
 *   digitado;
 * - a URL do serviço (`/asaas`) vem do ambiente do painel, não do form.
 *
 * Puro (sem `server-only`): o teste importa e exercita sem banco.
 */
export type AmbienteAsaas = 'sandbox' | 'producao';

export const PREFIXO_CHAVE_SANDBOX = '$aact_hmlg_';

export function baseUrlDoAmbiente(ambiente: AmbienteAsaas): string {
  return ambiente === 'producao' ? 'https://api.asaas.com' : 'https://api-sandbox.asaas.com';
}

export function ambienteDaChave(chave: string): AmbienteAsaas | null {
  if (!chave.startsWith('$aact_')) return null;
  return chave.startsWith(PREFIXO_CHAVE_SANDBOX) ? 'sandbox' : 'producao';
}

export interface DadosAsaasTenant {
  ambiente: AmbienteAsaas;
  /** `null` = manter a chave que já está gravada para esse ambiente. */
  chave: string | null;
}
export type ResultadoAsaas = { ok: true; valor: DadosAsaasTenant } | { ok: false; erros: Record<string, string> };

export function validarAsaasTenant(fd: FormData): ResultadoAsaas {
  const erros: Record<string, string> = {};
  const ambiente = String(fd.get('asaas_ambiente') ?? '') as AmbienteAsaas;
  if (ambiente !== 'sandbox' && ambiente !== 'producao') erros['asaas_ambiente'] = 'Ambiente deve ser sandbox ou produção.';
  const chaveBruta = String(fd.get('asaas_api_key') ?? '').trim();
  let chave: string | null = null;
  if (chaveBruta) {
    const amb = ambienteDaChave(chaveBruta);
    if (amb === null) erros['asaas_api_key'] = 'Isso não parece uma chave de API do Asaas (começa com $aact_).';
    else if (!erros['asaas_ambiente'] && amb !== ambiente) {
      erros['asaas_api_key'] = amb === 'sandbox'
        ? 'Essa chave é de SANDBOX ($aact_hmlg_) e o ambiente escolhido é produção.'
        : 'Essa chave é de PRODUÇÃO e o ambiente escolhido é sandbox.';
    } else chave = chaveBruta;
  }
  if (Object.keys(erros).length) return { ok: false, erros };
  return { ok: true, valor: { ambiente, chave } };
}

/** 48 hex (24 bytes): atende o CHECK 32..255 e não é adivinhável. */
export function gerarTokenWebhook(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A URL do webhook no serviço, derivada do ambiente do painel. `null` = painel sem a URL do agente. */
export function urlDoWebhookNoAgente(env: Record<string, string | undefined>): string | null {
  const direta = env.AGENTE_URL?.trim().replace(/\/+$/, '');
  if (direta) return `${direta}/asaas`;
  // O painel já sabe onde o agente está por causa do Limpar Memória.
  const limpeza = env.AGENTE_LIMPEZA_URL?.trim();
  if (limpeza) {
    try { const u = new URL(limpeza); return `${u.origin}/asaas`; } catch { return null; }
  }
  return null;
}

/** O corpo do webhook no Asaas — o mesmo do `scripts/pagamento-sendbox-arranjo.mjs`. */
export function corpoDoWebhookAsaas(url: string, token: string, email: string): Record<string, unknown> {
  return { name: 'agente chatyou', url, email, enabled: true, interrupted: false, authToken: token, sendType: 'SEQUENTIALLY', apiVersion: 3, events: ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'] };
}

/** Como a tela descreve uma chave sem mostrá-la. */
export function rotuloDaChave(temChave: boolean): string {
  return temChave ? 'configurada (não é exibida)' : 'não configurada';
}
