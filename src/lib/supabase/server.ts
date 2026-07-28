import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config';

/**
 * Cliente para Server Components, Server Actions e Route Handlers.
 *
 * Continua usando a chave publishable: quem autoriza e o JWT do usuario no
 * cookie, e o RLS aplica as policies normalmente. Isso e proposital — se este
 * cliente usasse a chave secreta, todo Server Component passaria a enxergar
 * todos os tenants e o RLS deixaria de ser rede de protecao.
 */
export async function criarClienteServidor() {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesParaDefinir) {
        try {
          for (const { name, value, options } of cookiesParaDefinir) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component nao pode escrever cookie. O refresh de sessao
          // acontece no middleware, que pode — entao ignorar aqui e correto.
        }
      },
    },
  });
}
