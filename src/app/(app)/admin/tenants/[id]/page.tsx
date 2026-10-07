import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PromptEditor, type VersaoPrompt } from '@/components/prompt-editor';
import { Ajuda } from '@/components/ui/ajuda';
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
import { urlDoBot } from '@/lib/agente/runtime';
import { definicaoTool, grupoTool } from '@/lib/tools/registro';
import { TOOL_TRANSFERIR, type ConfigTransferir } from '@/lib/tools/transferir-humano';
import { TOOL_VENDAS, lerConfigVendas } from '@/lib/tools/vendas-config';

import {
  BotaoSuspensao,
  FormAsaas,
  FormChatwoot,
  FormConfigSuper,
  FormConvite,
  UrlDoBot,
  FormTransferirHumano,
  FormVendasAgencia,
  GerenciarAdmins,
  GestaoModulos,
  LimiteAgentes,
  ZonaPerigoExcluir,
  type ModuloAdmin,
} from './componentes';

/**
 * AS ABAS SÃO UMA LISTA SÓ, e tanto a navegação quanto o conteúdo saem dela.
 *
 * Em 18/09 a página virou duas abas — Operação e Cadastro — organizadas por
 * FREQUÊNCIA de uso. A ideia estava certa e o resultado não: "Cadastro" juntou
 * oito assuntos que não se parecem (modelo do agente, conexão do Chatwoot,
 * credencial do Asaas, usuários, suspensão, módulos, WAHA legado, exclusão) e
 * "Operação" terminava com uma lista de 30 conversas, que não é operação — é
 * navegação de dados. Para conectar o Chatwoot, o nome da aba não ajudava a
 * decidir entre as duas.
 *
 * Agora a divisão é por ASSUNTO, e os nomes dizem o assunto. Quem chega
 * sabendo o que quer fazer acha pelo nome, sem abrir as duas.
 *
 * Nav e conteúdo derivam da MESMA lista de propósito: aba declarada sem painel
 * (ou painel sem aba) é o tipo de divergência que o `teste:ficha-do-cliente`
 * reprova — é a regra "derive o derivado" do CLAUDE.md aplicada à tela.
 */
const ABAS = [
  ['prompt', 'Prompt'],
  ['conexao', 'Conexão'],
  ['modulos', 'Módulos'],
  ['pessoas', 'Pessoas'],
  ['avancado', 'Avançado'],
] as const;

type Aba = (typeof ABAS)[number][0];

/**
 * Link antigo continua funcionando. `?aba=cadastro` estava em anotação e em
 * conversa; cair no default calado seria o usuário achando que a tela mudou de
 * lugar sozinha.
 */
const APELIDOS: Record<string, Aba> = { operacao: 'prompt', cadastro: 'conexao' };

function resolverAba(valor: string | undefined): Aba {
  if (!valor) return 'prompt';
  if (ABAS.some(([c]) => c === valor)) return valor as Aba;
  return APELIDOS[valor] ?? 'prompt';
}

export default async function PaginaDetalheTenant({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ aba?: string }>;
}) {
  await exigirSuperAdmin();
  const { id } = await params;
  const aba = resolverAba((await searchParams)?.aba);

  const supabase = await criarClienteServidor();

  const { data: tenant } = await supabase
    .from('tenants')
    .select(
      'id, nome, slug, ativo, agente_ativo, chatwoot_account_id, chatwoot_inbox_id, chatwoot_url, system_prompt, modelo, temperatura, debounce_segundos, memoria_silencio_minutos, pagamento_formas',
    )
    .eq('id', id)
    .is('deletado_em', null)
    .maybeSingle();

  if (!tenant) notFound();

  const [
    { data: versoesRaw },
    { data: admins },
    { count: conversasNaJanela },
    { data: pausadas },
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
    supabase.from('usuarios_painel').select('id, nome, email, papel, ativo').eq('tenant_id', id),
    // 06/10: a lista de 30 conversas saiu. Ela ocupava a maior parte da aba e
    // só repetia, com nome e telefone, o que a página de turnos já mostra
    // filtrada. O que NÃO estava em lugar nenhum é o que sobrou aqui: quantas
    // conversas houve na janela, e QUAIS estão pausadas — pausada é a única
    // que pede ação de alguém.
    supabase
      // View (migração 51). O super_admin passa pela mesma policy — a diferença
      // é que `auth_is_super_admin()` a satisfaz para qualquer tenant.
      .from('conversas_painel')
      .select('conversation_id', { count: 'exact', head: true })
      .eq('tenant_id', id)
      .gte('atualizado_em', desdeJanela()),
    supabase
      .from('conversas_painel')
      .select('conversation_id, contact_name, phone, atualizado_em')
      .eq('tenant_id', id)
      .eq('status_efetivo', 'pausado')
      .order('atualizado_em', { ascending: false })
      .limit(10),
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

  // O teto de agentes em consulta SEPARADA, de propósito: `max_agentes` nasce
  // na migração 81, e painel e banco são deploys independentes neste projeto.
  // Junto no `select` do tenant, um painel novo contra um banco sem a 81
  // derrubaria a ficha INTEIRA de todo cliente. Separado, a aba Pessoas diz o
  // que falta e o resto da tela continua de pé.
  const { data: limiteRaw, error: erroLimite } = await supabase
    .from('tenants')
    .select('max_agentes')
    .eq('id', id)
    .maybeSingle();
  const temLimite = !erroLimite;
  const maxAgentes = Number(limiteRaw?.max_agentes ?? 0);

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

  const versoes: VersaoPrompt[] = (versoesRaw ?? []).map((v) => ({
    id: v.id,
    conteudo: v.conteudo,
    criado_em: v.criado_em,
    autor: null, // criado_por é uuid; nome do autor não é crítico aqui
  }));

  const equipe = (admins ?? []).map((a) => ({ id: a.id, email: a.email, nome: a.nome, papel: a.papel, ativo: a.ativo }));
  const donos = equipe.filter((u) => u.papel === 'tenant_admin');
  const agentes = equipe.filter((u) => u.papel === 'tenant_agente');
  const agentesAtivos = agentes.filter((u) => u.ativo !== false).length;
  const lotado = temLimite && agentesAtivos >= maxAgentes;

  const contratouPagamento = estadoPorTool.get('pagamento')?.contratado === true;
  const temWahaLegado = Boolean(configTransferir.notificacao?.sessao || configVendas.notificacao.sessao);

  const paineis: Record<Aba, React.ReactNode> = {
    prompt: (
      <>
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-1.5">
              Prompt
              <Ajuda titulo="Prompt">
                <strong>Aqui vai QUEM o agente é e COMO ele se comporta:</strong> tom de voz, regras e o
                que ele nunca deve fazer.
                <br />
                <br />
                Preço, horário, endereço, entrega e pagamento ficam melhor na base de conhecimento — lá
                o cliente atualiza sem mexer no prompt, e o agente busca quando precisa.
                <br />
                <br />
                Toda alteração vira uma versão no histórico e pode ser revertida.
              </Ajuda>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PromptEditor
              tenantId={tenant.id}
              promptAtual={tenant.system_prompt ?? ''}
              versoes={versoes}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Atividade</CardTitle>
            <CardDescription>
              {conversasNaJanela
                ? `${conversasNaJanela} conversa(s) com atividade na janela de retenção.`
                : 'Nenhuma conversa na janela de retenção.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Link
              href={`/admin/agente?tenant=${tenant.id}&horas=168`}
              className="text-sm text-primary underline-offset-4 hover:underline"
            >
              Ver os turnos deste cliente →
            </Link>

            {pausadas && pausadas.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  Conversas pausadas ({pausadas.length})
                  <Ajuda titulo="Conversas pausadas">
                    Pausada quer dizer que <strong>um atendente humano assumiu</strong> e o agente parou
                    de responder naquela conversa. Ela volta sozinha quando o cliente escreve de novo
                    depois do silêncio configurado, ou quando a conversa é resolvida no Chatwoot.
                    <br />
                    <br />
                    Está aqui porque é a única situação desta tela que pode pedir ação de alguém.
                  </Ajuda>
                </p>
                {pausadas.map((c) => (
                  <div
                    key={c.conversation_id}
                    className="flex items-center justify-between gap-4 border-b border-border py-1.5 text-sm last:border-0"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{c.contact_name ?? 'Sem nome'}</span>
                      {c.phone ? <span className="ml-2 text-muted-foreground">{c.phone}</span> : null}
                    </span>
                    <Link
                      href={`/admin/agente?tenant=${tenant.id}&conversa=${c.conversation_id}&horas=168`}
                      className="shrink-0 text-xs text-primary underline-offset-4 hover:underline"
                    >
                      turnos
                    </Link>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Nenhuma conversa pausada.</p>
            )}
          </CardContent>
        </Card>
      </>
    ),

    conexao: (
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-1.5">
              Chatwoot
              <Ajuda titulo="Chatwoot">
                <strong>A caixa (inbox_id) é o que roteia.</strong> O agente é ligado a uma caixa, não à
                conta — por isso duas caixas da mesma conta podem ter agentes diferentes.
                <br />
                <br />
                Este campo <strong>não é conferido</strong> contra o Chatwoot. Se o número estiver
                errado, nada dá erro aqui: o agente simplesmente para de responder nessa caixa, calado.
                <br />
                <br />
                Confira em Configurações → Caixas de entrada, na URL{' '}
                <code>/app/accounts/&lt;conta&gt;/settings/inboxes/&lt;caixa&gt;</code>.
              </Ajuda>
            </CardTitle>
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
            <CardTitle className="flex flex-wrap items-center gap-1.5">
              Agent Bot
              <Ajuda titulo="Agent Bot">
                No Chatwoot: <strong>Configurações → Bots → o bot da conta → outgoing_url</strong>.
                <br />
                <br />A mesma URL serve para todos os clientes; conta e caixa vêm do corpo do webhook.
              </Ajuda>
            </CardTitle>
            <CardDescription>Aponte o bot do Chatwoot para esta URL.</CardDescription>
          </CardHeader>
          <CardContent>
            <UrlDoBot url={urlDoBot(process.env)} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-1.5">
              Pagamento (Asaas)
              <Ajuda titulo="Pagamento (Asaas)">
                A URL da API é derivada do ambiente, e a chave tem de ser do mesmo ambiente — chave de
                sandbox em produção não dá erro de cadastro, dá erro na hora de cobrar.
                <br />
                <br />
                Sandbox começa com <code>$aact_hmlg_</code>.
                <br />
                <br />O webhook é como o Asaas avisa o agente quando o cliente paga. Destino:{' '}
                <code>{urlDoWebhookNoAgente(process.env)}</code>.
              </Ajuda>
            </CardTitle>
            <CardDescription>
              {credAsaas?.asaas_ambiente
                ? `Ambiente ${credAsaas.asaas_ambiente}; chave ${(credAsaas.asaas_ambiente === 'producao' ? credAsaas.asaas_api_key_producao : credAsaas.asaas_api_key_sandbox) ? 'configurada' : 'não configurada'}.`
                : 'Nenhuma credencial Asaas ainda.'}
              {contratouPagamento ? null : ' O módulo Pagamento não está contratado — a credencial pode ser salva, mas o agente só gera link depois de contratar.'}
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
              contratado={contratouPagamento}
            />
          </CardContent>
        </Card>
      </div>
    ),

    modulos: (
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-1.5">
            Módulos
            <Ajuda titulo="Módulos">
              <strong>Contratar</strong> liga o módulo para este cliente — a Ordem de Serviço vira
              estado do sistema.
              <br />
              <br />
              Depois disso, <strong>ligar/desligar e configurar é com o cliente</strong>, no painel
              dele.
              <br />
              <br />
              Descontratar esconde a tela, <strong>nunca apaga dado</strong>: produtos, pedidos e fotos
              ficam onde estão, e recontratar devolve tudo.
            </Ajuda>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <GestaoModulos tenantId={tenant.id} modulos={modulos} padrao={modulosPadrao} />
        </CardContent>
      </Card>
    ),

    pessoas: (
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-1.5">
              Dono da conta
              <Ajuda titulo="Dono da conta">
                O <strong>admin</strong> administra a conta inteira: prompt, catálogo, base,
                configurações — e, quando houver agentes, é ele quem cria as funções e decide o que
                cada pessoa pode fazer.
                <br />
                <br />
                Quem convida admin é a <strong>agência</strong>. Agente, não: esse o próprio cliente
                convida, dentro do limite que você definir aqui.
              </Ajuda>
            </CardTitle>
            <CardDescription>
              {donos.length > 0 ? `${donos.length} admin(s) vinculado(s).` : 'Nenhum admin convidado ainda.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <GerenciarAdmins tenantId={tenant.id} admins={donos} />
            <FormConvite tenantId={tenant.id} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-1.5">
              Agentes da conta
              <Ajuda titulo="Agentes da conta">
                Agente é quem o cliente põe para trabalhar no painel dele — e só faz o que a
                <strong> função</strong> dele permitir (ver conversas, marcar pedido, editar
                catálogo…). O cliente monta as funções; você define{' '}
                <strong>quantos agentes</strong> a conta pode ter.
                <br />
                <br />
                <strong>Senha ninguém digita por ninguém.</strong> "Reenviar link" gera um link de
                definição de senha para a pessoa usar — é como o acesso nasce e é como ele se
                recupera.
                <br />
                <br />
                Baixar o limite não desativa ninguém: só impede convite novo.
              </Ajuda>
            </CardTitle>
            <CardDescription>
              {temLimite
                ? `${agentesAtivos} de ${maxAgentes} assento(s) em uso.`
                : 'A migração 81 ainda não foi aplicada — o limite de agentes não existe neste banco.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {temLimite ? (
              <>
                <LimiteAgentes tenantId={tenant.id} limite={maxAgentes} emUso={agentesAtivos} />
                <GerenciarAdmins tenantId={tenant.id} admins={agentes} />
                <FormConvite
                  tenantId={tenant.id}
                  papel="tenant_agente"
                  rotulo="agente"
                  bloqueio={
                    maxAgentes === 0
                      ? 'Esta conta não tem agentes contratados. Defina o limite acima para liberar.'
                      : lotado
                        ? `Todos os ${maxAgentes} assento(s) estão em uso. Aumente o limite ou remova alguém.`
                        : null
                  }
                />
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    ),

    avancado: (
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-1.5">
              Configuração do agente
              <Ajuda titulo="Configuração do agente">
                <strong>Memória</strong> é o silêncio na conversa a partir do qual o agente recomeça sem
                o histórico. Padrão 40 minutos.
                <br />
                <br />
                <strong>Formas de pagamento</strong>: com mais de uma, o cliente escolhe entre o que a
                conta Asaas tem habilitado. Boleto não combina com a janela de 30 min do link.
                <br />
                <br />
                Nada disto aparece para o cliente — é só da agência.
              </Ajuda>
            </CardTitle>
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

        {/* 06/10: o WAHA virou legado em 17/09 (migração 70: o aviso ao dono sai
            pela inbox do próprio agente). Ocupava um card inteiro, com dois
            botões Salvar, gastando quatro linhas para explicar por que você
            provavelmente NÃO deve usá-lo. Agora nasce fechado, e só nasce aberto
            para quem de fato ainda tem uma sessão preenchida. */}
        <Card>
          <CardContent className="pt-6">
            <details open={temWahaLegado}>
              <summary className="cursor-pointer text-sm font-medium">
                Avisos por WAHA (legado){temWahaLegado ? ' — em uso neste cliente' : ''}
              </summary>
              <div className="mt-4 flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                  O cliente escolhe número e eventos em Configurações → Avisos, e o aviso sai pela inbox
                  do próprio agente no Chatwoot. Só preencha uma sessão aqui se ESTE cliente ainda avisa
                  pelo WAHA — preenchida, o aviso vai por ela.
                  {configTransferir.notificacao?.destino || configVendas.notificacao.destino
                    ? ` Número do cliente: ${configVendas.notificacao.destino ?? configTransferir.notificacao?.destino}.`
                    : ' O cliente ainda não informou o número.'}
                </p>
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <p className="text-sm font-medium">Transferência para humano</p>
                    <FormTransferirHumano
                      tenantId={tenant.id}
                      sessao={configTransferir.notificacao?.sessao ?? ''}
                      habilitada={Boolean(toolTransferir)}
                    />
                  </div>
                  {toolVendas?.contratado ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm font-medium">Aviso de venda</p>
                      <FormVendasAgencia tenantId={tenant.id} sessao={configVendas.notificacao.sessao ?? ''} />
                    </div>
                  ) : null}
                </div>
              </div>
            </details>
          </CardContent>
        </Card>

        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">Zona de perigo</CardTitle>
            <CardDescription>
              Suspender interrompe o agente e é reversível na hora. Excluir é soft delete — recuperável,
              mas trate como ação séria.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <BotaoSuspensao tenantId={tenant.id} ativo={tenant.ativo} />
            <ZonaPerigoExcluir tenantId={tenant.id} nome={tenant.nome} />
          </CardContent>
        </Card>
      </div>
    ),
  };

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

      {/* Aba por query string: server component, sem estado no cliente, link
          compartilhável — mandar "abre a aba Conexão do Empório" é um link. */}
      <nav className="flex flex-wrap gap-1 border-b border-border" aria-label="Seções">
        {ABAS.map(([chave, rotulo]) => (
          <Link
            key={chave}
            href={`/admin/tenants/${tenant.id}${chave === 'prompt' ? '' : `?aba=${chave}`}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${aba === chave ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            aria-current={aba === chave ? 'page' : undefined}
          >
            {rotulo}
          </Link>
        ))}
      </nav>

      <div className="flex flex-col gap-6">{paineis[aba]}</div>
    </div>
  );
}
