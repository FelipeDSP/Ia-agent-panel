import { exigirSuperAdmin } from '@/lib/auth';

/**
 * Portao de /admin/*. Um tenant_admin que digitar a URL direta cai aqui e e
 * redirecionado, mesmo que o middleware tenha deixado passar.
 */
export default async function LayoutAdmin({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await exigirSuperAdmin();
  return <>{children}</>;
}
