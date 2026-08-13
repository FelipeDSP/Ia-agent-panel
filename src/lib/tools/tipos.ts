/**
 * Tipos do registry de tools (§5.1 do ESPEC-CATALOGO-DE-TOOLS).
 *
 * O registry é a fonte de verdade de UI: rótulo e (adiante) o formulário de
 * config de cada tool. O catálogo no banco (`catalogo_tools`) é a fonte de
 * provisionamento (workflow_id_padrao, schema_config, ativo) e é super-only —
 * o cliente NÃO o lê, então o rótulo que ele vê tem de vir daqui, do código.
 *
 * Puro (sem 'use server'/'use client'): importável por Server Components,
 * Server Actions e componentes de browser.
 */

/**
 * Corte de responsabilidade do `config` de uma tool: quais chaves o cliente
 * edita e quais a agência edita. Cada lado preserva as do outro ao salvar.
 * Generaliza o corte que `transferir-humano.ts` já aplica.
 */
export type CorteConfig = {
  cliente: readonly string[];
  agencia: readonly string[];
};

/**
 * O que a entrada é, de fato.
 *
 * `tool_modelo`   — o agente a chama como ferramenta. `resumo` descreve uma
 *                   capacidade que o modelo decide usar.
 * `capacidade_fluxo` — etapa do fluxo n8n; o modelo nunca a invoca e nem sabe
 *                   que existe. Transcrição de áudio é o primeiro caso: roda
 *                   antes de o modelo entrar na conversa.
 *
 * Espelha `catalogo_tools.tipo` (migração 31). Vive nos dois lugares porque o
 * painel não lê o catálogo e o n8n não lê o registry — mas o valor é o mesmo, e
 * divergir é bug.
 */
export type TipoModulo = 'tool_modelo' | 'capacidade_fluxo';

/**
 * Em que grupo o módulo cai para efeito de EXIBIÇÃO e de CAPACIDADE DE AGIR.
 *
 * `padrao`       — o cliente não desliga nem configura. Some do painel dele.
 * `configuravel` — não desliga, mas configura de verdade (transferir_humano tem
 *                  horário, canal e destino). Fica visível, sem switch.
 * `contratavel`  — a agência vende à parte. Aparece só se contratado, e aí o
 *                  cliente liga/desliga (opt-out) e configura, se houver config.
 *
 * NÃO é derivável de `tipo` (migração 31): aquilo diz o que a coisa é
 * tecnicamente — tool que o modelo chama vs. etapa do fluxo —, e os dois eixos
 * são ortogonais. `transcricao_audio` é `capacidade_fluxo` + `contratavel`;
 * `busca_conhecimento` é `tool_modelo` + `padrao`.
 *
 * NÃO é TOOLS_BASELINE: baseline é "provisionado ao criar o tenant". Se um dia
 * vendas entrar automática num plano, ela vira baseline e continua contratável —
 * os dois conceitos divergem sem se contradizerem.
 */
export type GrupoTool = 'padrao' | 'configuravel' | 'contratavel';

export type DefinicaoTool = {
  /** Identificador estável = tenant_tools.tool_nome = catalogo_tools.tool_nome. */
  nome: string;
  /** Tool que o modelo chama, ou etapa do fluxo. Default: 'tool_modelo'. */
  tipo?: TipoModulo;
  /** Rótulo exibido no painel (cliente e admin). Fonte de UI. */
  rotulo: string;
  /** Resumo curto do que a tool faz, para admin e cliente entenderem. */
  resumo: string;
  /**
   * Se o cliente configura algo. Quando true, "meus módulos" renderiza um
   * formulário (a próxima fatia liga o componente de cada tool aqui).
   */
  temConfigCliente: boolean;
  /**
   * A agência vende este módulo à parte — o cliente pode ter ou não ter.
   *
   * UM BOOLEANO, e não um enum de três valores, porque `temConfigCliente` já
   * existe e o grupo sai derivado dos dois (ver `grupoTool`). Com enum próprio
   * daria para escrever `padrao` + `temConfigCliente: true`, que é estado
   * impossível e representável — duas verdades sobre a mesma coisa, o problema
   * que a migração 30 consertou entre `tools_ativas` e `config_tool`.
   *
   * Default `false`: módulo novo sem esta marca é padrão do produto, e padrão
   * some do painel do cliente. Errar para "some" é mais barato que errar para
   * "o cliente desliga sem querer algo que não deveria poder desligar".
   */
  contratavel?: boolean;
  /**
   * Rotas do painel do cliente que só existem por causa desta tool.
   *
   * Prefixos: `/painel/pedidos` cobre `/painel/pedidos/[id]` também.
   *
   * DECLARAR AQUI NÃO É DOCUMENTAÇÃO — é o que faz a regra funcionar. O item de
   * menu é montado a partir desta lista, e o `layout.tsx` da rota consulta a
   * mesma coisa para recusar acesso direto. Rota que não aparece aqui não ganha
   * item de menu para ninguém: o esquecimento vira ausência visível em vez de
   * vazamento silencioso.
   *
   * Nem toda superfície é rota. `foto_produto` não tem nenhuma — ela é uma seção
   * dentro do catálogo. O campo é opcional por isso, e a regra é sobre
   * superfície, não sobre rota.
   */
  rotasPainel?: readonly { href: string; rotulo: string; icone: string }[];
  /** Corte agência/cliente do config, quando houver. */
  corte?: CorteConfig;
};
