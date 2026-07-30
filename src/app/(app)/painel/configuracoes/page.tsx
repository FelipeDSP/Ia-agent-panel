import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import {
  HORARIO_PADRAO,
  TOOL_TRANSFERIR,
  numeroParaExibir,
  type ConfigTransferir,
} from '@/lib/tools/transferir-humano';

import { FormularioConfig } from './formulario';
import { FormularioTransferir } from './formulario-transferir';

export default async function PaginaConfiguracoes() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  const [{ data: tenant }, { data: toolTransferir }] = await Promise.all([
    supabase
      .from('tenants')
      .select('agente_ativo, debounce_segundos, msg_midia_nao_suportada, msg_fora_escopo')
      .eq('id', usuario.tenantId)
      .maybeSingle(),
    supabase
      .from('tenant_tools')
      .select('ativo, config')
      .eq('tenant_id', usuario.tenantId)
      .eq('tool_nome', TOOL_TRANSFERIR)
      .maybeSingle(),
  ]);

  if (!tenant) {
    return <div className="text-sm text-destructive">Não foi possível carregar as configurações.</div>;
  }

  const configTransferir = (toolTransferir?.config ?? {}) as Partial<ConfigTransferir>;
  const horarioTransferir = configTransferir.horario ?? HORARIO_PADRAO;

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

      <Card>
        <CardHeader>
          <CardTitle>Transferência para atendimento humano</CardTitle>
          <CardDescription>
            Defina quando o agente pode passar a conversa para uma pessoa e como você é avisado.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {toolTransferir ? (
            <FormularioTransferir
              ativo={toolTransferir.ativo}
              horario={horarioTransferir}
              notificarAtual={configTransferir.notificacao?.canal === 'waha'}
              destinoNumero={numeroParaExibir(configTransferir.notificacao?.destino)}
              temSessao={Boolean(configTransferir.notificacao?.sessao)}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              A transferência para atendimento humano ainda não foi habilitada pela agência para
              este cliente. Fale com a agência para ativar.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
