import { redirect } from 'next/navigation';

import { obterUsuarioAtual } from '@/lib/auth';

/**
 * Raiz: manda cada papel para a sua area. Nao renderiza nada.
 */
export default async function Home() {
  const usuario = await obterUsuarioAtual();

  if (!usuario) redirect('/login');
  redirect(usuario.papel === 'super_admin' ? '/admin/tenants' : '/painel');
}
