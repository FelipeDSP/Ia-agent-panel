import 'server-only';

/**
 * Validacao do token do Chatwoot.
 *
 * Restricao da Fase 3: validar ANTES de salvar, com chamada real. Foi um 401
 * silencioso que travou o cutover — o erro so aparecia quando o agente parava
 * de responder. Aqui a checagem e obrigatoria e roda no servidor: o token
 * nunca vai para o browser.
 */

export type ResultadoChatwoot =
  | { ok: true; nomeConta: string | null }
  | { ok: false; motivo: string };

/**
 * Confere se (url, account_id, token) formam uma credencial valida.
 *
 * O Chatwoot autentica pelo header `api_access_token`, nao Bearer. O endpoint
 * GET /api/v1/accounts/{id} responde 200 com a conta quando o token e valido
 * para aquela conta, 401 quando o token e invalido, e 404 quando a conta nao
 * existe para aquele token.
 */
export async function validarCredencialChatwoot(params: {
  url: string;
  accountId: number;
  token: string;
}): Promise<ResultadoChatwoot> {
  const base = params.url.replace(/\/+$/, '');
  let endpoint: URL;
  try {
    endpoint = new URL(`${base}/api/v1/accounts/${params.accountId}`);
  } catch {
    return { ok: false, motivo: 'URL do Chatwoot inválida.' };
  }

  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost') {
    return { ok: false, motivo: 'A URL do Chatwoot precisa usar HTTPS.' };
  }

  let resposta: Response;
  try {
    // Timeout para nao pendurar o save num Chatwoot fora do ar.
    resposta = await fetch(endpoint, {
      method: 'GET',
      headers: { api_access_token: params.token, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch (e) {
    const msg = e instanceof Error && e.name === 'TimeoutError' ? 'tempo esgotado' : 'sem resposta';
    return { ok: false, motivo: `Não foi possível falar com o Chatwoot (${msg}).` };
  }

  if (resposta.status === 401 || resposta.status === 403) {
    return { ok: false, motivo: 'Token recusado pelo Chatwoot (401). Verifique o token.' };
  }
  if (resposta.status === 404) {
    return {
      ok: false,
      motivo: `Conta ${params.accountId} não encontrada para este token.`,
    };
  }
  if (!resposta.ok) {
    return { ok: false, motivo: `Chatwoot respondeu ${resposta.status}.` };
  }

  // 200: extrai o nome da conta se vier, so para confirmar visualmente na UI.
  let nomeConta: string | null = null;
  try {
    const corpo = (await resposta.json()) as { name?: unknown };
    if (typeof corpo.name === 'string') nomeConta = corpo.name;
  } catch {
    // Corpo nao-JSON num 200 e estranho, mas nao invalida o token.
  }

  return { ok: true, nomeConta };
}
