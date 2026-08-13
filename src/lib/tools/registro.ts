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
 * Isto é capacidade, não exibição — e por isso o servidor também consulta esta
 * função, não só a tela. Esconder o botão não é o mesmo que não poder: é a
 * mesma lição do `tool_ativa` que ninguém checava e do `config_tool` que
 * ignorava `contratado`.
 */
export function clientePodeDesligar(nome: string): boolean {
  return grupoTool(nome) === 'contratavel';
}

/** Se o módulo aparece no painel do cliente. Padrão nunca aparece. */
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
