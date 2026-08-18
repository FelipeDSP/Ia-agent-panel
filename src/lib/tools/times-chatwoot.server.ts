import 'server-only';

/**
 * A chamada que prova o `team_id` — server-only porque recebe o token do
 * Chatwoot. As constantes e a validação de formulário ficam em
 * `times-chatwoot.ts`, que a tela do cliente importa.
 */

export type ResultadoVerificacao =
  | { estado: 'existe' }
  | { estado: 'nao_existe' }
  | { estado: 'nao_verificado'; motivo: string };

/**
 * Prova que o `team_id` existe NAQUELA conta, do único jeito disponível:
 * atribuindo e olhando o CORPO da resposta.
 *
 * O bot não lista times (`GET /teams` é 401) e não lê conversa de volta
 * (`GET /conversations` é 401). O que sobra é `POST .../assignments`, e ele
 * responde **200 em qualquer caso** — com o objeto do time quando atribui, e
 * com `null` quando o id não existe. Medido em 18/08.
 *
 * > Ler o status aqui é o defeito. `200` significa "requisição aceita".
 *
 * DESFAZ NO FIM. A validação mexe numa conversa real — não há como criar uma
 * de teste, porque `POST /contacts` é 401 e `POST /conversations` não resolve
 * sem contato. Então: atribui, lê, e devolve ao estado anterior com
 * `{"team_id": null}`.
 */
export async function verificarTime(params: {
  url: string;
  accountId: number | string;
  token: string;
  conversationId: number | string;
  teamId: number;
}): Promise<ResultadoVerificacao> {
  const { url, accountId, token, conversationId, teamId } = params;
  const alvo = `${url.replace(/\/+$/, '')}/api/v1/accounts/${accountId}/conversations/${conversationId}/assignments`;
  const cabecalho = { api_access_token: token, 'Content-Type': 'application/json' };

  let corpo: string;
  try {
    const r = await fetch(alvo, {
      method: 'POST',
      headers: cabecalho,
      body: JSON.stringify({ team_id: teamId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      // Erro de transporte ou de permissão não é "o time não existe" — dizer
      // que não existe aqui mandaria o cliente corrigir um número que está
      // certo.
      return { estado: 'nao_verificado', motivo: `o Chatwoot respondeu ${r.status}` };
    }
    corpo = await r.text();
  } catch (e) {
    return {
      estado: 'nao_verificado',
      motivo: e instanceof Error && e.name === 'TimeoutError'
        ? 'o Chatwoot não respondeu a tempo'
        : 'não foi possível falar com o Chatwoot',
    };
  }

  let achou = false;
  try {
    const j = JSON.parse(corpo) as { id?: number } | null;
    achou = Boolean(j && typeof j.id === 'number');
  } catch {
    achou = false;
  }

  // Desfaz SEMPRE — inclusive quando não achou, porque o Chatwoot desatribui a
  // conversa ao receber um time inexistente. Sem isto, validar um id errado
  // deixaria a conversa sem responsável.
  try {
    await fetch(alvo, {
      method: 'POST',
      headers: cabecalho,
      body: JSON.stringify({ team_id: null }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Falhar ao desfazer não invalida a leitura: o que interessa já foi lido.
  }

  return achou ? { estado: 'existe' } : { estado: 'nao_existe' };
}
