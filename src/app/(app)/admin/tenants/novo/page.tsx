import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { exigirSuperAdmin } from '@/lib/auth';

import { FormularioNovoTenant } from './formulario';

export default async function PaginaNovoTenant() {
  await exigirSuperAdmin();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/admin/tenants"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Clientes
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Novo cliente</h1>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Dados do cliente</CardTitle>
        </CardHeader>
        <CardContent>
          <FormularioNovoTenant />
        </CardContent>
      </Card>
    </div>
  );
}
