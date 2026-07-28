import 'server-only';

import type { SupabaseClient, User } from '@supabase/supabase-js';

/**
 * Operações de usuário pela Admin API, com as duas defesas que o adendo §5
 * documenta. Versão para o app (TS server-only); o equivalente em
 * scripts/lib/usuarios.mjs serve os scripts de linha de comando.
 *
 * 1. A Admin API falha ~5% das chamadas com erro de JWT ES256 intermitente.
 *    Retentativa só nesse erro específico — qualquer outro volta na hora.
 * 2. listUsers é eventualmente consistente: usuário recém-criado não aparece
 *    por alguns segundos. Guarde o id de createUser; para achar por email,
 *    repita com espera.
 */

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TRANSITORIO = /unrecognized JWT kid|invalid JWT|token is unverifiable/i;

type Resultado<T> = { data: T; error: null } | { data: null; error: { message: string; code?: string; status?: number } };

async function comRetentativa<T>(
  operacao: () => Promise<Resultado<T>>,
  { tentativas = 4, intervaloMs = 700 } = {},
): Promise<Resultado<T>> {
  let ultimo: Resultado<T>['error'] = null;

  for (let i = 0; i < tentativas; i++) {
    const resultado = await operacao();
    if (!resultado.error) return resultado;

    ultimo = resultado.error;
    if (!TRANSITORIO.test(resultado.error.message ?? '')) return resultado;

    await espera(intervaloMs * (i + 1));
  }

  // O laço roda ao menos uma vez, então ultimo está definido; o fallback é só
  // para o compilador.
  return { data: null, error: ultimo ?? { message: 'falha desconhecida na Admin API' } };
}

export function criarUsuario(
  admin: SupabaseClient,
  params: Parameters<SupabaseClient['auth']['admin']['createUser']>[0],
) {
  return comRetentativa(() => admin.auth.admin.createUser(params) as Promise<Resultado<{ user: User }>>);
}

/** GoTrue sinaliza email duplicado de mais de uma forma conforme a versão. */
export function ehEmailDuplicado(error: { message?: string; code?: string; status?: number } | null): boolean {
  if (!error) return false;
  return (
    error.code === 'email_exists' ||
    error.status === 422 ||
    /already (been )?registered|already exists/i.test(error.message ?? '')
  );
}

/** Procura por email, insistindo enquanto a listagem não converge. */
export async function acharPorEmail(
  admin: SupabaseClient,
  email: string,
  { tentativas = 1, intervaloMs = 1500 } = {},
): Promise<User | null> {
  const alvo = email.toLowerCase();

  for (let i = 0; i < tentativas; i++) {
    const { data, error } = await comRetentativa(() =>
      admin.auth.admin.listUsers({ perPage: 1000 }) as Promise<Resultado<{ users: User[] }>>,
    );
    if (error) throw new Error(`listUsers falhou: ${error.message}`);

    const achado = data.users.find((u) => u.email?.toLowerCase() === alvo);
    if (achado) return achado;

    if (i < tentativas - 1) await espera(intervaloMs);
  }

  return null;
}
