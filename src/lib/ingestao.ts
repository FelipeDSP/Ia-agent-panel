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
    throw new Error(
      'INGESTAO_SECRET ausente. Defina no .env.local do painel e como secret da ' +
        'Edge Function (supabase secrets set INGESTAO_SECRET=...).',
    );
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
