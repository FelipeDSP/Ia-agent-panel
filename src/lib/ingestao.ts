import 'server-only';

import { SUPABASE_URL } from './supabase/config';

/**
 * Dispara a Edge Function processar-ingestao.
 *
 * O segredo compartilhado (INGESTAO_SECRET) e a unica credencial que a funcao
 * aceita — ela e publicada com verify_jwt = false. Server-only: se vazasse para
 * o browser, qualquer um dispararia processamento.
 *
 * Para arquivo, a funcao responde 202 em segundos e segue processando em
 * background (EdgeRuntime.waitUntil); o painel acompanha por polling do job.
 * Para texto, a funcao processa sincrono e so responde quando termina.
 */
export async function invocarProcessamento(
  jobId: string,
  texto?: string,
): Promise<{ ok: boolean; status?: number; corpo?: unknown }> {
  const segredo = process.env.INGESTAO_SECRET;
  if (!segredo) {
    // Config ausente: NÃO lança. Se lançasse, subirArquivo estouraria depois de
    // já ter subido o arquivo ao Storage e criado o job — deixando os dois
    // órfãos. Retornar ok:false deixa os três chamadores tratarem com o mesmo
    // caminho de erro (job marcado 'erro', mensagem amigável, reprocessável).
    console.error(
      'INGESTAO_SECRET ausente. Defina no .env.local do painel e como secret da ' +
        'Edge Function (supabase secrets set INGESTAO_SECRET=...).',
    );
    return { ok: false };
  }

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/processar-ingestao`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ingestao-secret': segredo,
    },
    body: JSON.stringify(texto === undefined ? { job_id: jobId } : { job_id: jobId, texto }),
  });

  let corpo: unknown = null;
  try {
    corpo = await resp.json();
  } catch {
    // sem corpo JSON — tudo bem
  }

  return { ok: resp.ok, status: resp.status, corpo };
}
