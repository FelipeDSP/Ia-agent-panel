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
 * tenant passa pelo cliente do servidor, com RLS.
 *
 * A EXCECAO, e por enquanto e a unica: `tenant_credenciais` (o token do
 * Chatwoot). Aquela tabela e super-admin-only POR DESENHO — a migracao 21a a
 * segregou de `tenants` justamente para o token ficar fora do alcance do
 * tenant_admin, e a unica policy dela e `auth_is_super_admin()`. Ou seja: nao
 * ha "cliente do servidor com RLS" que a leia numa acao de tenant_admin; ler
 * com a sessao dele devolve NULO, e a validacao de time nasceu quebrada por
 * isso (ver `contextoDeVerificacao` em painel/acoes.ts).
 *
 * O que torna a excecao legitima, e as tres condicoes valem juntas:
 *   1. o filtro e por `tenantId` vindo do JWT (`exigirTenantAdmin`), nunca do
 *      formulario — a acao nao consegue pedir a credencial de outro cliente;
 *   2. o token e usado no servidor para chamar o Chatwoot e NAO volta para o
 *      browser, nem no retorno da action nem em mensagem de erro;
 *   3. e a leitura e de UMA coluna de UMA linha, nao um bypass geral de RLS.
 *
 * CONTINUA PROIBIDO: usar este cliente para ler dado de tenant que a RLS
 * entregaria normalmente (produtos, conversas, kb_documentos, tenant_times).
 * Ali o cliente do servidor funciona, e trocar por este so remove a rede de
 * seguranca — o dia em que o filtro explicito tiver um typo, a RLS nao estara
 * la para segurar.
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
