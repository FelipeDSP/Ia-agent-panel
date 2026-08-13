import { Alert } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { definicaoTool, grupoTool } from '@/lib/tools/registro';
import {
  HORARIO_PADRAO,
  TOOL_TRANSFERIR,
  numeroParaExibir,
  type ConfigTransferir,
} from '@/lib/tools/transferir-humano';

import { FormularioConfig } from './formulario';
import { FormularioTransferir } from './formulario-transferir';
import { ListaModulos } from './lista-modulos';

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

  // Meus módulos: só o que o cliente PODE AGIR.
  //
  // Duas exclusões, uma regra. Não contratado some (nem existe para ele — §5.2).
  // Padrão some também: `busca_conhecimento` e `resolver_conversa` ele não
  // desliga nem configura, então o switch só oferecia uma decisão que não é
  // dele. Configurável (transferir_humano) não entra nesta lista porque tem card
  // próprio, com formulário e sem switch.
  //
  // Sobra a lista de contratáveis contratados — a única onde o switch representa
  // uma escolha real.
  const modulos = (tools ?? [])
    .filter((t) => t.contratado && grupoTool(t.tool_nome) === 'contratavel')
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

      {/* O card inteiro some quando não há módulo opcional. Lista vazia com
          "nenhum módulo contratado ainda" é ruído: não há nada a fazer ali, e
          hoje é o caso de 3 dos 4 clientes, que só têm o padrão do produto. */}
      {modulos.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Meus módulos</CardTitle>
            <CardDescription>
              O que está incluído no seu plano. Para contratar um módulo novo, fale com a agência.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ListaModulos modulos={modulos} />
          </CardContent>
        </Card>
      ) : null}

      {/* Não contratado = o card não existe. O texto "fale com a agência para
          ativar" que ficava aqui mostrava ao cliente uma configuração que ele
          não tem — a confusão que a regra elimina. */}
      {transferirContratado ? (
        <Card>
          <CardHeader>
            <CardTitle>Transferência para atendimento humano</CardTitle>
            <CardDescription>
              Defina quando o agente pode passar a conversa para uma pessoa e como você é avisado.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormularioTransferir
              ativo={Boolean(toolTransferir?.ativo)}
              horario={horarioTransferir}
              notificarAtual={configTransferir.notificacao?.canal === 'waha'}
              destinoNumero={numeroParaExibir(configTransferir.notificacao?.destino)}
              temSessao={Boolean(configTransferir.notificacao?.sessao)}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
