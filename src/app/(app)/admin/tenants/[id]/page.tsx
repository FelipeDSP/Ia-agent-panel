import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PromptEditor, type VersaoPrompt } from '@/components/prompt-editor';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirSuperAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { urlDoWebhookNoAgente } from '@/lib/pagamento/asaas-tenant';
import { desdeJanela } from '@/lib/retencao';
import { normalizarRuntime, roteiroDaTroca, urlsDoBot } from '@/lib/agente/runtime';
import { definicaoTool, grupoTool } from '@/lib/tools/registro';
import { TOOL_TRANSFERIR, type ConfigTransferir } from '@/lib/tools/transferir-humano';
import { TOOL_VENDAS, lerConfigVendas } from '@/lib/tools/vendas-config';

import {
  BotaoSuspensao,
  FormAsaas,
  FormChatwoot,
  FormConfigSuper,
  FormConvite,
  FormRuntime,
  FormTransferirHumano,
  FormVendasAgencia,
  GerenciarAdmins,
  GestaoModulos,
  ZonaPerigoExcluir,
  type ModuloAdmin,
} from './componentes';

export default async function PaginaDetalheTenant({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await exigirSuperAdmin();
  const { id } = await params;

  const supabase = await criarClienteServidor();

  const { data: tenant } = await supabase
    .from('tenants')
    .select(
      'id, nome, slug, ativo, agente_ativo, agente_runtime, chatwoot_account_id, chatwoot_inbox_id, chatwoot_url, system_prompt, modelo, temperatura, debounce_segundos, memoria_silencio_minutos, pagamento_formas',
    )
    .eq('id', id)
    .is('deletado_em', null)
    .maybeSingle();

  if (!tenant) notFound();

  // Histórico de prompt + admins + conversas recentes + tools (transferência e
  // catálogo/estado dos módulos).
  const [
    { data: versoesRaw },
    { data: admins },
    { data: conversas },
    { data: toolTransferir },
    { data: catalogo },
    { data: toolsTenant },
    { data: credAsaas },
    { data: toolVendas },
  ] = await Promise.all([
    supabase
      .from('prompt_versoes')
      .select('id, conteudo, criado_em, criado_por')
      .eq('tenant_id', id)
      .order('criado_em', { ascending: false }),
    supabase.from('usuarios_painel').select('id, nome, email').eq('tenant_id', id),
    supabase
      // View (migracao 51). O super_admin passa pela mesma policy — a diferenca
      // e que `auth_is_super_admin()` a satisfaz para qualquer tenant.
      .from('conversas_painel')
      .select('conversation_id, contact_name, phone, status_efetivo, atualizado_em')
      .eq('tenant_id', id)
      .gte('atualizado_em', desdeJanela())
      .order('atualizado_em', { ascending: false })
      .limit(30),
    supabase
      .from('tenant_tools')
      .select('ativo, workflow_id, descricao, config')
      .eq('tenant_id', id)
      .eq('tool_nome', TOOL_TRANSFERIR)
      .maybeSingle(),
    supabase
      .from('catalogo_tools')
      .select('tool_nome, nome_exibicao, descricao_padrao, ativo')
      .eq('ativo', true)
      .order('tool_nome'),
    supabase.from('tenant_tools').select('tool_nome, contratado, ativo').eq('tenant_id', id),
    // Só a PRESENÇA de cada chave chega à tela; o valor nunca sai daqui.
    supabase
      .from('tenant_credenciais')
      .select('asaas_ambiente, asaas_api_key_sandbox, asaas_api_key_producao, asaas_webhook_token_sandbox, asaas_webhook_token_producao')
      .eq('tenant_id', id)
      .maybeSingle(),
    supabase
      .from('tenant_tools')
      .select('ativo, contratado, config')
      .eq('tenant_id', id)
      .eq('tool_nome', TOOL_VENDAS)
      .maybeSingle(),
  ]);

  const configTransferir = (toolTransferir?.config ?? {}) as Partial<ConfigTransferir>;
  const configVendas = lerConfigVendas(toolVendas?.config);

  // Cruza o catálogo (o que existe) com o estado do tenant (o que ele tem). O
  // rótulo/resumo vêm do registry no código; o catálogo é só a lista + fallback.
  const estadoPorTool = new Map(
    (toolsTenant ?? []).map((t) => [t.tool_nome, { contratado: Boolean(t.contratado), ativo: Boolean(t.ativo) }]),
  );
  // Dependências entre módulos. Contratar o dependente sem o pré-requisito não
  // quebra nada — só produz um módulo mudo, e isso é fácil de vender sem querer.
  // O aviso é do ADMIN, não do cliente: quem contrata é a agência.
  const DEPENDE_DE: Record<string, { de: string; texto: string }> = {
    foto_produto: {
      de: 'vendas',
      texto:
        'Precisa do módulo Vendas: a foto é identificada pelo produto, e o agente só ' +
        'obtém essa identificação pelo catálogo. Contratado sozinho, não faz nada.',
    },
  };

  const todosModulos: ModuloAdmin[] = (catalogo ?? []).map((c) => {
    const def = definicaoTool(c.tool_nome);
    const estado = estadoPorTool.get(c.tool_nome);
    const dep = DEPENDE_DE[c.tool_nome];
    const aviso = dep && !estadoPorTool.get(dep.de)?.contratado ? dep.texto : null;
    return {
      tool_nome: c.tool_nome,
      rotulo: def?.rotulo ?? c.nome_exibicao,
      resumo: def?.resumo ?? (c.descricao_padrao ?? ''),
      temConfigCliente: def?.temConfigCliente ?? false,
      grupo: grupoTool(c.tool_nome),
      // Sem entrada no registry: cai em `contratavel` (aparece e é desligável),
      // mas com rótulo e resumo vindos do catálogo em vez do código. O aviso é
      // porque isso se descobre pela AUSÊNCIA — e ausência não avisa.
      semRegistry: !def,
      contratado: estado?.contratado ?? false,
      ativo: estado?.ativo ?? false,
      aviso,
    };
  });

  // A decisão comercial fica em cima, sozinha. Padrão e configurável descem para
  // a seção recolhida: nenhum dos dois é coisa que a agência vende, e ambos
  // competiam por atenção com o que é.
  const modulos = todosModulos.filter((m) => m.grupo === 'contratavel');
  const modulosPadrao = todosModulos.filter((m) => m.grupo !== 'contratavel');

  // Resolve nome do autor de cada versão (poucas linhas; map simples).
  const autores = new Map((admins ?? []).map((a) => [a.email, a.nome]));
  const versoes: VersaoPrompt[] = (versoesRaw ?? []).map((v) => ({
    id: v.id,
    conteudo: v.conteudo,
    criado_em: v.criado_em,
    autor: null, // criado_por é uuid; nome do autor não é crítico aqui
  }));
  void autores;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/admin/tenants"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            ← Clientes
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{tenant.nome}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{tenant.slug}</p>
        </div>
        <div className="flex gap-2">
          <Badge variant={tenant.ativo ? 'success' : 'secondary'}>
            {tenant.ativo ? 'ativo' : 'suspenso'}
          </Badge>
          <Badge variant={tenant.agente_ativo ? 'success' : 'warning'}>
            {tenant.agente_ativo ? 'agente ligado' : 'agente desligado'}
          </Badge>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Prompt</CardTitle>
          <CardDescription>
            Alterações ficam no histórico e podem ser revertidas.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PromptEditor
            tenantId={tenant.id}
            promptAtual={tenant.system_prompt ?? ''}
            versoes={versoes}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Configuração</CardTitle>
            <CardDescription>Modelo, temperatura, debounce, memória e formas de pagamento — só a agência.</CardDescription>
          </CardHeader>
          <CardContent>
            <FormConfigSuper
              tenantId={tenant.id}
              nome={tenant.nome}
              modelo={tenant.modelo}
              temperatura={Number(tenant.temperatura)}
              debounce={tenant.debounce_segundos}
              memoriaSilencio={Number(tenant.memoria_silencio_minutos ?? 40)}
              pagamentoFormas={(tenant.pagamento_formas as string[] | null) ?? ['PIX']}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Chatwoot</CardTitle>
            <CardDescription>
              {/*
                CONTA E CAIXA JUNTAS. Desde a migração 54 o roteamento é pelo PAR:
                dizer só a conta descreveria uma ligação que não existe sozinha, e
                é justamente a caixa que decide qual agente responde quando duas
                convivem na mesma conta.
              */}
              {tenant.chatwoot_account_id
                ? `Conectado à conta ${tenant.chatwoot_account_id}, caixa ${tenant.chatwoot_inbox_id}.`
                : 'Ainda não conectado.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormChatwoot
              tenantId={tenant.id}
              accountId={tenant.chatwoot_account_id}
              inboxId={tenant.chatwoot_inbox_id}
              url={tenant.chatwoot_url}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quem atende</CardTitle>
            <CardDescription>
              {normalizarRuntime(tenant.agente_runtime) === 'codigo'
                ? 'O serviço em código (agente/) responde esta conta.'
                : 'O n8n responde esta conta.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {(() => {
              const urls = urlsDoBot(process.env, tenant.chatwoot_inbox_id);
              const atual = normalizarRuntime(tenant.agente_runtime);
              return (
                <FormRuntime
                  tenantId={tenant.id}
                  atual={atual}
                  urls={urls}
                  roteiroParaCodigo={roteiroDaTroca('n8n', 'codigo', urls)}
                  roteiroParaN8n={roteiroDaTroca('codigo', 'n8n', urls)}
                />
              );
            })()}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pagamento (Asaas)</CardTitle>
            <CardDescription>
              {credAsaas?.asaas_ambiente
                ? `Ambiente ${credAsaas.asaas_ambiente}; chave ${(credAsaas.asaas_ambiente === 'producao' ? credAsaas.asaas_api_key_producao : credAsaas.asaas_api_key_sandbox) ? 'configurada' : 'não configurada'}.`
                : 'Nenhuma credencial Asaas ainda.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormAsaas
              tenantId={tenant.id}
              ambiente={(credAsaas?.asaas_ambiente as 'sandbox' | 'producao' | null) ?? 'sandbox'}
              temChaveSandbox={Boolean(credAsaas?.asaas_api_key_sandbox)}
              temChaveProducao={Boolean(credAsaas?.asaas_api_key_producao)}
              temTokenSandbox={Boolean(credAsaas?.asaas_webhook_token_sandbox)}
              temTokenProducao={Boolean(credAsaas?.asaas_webhook_token_producao)}
              urlWebhook={urlDoWebhookNoAgente(process.env)}
              contratado={estadoPorTool.get('pagamento')?.contratado === true}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Admin do cliente</CardTitle>
            <CardDescription>
              {admins && admins.length > 0
                ? `${admins.length} usuário(s) vinculado(s).`
                : 'Nenhum admin convidado ainda.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <GerenciarAdmins
              tenantId={tenant.id}
              admins={(admins ?? []).map((a) => ({ id: a.id, email: a.email, nome: a.nome }))}
            />
            <FormConvite tenantId={tenant.id} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Situação</CardTitle>
            <CardDescription>Suspender interrompe o agente.</CardDescription>
          </CardHeader>
          <CardContent>
            <BotaoSuspensao tenantId={tenant.id} ativo={tenant.ativo} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Módulos</CardTitle>
            <CardDescription>
              Contratar liga o módulo para este cliente (a Ordem de Serviço vira
              estado do sistema). Desligar/ligar e configurar é com o cliente.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <GestaoModulos tenantId={tenant.id} modulos={modulos} padrao={modulosPadrao} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Tool: transferência para humano</CardTitle>
            <CardDescription>
              Infra da tool. O cliente define horário e destino no painel dele;
              {toolTransferir
                ? toolTransferir.ativo
                  ? ' está ligada por ele.'
                  : ' ainda desligada por ele.'
                : ' ainda não habilitada.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormTransferirHumano
              tenantId={tenant.id}
              sessao={configTransferir.notificacao?.sessao ?? ''}
              habilitada={Boolean(toolTransferir)}
            />
          </CardContent>
        </Card>

        {/* Só com vendas contratada: sem a linha não há onde gravar, e a
            action orienta a contratar primeiro. */}
        {toolVendas?.contratado ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Tool: vendas — aviso ao dono</CardTitle>
              <CardDescription>
                Infra do aviso de venda. O cliente escolhe formas de pagar, eventos e número em
                Configurações → Vendas; aqui só a sessão do WAHA por onde o aviso sai.
                {configVendas.notificacao.destino
                  ? ` Destino do cliente: ${configVendas.notificacao.destino}.`
                  : ' O cliente ainda não informou o número.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FormVendasAgencia tenantId={tenant.id} sessao={configVendas.notificacao.sessao ?? ''} />
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conversas</CardTitle>
          <CardDescription>
            {conversas && conversas.length > 0
              ? `${conversas.length} conversa(s) mais recente(s).`
              : 'Nenhuma conversa ainda.'}
          </CardDescription>
        </CardHeader>
        {conversas && conversas.length > 0 ? (
          <CardContent className="flex flex-col">
            {conversas.map((c) => (
              <div
                key={c.conversation_id}
                className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 border-b border-border py-2 text-sm last:border-0"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{c.contact_name ?? 'Sem nome'}</span>
                  {c.phone ? <span className="ml-2 text-muted-foreground">{c.phone}</span> : null}
                </span>
                {/* Os turnos do agente nesta conversa (só existem para tenant em código). */}
                <Link
                  href={`/admin/agente?tenant=${tenant.id}&conversa=${c.conversation_id}&horas=168`}
                  className="text-xs text-primary underline-offset-4 hover:underline"
                >
                  turnos
                </Link>
                <Badge
                  variant={
                    c.status_efetivo === 'pausado'
                      ? 'warning'
                      : c.status_efetivo === 'resolvido'
                        ? 'secondary'
                        : 'success'
                  }
                >
                  {c.status_efetivo}
                </Badge>
                <span className="text-right text-xs text-muted-foreground">
                  {c.atualizado_em
                    ? new Date(c.atualizado_em).toLocaleString('pt-BR', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })
                    : '—'}
                </span>
              </div>
            ))}
          </CardContent>
        ) : null}
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Zona de perigo</CardTitle>
          <CardDescription>
            Excluir o cliente. Reversível (soft delete), mas trate como ação séria.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ZonaPerigoExcluir tenantId={tenant.id} nome={tenant.nome} />
        </CardContent>
      </Card>
    </div>
  );
}
