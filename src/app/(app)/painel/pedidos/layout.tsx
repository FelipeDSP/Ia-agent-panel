import { exigirTenantAdmin } from '@/lib/auth';
import { exigirToolDaRota } from '@/lib/tools/contratacao';

/**
 * Guard de rota dos Pedidos. Cobre `/painel/pedidos` e `/painel/pedidos/[id]`.
 *
 * Ver o comentário do layout do Catálogo para o porquê de ser layout e não
 * middleware nem página.
 */
export default async function LayoutPedidos({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const usuario = await exigirTenantAdmin();
  await exigirToolDaRota(usuario.tenantId, '/painel/pedidos');
  return <>{children}</>;
}
