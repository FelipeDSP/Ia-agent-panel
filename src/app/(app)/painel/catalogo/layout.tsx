import { exigirTenantAdmin } from '@/lib/auth';
import { exigirToolDaRota } from '@/lib/tools/contratacao';

/**
 * Guard de rota do Catálogo.
 *
 * Fica no layout e não na página porque o layout cobre a subárvore inteira —
 * qualquer sub-rota nova nasce protegida sem ninguém precisar lembrar.
 *
 * Não vai no middleware: ele roda a cada request, e uma query a `tenant_tools`
 * ali seria cobrada em toda navegação, inclusive nas telas que não são de tool.
 *
 * O caminho é literal e não `usePathname` — layout é Server Component. A tool
 * dona sai do registry (`toolDaRota`), então mudar a declaração muda o guard.
 */
export default async function LayoutCatalogo({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const usuario = await exigirTenantAdmin();
  await exigirToolDaRota(usuario.tenantId, '/painel/catalogo');
  return <>{children}</>;
}
