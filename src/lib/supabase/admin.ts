import 'server-only';

import { createClient } from '@supabase/supabase-js';

import { SUPABASE_URL } from './config';

/**
 * Cliente com a chave secreta. Ignora RLS e enxerga todos os tenants.
 *
 * O `import 'server-only'` no topo nao e decoracao: se qualquer arquivo com
 * 'use client' importar este modulo, o build FALHA em vez de embutir a chave
 * secreta no bundle do browser. E a diferenca entre uma convencao e uma
 * garantia.
 *
 * Regra de uso: apenas para operacoes que o usuario logado nao poderia fazer
 * por RLS — criar usuario via Admin API, basicamente. Leitura de dado de
 * tenant NUNCA passa por aqui; passa pelo cliente do servidor, com RLS.
 */
export function criarClienteAdmin() {
  const chave = process.env.SUPABASE_SECRET_KEY;

  if (!chave) {
    throw new Error(
      'SUPABASE_SECRET_KEY ausente. Painel do Supabase -> Project Settings -> ' +
        'API Keys -> secret key (sb_secret_...). Nunca prefixe com NEXT_PUBLIC_.',
    );
  }

  if (chave.startsWith('sb_publishable_') || chave.includes('"role":"anon"')) {
    throw new Error(
      'SUPABASE_SECRET_KEY contem uma chave publica. A Admin API precisa da ' +
        'chave secreta (sb_secret_...).',
    );
  }

  return createClient(SUPABASE_URL, chave, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
