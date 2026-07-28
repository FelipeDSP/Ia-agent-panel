'use client';

import { createBrowserClient } from '@supabase/ssr';

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config';

/**
 * Cliente para componentes com 'use client'.
 *
 * Usa a chave publishable, que e publica por natureza — o que protege os dados
 * e o RLS, nao o segredo da chave. Toda query feita por aqui carrega o JWT do
 * usuario logado e passa pelas policies.
 */
export function criarClienteBrowser() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
}
