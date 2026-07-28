import 'server-only';

import { redirect } from 'next/navigation';

import { criarClienteServidor } from './supabase/server';

export type Papel = 'super_admin' | 'tenant_admin';

export type UsuarioAtual = {
  id: string;
  email: string;
  nome: string;
  papel: Papel;
  /** NULL para super_admin: ele nao pertence a tenant nenhum. */
  tenantId: string | null;
};

/**
 * Usuario logado, com papel e tenant vindos do app_metadata do JWT.
 *
 * Regra do CLAUDE.md, e o ponto que sustenta o multi-tenancy inteiro: papel e
 * tenant_id saem SEMPRE daqui. Nunca de body, query string, header ou de uma
 * leitura em usuarios_painel. Essa tabela e projecao do app_metadata, nao
 * fonte da verdade — se as duas divergirem, quem autoriza e o JWT, porque e
 * ele que as policies do Postgres leem.
 *
 * user_metadata seria o campo errado: o proprio usuario pode edita-lo.
 */
export async function obterUsuarioAtual(): Promise<UsuarioAtual | null> {
  const supabase = await criarClienteServidor();

  // getUser() revalida o token no servidor de auth. getSession() so decodifica
  // o cookie e aceitaria um forjado.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  const meta = user.app_metadata as Record<string, unknown>;
  const papel = meta['papel'];
  const tenantId = meta['tenant_id'];

  // Papel invalido e tratado como nao autenticado. Acontece se alguem for
  // criado por fora do fluxo previsto — melhor negar do que assumir um padrao.
  if (papel !== 'super_admin' && papel !== 'tenant_admin') return null;

  // tenant_admin sem tenant nao consegue ver nada mesmo: as policies comparam
  // com NULL e nao casam. Negar aqui torna a falha legivel.
  if (papel === 'tenant_admin' && typeof tenantId !== 'string') return null;

  const nomeMeta = (user.user_metadata as Record<string, unknown>)['nome'];

  return {
    id: user.id,
    email: user.email ?? '',
    nome: typeof nomeMeta === 'string' && nomeMeta ? nomeMeta : (user.email ?? ''),
    papel,
    tenantId: typeof tenantId === 'string' ? tenantId : null,
  };
}

/** Exige sessao valida. Redireciona para /login se nao houver. */
export async function exigirUsuario(): Promise<UsuarioAtual> {
  const usuario = await obterUsuarioAtual();
  if (!usuario) redirect('/login');
  return usuario;
}

/**
 * Exige super_admin.
 *
 * Repetida no Server Component mesmo com o middleware ja filtrando: middleware
 * nao e fronteira de seguranca. Ele nao roda em Server Action invocada
 * diretamente, e o matcher pode ser contornado. A checagem que vale e a que
 * fica junto do acesso ao dado.
 */
export async function exigirSuperAdmin(): Promise<UsuarioAtual> {
  const usuario = await exigirUsuario();
  if (usuario.papel !== 'super_admin') redirect('/painel');
  return usuario;
}

/**
 * Exige tenant_admin com tenant definido, devolvendo o tenantId ja estreitado
 * para string — evita `!` espalhado pelas paginas.
 */
export async function exigirTenantAdmin(): Promise<UsuarioAtual & { tenantId: string }> {
  const usuario = await exigirUsuario();
  if (usuario.papel !== 'tenant_admin' || !usuario.tenantId) redirect('/admin/tenants');
  return { ...usuario, tenantId: usuario.tenantId };
}
