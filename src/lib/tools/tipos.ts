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
  /** Corte agência/cliente do config, quando houver. */
  corte?: CorteConfig;
};
