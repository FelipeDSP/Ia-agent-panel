import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { definicaoTool } from '@/lib/tools/registro';
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

  const [{ data: tenant }, { data: tools }] = await Promise.all([
    supabase
      .from('tenants')
      .select('agente_ativo, debounce_segundos, msg_midia_nao_suportada, msg_fora_escopo')
      .eq('id', usuario.tenantId)
      .maybeSingle(),
    supabase
      .from('tenant_tools')
      .select('tool_nome, ativo, contratado, config')
      .eq('tenant_id', usuario.tenantId),
  ]);

  if (!tenant) {
    return <Alert variant="destructive">Não foi possível carregar as configurações.</Alert>;
  }

  // Transferência: só é editável se a agência contratou o módulo.
  const toolTransferir = (tools ?? []).find((t) => t.tool_nome === TOOL_TRANSFERIR) ?? null;
  const transferirContratado = Boolean(toolTransferir?.contratado);
  const configTransferir = (toolTransferir?.config ?? {}) as Partial<ConfigTransferir>;
  const horarioTransferir = configTransferir.horario ?? HORARIO_PADRAO;

  // Meus módulos: só os contratados aparecem (módulo não contratado nem existe
  // para o cliente — §5.2). Rótulo/resumo do registry no código.
  const modulos = (tools ?? [])
    .filter((t) => t.contratado)
    .map((t) => {
      const def = definicaoTool(t.tool_nome);
      return {
        tool_nome: t.tool_nome,
        rotulo: def?.rotulo ?? t.tool_nome,
        resumo: def?.resumo ?? '',
        ativo: Boolean(t.ativo),
        temConfigCliente: def?.temConfigCliente ?? false,
      };
    })
    .sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR'));

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
          <CardTitle>Meus módulos</CardTitle>
          <CardDescription>
            O que está incluído no seu plano. Para contratar um módulo novo, fale com a agência.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {modulos.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum módulo contratado ainda.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {modulos.map((m) => (
                <div
                  key={m.tool_nome}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{m.rotulo}</span>
                      <Badge variant={m.ativo ? 'success' : 'secondary'}>
                        {m.ativo ? 'ativo' : 'desligado'}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{m.resumo}</p>
                  </div>
                  {m.temConfigCliente ? (
                    <span className="text-xs text-muted-foreground">Configure abaixo.</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
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
          {transferirContratado ? (
            <FormularioTransferir
              ativo={Boolean(toolTransferir?.ativo)}
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
