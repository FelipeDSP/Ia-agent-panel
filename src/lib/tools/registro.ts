/**
 * Registry de tools (§5.1). Mapa tool_nome -> definição de UI.
 *
 * Fonte de verdade do rótulo/resumo que o painel mostra (o cliente não lê o
 * catálogo no banco). Ao adicionar uma tool nova, registre-a aqui e crie a
 * linha no catálogo (`catalogo_tools`) — provisionar vira um checkbox.
 *
 * Puro: sem 'use server'/'use client'.
 */

import type { DefinicaoTool, GrupoTool } from './tipos';
import { TOOL_TRANSFERIR } from './transferir-humano';

export const REGISTRO_TOOLS: Record<string, DefinicaoTool> = {
  busca_conhecimento: {
    nome: 'busca_conhecimento',
    rotulo: 'Buscar na base de conhecimento',
    resumo: 'O agente consulta a base de conhecimento do cliente para responder.',
    temConfigCliente: false,
  },
  [TOOL_TRANSFERIR]: {
    nome: TOOL_TRANSFERIR,
    // Desligável sem ser vendida: há cliente que não quer receber atendimento
    // transferido em momento nenhum. Ver o efeito no agente no comentário de
    // `clientePodeDesligar` — desligar isto tira a saída de escape da conversa.
    desligavel: true,
    rotulo: 'Transferir para humano',
    resumo: 'Encaminha o atendimento a um humano, com horário e aviso configuráveis.',
    temConfigCliente: true,
    // Espelha o corte já aplicado em transferir-humano.ts.
    corte: {
      cliente: ['horario', 'notificacao.canal', 'notificacao.destino'],
      agencia: ['notificacao.sessao'],
    },
  },
  resolver_conversa: {
    nome: 'resolver_conversa',
    rotulo: 'Resolver conversa',
    resumo: 'Encerra a conversa quando o cliente se despede ou o atendimento termina.',
    temConfigCliente: false,
  },
  /**
   * Um `tool_nome` só para o módulo inteiro. No n8n são três sub-workflows
   * (consultar_catalogo, gerenciar_pedido, finalizar_pedido), mas os três
   * checam `api_n8n_config_tool(tenant_id, 'vendas')`: a granularidade do n8n é
   * detalhe de execução, a do catálogo é comercial — o cliente contrata
   * "Vendas", não "adicionar item".
   *
   * Fora de TOOLS_BASELINE de propósito: vendas é módulo vendido.
   */
  vendas: {
    nome: 'vendas',
    contratavel: true,
    // Catálogo e Pedidos só existem por causa de vendas. Antes de serem
    // declaradas aqui, as duas ficavam no menu de todo cliente e as rotas
    // abriam com os dados para quem não tinha contratado.
    rotasPainel: [
      { href: '/painel/catalogo', rotulo: 'Catálogo', icone: 'Package' },
      { href: '/painel/pedidos', rotulo: 'Pedidos', icone: 'Receipt' },
    ],
    rotulo: 'Vendas pelo agente',
    resumo:
      'O agente consulta seu catálogo, monta o pedido junto com o cliente na conversa e fecha. ' +
      'O preço vem sempre do catálogo.',
    temConfigCliente: false,
  },
  /**
   * NÃO é tool do modelo — é etapa do fluxo. O agente não a chama e não sabe
   * que ela existe; quando ligada, a nota de voz já chega a ele como texto.
   *
   * Por isso `tipo: 'capacidade_fluxo'`: `resumo` aqui descreve o que o
   * OPERADOR contrata, não uma capacidade que o modelo decide usar.
   *
   * Fora de TOOLS_BASELINE: o áudio do cliente final sai da nossa
   * infraestrutura e vai para a OpenAI. Ligar isso por padrão seria decidir
   * sobre dado de terceiro sem ninguém ter escolhido — ver
   * docs/LGPD-TRANSCRICAO-AUDIO.md.
   */
  transcricao_audio: {
    nome: 'transcricao_audio',
    contratavel: true,
    tipo: 'capacidade_fluxo',
    rotulo: 'Transcrever áudio',
    resumo:
      'Nota de voz do cliente vira texto antes de chegar ao agente. ' +
      'O áudio é enviado para a OpenAI — confira as implicações antes de contratar.',
    temConfigCliente: false,
  },
  /**
   * Módulo separado de `vendas`, mas INÚTIL sem ele: a tool recebe `produto_id`,
   * e o único jeito de o agente ter um é o `consultar_catalogo`. Separado assim
   * o cliente que vende pode desligar foto sem perder venda — e o admin mostra
   * um aviso quando a dependência não está contratada.
   *
   * Fora de TOOLS_BASELINE: manda imagem para o cliente final e consome banda.
   */
  foto_produto: {
    nome: 'foto_produto',
    contratavel: true,
    tipo: 'tool_modelo',
    rotulo: 'Enviar foto do produto',
    resumo:
      'O agente manda a foto de um item do catálogo quando o cliente pede. ' +
      'Uma foto por vez — há trava para não virar sequência de imagens no WhatsApp.',
    temConfigCliente: false,
  },
};

/** Definição de UI de uma tool, ou null se não estiver registrada. */
export function definicaoTool(nome: string): DefinicaoTool | null {
  return REGISTRO_TOOLS[nome] ?? null;
}

/**
 * Tools de baseline do produto: todo cliente tem, desde o primeiro dia.
 *
 * São provisionadas automaticamente na criação do tenant (contratado + ativo).
 *
 * NÃO CONFUNDIR COM `GrupoTool`. Baseline é sobre PROVISIONAMENTO: o que entra
 * ao criar o cliente. Grupo é sobre EXIBIÇÃO E CAPACIDADE: o que ele vê e no que
 * pode mexer. Hoje as três baseline caem em padrão/configurável, mas os eixos
 * são independentes — provisionar vendas automaticamente num plano faria a lista
 * abaixo crescer sem que vendas deixasse de ser contratável.
 *
 * A razão de o baseline entrar ligado: `busca_conhecimento` desligada é agente
 * sem base de conhecimento, respondendo do nada. Um esquecimento no
 * provisionamento não pode ter esse custo.
 *
 * Precisam existir em `catalogo_tools` (FK de tenant_tools.tool_nome). As três
 * estão lá desde a migração 20.
 */
export const TOOLS_BASELINE = [
  'busca_conhecimento',
  TOOL_TRANSFERIR,
  'resolver_conversa',
] as const;

// ---------------------------------------------------------------------------
// Grupo: o que o cliente vê e no que ele pode mexer
// ---------------------------------------------------------------------------
//
// A REGRA, uma frase: o painel do cliente só mostra o que ele pode agir. Não
// pode desligar nem configurar -> some. Não tem contratado -> some. Pode
// configurar ou ligar/desligar -> fica.
//
// Tudo aqui é função pura sobre a definição, sem tocar em banco: é o que
// permite o teste afirmar a propriedade em vez do estado do mundo.

/**
 * Em que grupo a tool cai. DERIVADO — não há campo `grupo` para contradizer
 * `contratavel` e `temConfigCliente`.
 *
 * Tool fora do registry cai em `contratavel`: a agência criou a linha no
 * catálogo e vendeu antes de alguém escrever o rótulo, então ela precisa
 * aparecer e ser desligável. O admin avisa quando isto acontece — descobrir
 * pela ausência não funciona, porque ausência não avisa.
 */
export function grupoTool(nome: string): GrupoTool {
  const def = REGISTRO_TOOLS[nome];
  if (!def) return 'contratavel';
  if (def.contratavel) return 'contratavel';
  if (def.temConfigCliente) return 'configuravel';
  return 'padrao';
}

/**
 * Se o CLIENTE pode ligar/desligar o módulo.
 *
 * DUAS FONTES, e não o grupo. A primeira versão devolvia
 * `grupo === 'contratavel'`, derivando "pode desligar" de "é vendida" — e as
 * duas perguntas são diferentes. `busca_conhecimento` não desliga por limitação
 * técnica (agente sem base responde do nada); `transferir_humano` desliga por
 * escolha de negócio (há cliente que não quer receber atendimento em momento
 * nenhum). Ser vendida não decide nenhuma das duas.
 *
 * O EFEITO DE DESLIGAR A TRANSFERÊNCIA, para quem for mexer nisto: o agente
 * perde a saída de escape. Cliente final que insistir em falar com uma pessoa
 * continua conversando com o bot, e não há mais o caminho que pausava a conversa
 * automaticamente — pausar passa a ser manual, no painel ou no Chatwoot. É
 * decisão legítima, e é por isso que a tela avisa antes.
 *
 * Isto é capacidade, não exibição — e por isso o servidor também consulta esta
 * função, não só a tela. Esconder o botão não é o mesmo que não poder: é a
 * mesma lição do `tool_ativa` que ninguém checava e do `config_tool` que
 * ignorava `contratado`.
 */
export function clientePodeDesligar(nome: string): boolean {
  const def = REGISTRO_TOOLS[nome];
  // Fora do registry cai em contratável (ver `grupoTool`), e contratável é
  // desligável por definição: contratado entra ligado, o switch é o opt-out.
  if (!def) return true;
  return Boolean(def.contratavel) || Boolean(def.desligavel);
}

/**
 * Se o módulo aparece no painel do cliente.
 *
 * A regra: só aparece o que ele pode agir — configurar OU ligar/desligar. Padrão
 * não é nenhum dos dois, então nunca aparece.
 */
export function clienteVeModulo(nome: string, contratado: boolean): boolean {
  return contratado && grupoTool(nome) !== 'padrao';
}

/**
 * Se a seção recolhida do admin (padrão + configurável) precisa abrir sozinha.
 *
 * Módulo padrão desligado é invisível para o cliente E irrecuperável por ele —
 * ele não tem mais o switch. Só a agência conserta, e só conserta o que vê.
 * Seção recolhida que esconde problema é a forma mais rápida de um diagnóstico
 * não acontecer.
 *
 * Recebe o estado, não consulta nada: a propriedade é "se existe desligado, a
 * seção abre", e ela vale para qualquer lista — inclusive a vazia.
 */
export function secaoPadraoTemAnomalia(
  modulos: readonly { contratado: boolean; ativo: boolean }[],
): boolean {
  return modulos.some((m) => m.contratado && !m.ativo);
}

// ---------------------------------------------------------------------------
// Superfície: tudo que uma tool traz para a tela
// ---------------------------------------------------------------------------
//
// A PROPRIEDADE, e ela é permanente: toda superfície que uma tool traz — item de
// menu, rota, seção de tela, indicador, Server Action — só existe para quem
// contratou aquela tool.
//
// É propriedade e não lista de propósito. Uma lista das tools de hoje envelhece
// no dia em que entrar a próxima; a propriedade vale para ela também, sem
// ninguém precisar lembrar.
//
// NÃO É SOBRE ROTA. `foto_produto` não tem rota nenhuma — é uma seção dentro do
// catálogo, e obedece à mesma regra. Rota é o caso mais comum, não o conceito.

/**
 * Rotas do painel que existem independentemente de qualquer tool.
 *
 * Toda rota sob `/painel/` tem de estar aqui OU ser declarada por uma tool em
 * `rotasPainel` — `npm run teste:superficie` reprova se aparecer uma terceira
 * categoria. É a rede para o caso que o menu-a-partir-do-registry não pega
 * sozinho: alguém cria `/painel/agenda/page.tsx` e não encosta no menu, e o
 * mecanismo fica quieto porque não há item para faltar.
 */
export const ROTAS_SEMPRE_VISIVEIS = [
  { href: '/painel', rotulo: 'Visão geral', icone: 'LayoutDashboard' },
  { href: '/painel/conhecimento', rotulo: 'Base de conhecimento', icone: 'BookOpen' },
  { href: '/painel/conversas', rotulo: 'Conversas', icone: 'MessagesSquare' },
  { href: '/painel/consumo', rotulo: 'Uso', icone: 'BarChart3' },
  { href: '/painel/configuracoes', rotulo: 'Configurações', icone: 'Settings' },
] as const;

/**
 * Qual tool é dona de uma rota do painel, ou null se ela é sempre visível.
 *
 * Casa por PREFIXO e devolve o mais longo: `/painel/pedidos/abc` pertence a
 * quem declarou `/painel/pedidos`. O mais longo importa para o dia em que uma
 * tool declarar uma sub-rota de outra.
 */
export function toolDaRota(caminho: string): string | null {
  let dona: string | null = null;
  let maior = -1;
  for (const [nome, def] of Object.entries(REGISTRO_TOOLS)) {
    for (const r of def.rotasPainel ?? []) {
      const casa = caminho === r.href || caminho.startsWith(`${r.href}/`);
      if (casa && r.href.length > maior) {
        dona = nome;
        maior = r.href.length;
      }
    }
  }
  return dona;
}

/** Todas as rotas declaradas por tools, com a tool dona de cada uma. */
export function rotasDeTools(): { href: string; tool: string }[] {
  return Object.entries(REGISTRO_TOOLS).flatMap(([nome, def]) =>
    (def.rotasPainel ?? []).map((r) => ({ href: r.href, tool: nome })),
  );
}

export type ItemMenuPainel = { href: string; rotulo: string; icone: string };

/**
 * Monta o menu do painel do cliente a partir do registry.
 *
 * `contratadas` é o conjunto de tool_nome com `contratado = true`. Vem resolvido
 * do servidor e desce por prop — o cliente buscando isso faria o menu piscar
 * itens que ele não tem.
 *
 * O QUE ACONTECE SE A RESOLUÇÃO FALHAR NO SERVIDOR. Decidido, não descoberto na
 * primeira falha: `contratadas` chega vazio e o menu fica só com as
 * sempre-visíveis. As condicionais somem.
 *
 * O raciocínio: mostrar demais vaza uma tela que o cliente não pode usar — e a
 * rota recusaria com 404 de qualquer jeito, então ele clica e bate na parede,
 * sem entender. Mostrar de menos degrada a navegação de um jeito recuperável:
 * "sumiu o Catálogo" é sintoma que ele relata na hora. E é o que a regra manda:
 * o painel só mostra o que ele pode agir — se não sabemos o que ele pode, não
 * dá para afirmar que pode.
 *
 * A mesma escolha vale no guard de rota (`exigirToolDaRota`): falha fecha.
 * Divergir aqui produziria menu que mostra o que a rota recusa.
 */
export function menuDoPainel(contratadas: ReadonlySet<string>): ItemMenuPainel[] {
  const condicionais = Object.entries(REGISTRO_TOOLS).flatMap(([nome, def]) =>
    contratadas.has(nome) ? [...(def.rotasPainel ?? [])] : [],
  );

  // Ordem: a das sempre-visíveis é curada (Visão geral primeiro, Configurações
  // por último). As condicionais entram antes de Conversas, onde Catálogo e
  // Pedidos estavam na lista fixa.
  const fixas = [...ROTAS_SEMPRE_VISIVEIS];
  const corte = fixas.findIndex((i) => i.href === '/painel/conversas');
  const pos = corte === -1 ? fixas.length : corte;
  return [...fixas.slice(0, pos), ...condicionais, ...fixas.slice(pos)];
}
