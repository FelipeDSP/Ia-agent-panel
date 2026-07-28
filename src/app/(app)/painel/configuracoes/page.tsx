import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

import { FormularioConfig } from './formulario';

export default async function PaginaConfiguracoes() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  const { data: tenant } = await supabase
    .from('tenants')
    .select('agente_ativo, debounce_segundos, msg_midia_nao_suportada, msg_fora_escopo')
    .eq('id', usuario.tenantId)
    .maybeSingle();

  if (!tenant) {
    return <div className="text-sm text-destructive">Não foi possível carregar as configurações.</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Configurações</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Comportamento do agente e mensagens de sistema.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Agente e mensagens</CardTitle>
          <CardDescription>
            Modelo e temperatura ficam com a agência e não aparecem aqui.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormularioConfig
            agenteAtivo={tenant.agente_ativo}
            debounce={tenant.debounce_segundos}
            msgMidia={tenant.msg_midia_nao_suportada}
            msgForaEscopo={tenant.msg_fora_escopo}
          />
        </CardContent>
      </Card>
    </div>
  );
}
