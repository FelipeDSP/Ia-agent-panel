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
  type ConfigTransferir,
} from '@/lib/tools/transferir-humano';
import { TOOL_VENDAS, lerConfigVendas } from '@/lib/tools/vendas-config';
import { lerAvisos } from '@/lib/tools/avisos';
import { lerHorarioAgente } from '@/lib/tenants/horario-agente';

import { FormularioConfig } from './formulario';
import { FormularioAvisos } from './formulario-avisos';
import { FormularioTransferir } from './formulario-transferir';
import { FormularioVendas } from './formulario-vendas';
import { FormularioHorario } from './formulario-horario';
import { ListaModulos, SwitchModulo } from './lista-modulos';
import { Times, type TimeDaTela } from './times';

export default async function PaginaConfiguracoes() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  const [{ data: tenant }, { data: tools }, { data: timesRaw }] = await Promise.all([
    supabase
      .from('tenants')
      .select('agente_ativo, debounce_segundos, msg_midia_nao_suportada, msg_fora_escopo, chatwoot_account_id, horario_agente')
      .eq('id', usuario.tenantId)
      .maybeSingle(),
    supabase
      .from('tenant_tools')
      .select('tool_nome, ativo, contratado, config')
      .eq('tenant_id', usuario.tenantId),
    // `eq('tenant_id')` redundante com a RLS de proposito (regra 6).
    supabase
      .from('tenant_times')
      .select('id, team_id, nome, descricao, padrao, verificado_em, falhou_em')
      .eq('tenant_id', usuario.tenantId)
      .order('padrao', { ascending: false })
      .order('nome'),
  ]);

  if (!tenant) {
    return <Alert variant="destructive">Não foi possível carregar as configurações.</Alert>;
  }

  // Transferência: só é editável se a agência contratou o módulo.
  const toolTransferir = (tools ?? []).find((t) => t.tool_nome === TOOL_TRANSFERIR) ?? null;
  const transferirContratado = Boolean(toolTransferir?.contratado);
  const configTransferir = (toolTransferir?.config ?? {}) as Partial<ConfigTransferir>;
  const times = (timesRaw ?? []) as TimeDaTela[];
  const contaChatwoot = tenant.chatwoot_account_id ? String(tenant.chatwoot_account_id) : null;
  const horarioTransferir = configTransferir.horario ?? HORARIO_PADRAO;

  // Vendas (69): o card só existe para quem contratou. "Passar entrega a um
  // atendente" depende da transferência contratada E ligada — o mesmo dado
  // que a action confere de novo ao salvar.
  const toolVendas = (tools ?? []).find((t) => t.tool_nome === TOOL_VENDAS) ?? null;
  const vendasContratada = Boolean(toolVendas?.contratado);
  const configVendas = lerConfigVendas(toolVendas?.config);
  const transferirDisponivel = transferirContratado && Boolean(toolTransferir?.ativo);
  const linkDisponivel = Boolean((tools ?? []).find((t) => t.tool_nome === 'pagamento')?.contratado);
  const horarioAgente = lerHorarioAgente(tenant.horario_agente);
  // 18/09: um número, uma lista do que avisar — lido das duas configs
  const avisos = lerAvisos(transferirContratado ? configTransferir : null, vendasContratada ? (toolVendas?.config ?? {}) : null, vendasContratada);

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
        <p className="mt-1 text-sm text-muted-foreground">Cada bloco salva sozinho.</p>
      </header>

      {/* 18/09: a tela foi reorganizada. Antes o número do WhatsApp era pedido
          duas vezes (transferência e vendas) e "Fuso horário / Dias / Abre às"
          aparecia duas vezes (horário da loja e horário do atendente). Agora:
          Agente → Módulos → Horário (um só) → Avisos (um só) → Atendimento
          humano → Vendas. */}
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

      {/* O card inteiro some quando não há módulo opcional: lista vazia com
          "nenhum módulo contratado ainda" é ruído. */}
      {modulos.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Meus módulos</CardTitle>
            <CardDescription>Ligue e desligue o que contratou. Para contratar outro, fale com a agência.</CardDescription>
          </CardHeader>
          <CardContent>
            <ListaModulos modulos={modulos} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Horário de atendimento</CardTitle>
          <CardDescription>
            Quando a loja atende. Fora disso o agente avisa que está fechado, fica em silêncio ou
            atende sabendo que está fechado — você escolhe. Sem horário, atende sempre. A transferência
            para humano usa este mesmo horário, salvo se você definir outro lá.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormularioHorario horario={horarioAgente} />
        </CardContent>
      </Card>

      {transferirContratado || vendasContratada ? (
        <Card>
          <CardHeader>
            <CardTitle>Avisos para você</CardTitle>
            <CardDescription>
              Um número, e o que você quer que chegue nele: pedidos de atendimento humano
              {vendasContratada ? ' e as vendas' : ''}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormularioAvisos avisos={avisos} temTransferencia={transferirContratado} temVendas={vendasContratada} />
          </CardContent>
        </Card>
      ) : null}

      {/* Não contratado = o card não existe. */}
      {transferirContratado ? (
        <Card>
          <CardHeader>
            <CardTitle>Atendimento humano</CardTitle>
            <CardDescription>
              Quando alguém pede para falar com uma pessoa, o agente pausa a conversa e ela fica marcada
              no Chatwoot. Aqui você diz quando há alguém para atender e para qual time vai.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {/* O switch vive AQUI, e não na lista de "Meus módulos": este card já
                é o lugar do módulo. O escritor de `ativo` continua sendo um só
                (`alternarModulo`, via SwitchModulo). */}
            <SwitchModulo
              toolNome={TOOL_TRANSFERIR}
              rotulo="Transferir para humano"
              ativo={Boolean(toolTransferir?.ativo)}
              aviso={
                'Quem pedir para falar com uma pessoa continua conversando com o agente, e a ' +
                'conversa não é pausada sozinha — você pausa em Conversas ou no Chatwoot.'
              }
            />

            <FormularioTransferir
              ativo={Boolean(toolTransferir?.ativo)}
              horario={horarioTransferir}
              horarioDaLoja={configTransferir.horario_da_loja === true}
              lojaTemHorario={horarioAgente !== null}
            />

            {/* Os times moram DENTRO do card da transferência: é configuração da
                mesma tool, e rota nova exigiria declaração no registry. */}
            <div className="flex flex-col gap-3 border-t border-border pt-5">
              <div>
                <h3 className="text-sm font-medium">Times do Chatwoot</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Com times cadastrados, o agente escolhe para qual mandar a conversa. Sem
                  nenhum, ele transfere como hoje — pausa e deixa a nota.
                </p>
              </div>
              <Times times={times} contaChatwoot={contaChatwoot} />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {vendasContratada ? (
        <Card>
          <CardHeader>
            <CardTitle>Vendas</CardTitle>
            <CardDescription>
              Como o cliente paga, retirada e o que fazer com pedido de entrega. Os avisos de venda
              estão em “Avisos para você”; ligar e desligar o módulo é em “Meus módulos”.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormularioVendas
              ativo={Boolean(toolVendas?.ativo)}
              config={configVendas}
              transferirDisponivel={transferirDisponivel}
              linkDisponivel={linkDisponivel}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
