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
import { ListaModulos, SwitchModulo } from './lista-modulos';

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
  // dele.
  //
  // `transferir_humano` é desligável mas não entra nesta lista: tem card
  // próprio, e o switch dele mora lá. Item genérico na lista mais card de config
  // embaixo seria a mesma coisa dita duas vezes.
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
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Agente e mensagens</CardTitle>
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
            <CardDescription>Para contratar outro, fale com a agência.</CardDescription>
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
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {/* O switch vive AQUI, e não na lista de "Meus módulos": este card já
                é o lugar do módulo, com nome e explicação. Um item genérico na
                lista mais um card de config embaixo seria a mesma coisa dita
                duas vezes. O escritor de `ativo` continua sendo um só
                (`alternarModulo`, via SwitchModulo). */}
            <SwitchModulo
              toolNome={TOOL_TRANSFERIR}
              rotulo="Transferir para humano"
              ativo={Boolean(toolTransferir?.ativo)}
              /*
               * O aviso agora aparece só com o módulo DESLIGADO, e por isso está
               * no presente: descreve o estado em que a pessoa está, não uma
               * hipótese. Ligado, o switch verde já diz tudo e o parágrafo era
               * texto permanente sobre algo que não estava acontecendo.
               */
              aviso={
                'Quem pedir para falar com uma pessoa continua conversando com o agente, e a ' +
                'conversa não é pausada sozinha — você pausa em Conversas ou no Chatwoot.'
              }
            />

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
