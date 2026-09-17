/**
 * As ferramentas por perfil — a mesma composição do n8n:
 *   basico: busca_conhecimento, transferir_humano, resolver_conversa
 *   vendas: as três + consultar_catalogo, gerenciar_pedido, enviar_foto_produto
 *   (+ gerar_link_pagamento quando `pagamento` está contratada — 61/§11.1)
 *
 * Cada tool confere `tool_ativa` por dentro (a função de banco também), como
 * os sub-workflows fazem — duas camadas, nenhuma decorativa.
 */
import type { FerramentaDoModelo } from '../agente/modelo.ts';
import type { Perfil } from '../agente/prompt.ts';
import type { ContextoTool } from './contexto.ts';
import { ferramentaBuscaConhecimento } from './busca-conhecimento.ts';
import { ferramentaTransferirHumano } from './transferir-humano.ts';
import { ferramentaResolverConversa } from './resolver-conversa.ts';
import { ferramentaConsultarCatalogo } from './consultar-catalogo.ts';
import { ferramentaGerenciarPedido } from './gerenciar-pedido.ts';
import { ferramentaEnviarFoto } from './enviar-foto.ts';
import { ferramentaGerarLinkPagamento } from './gerar-link-pagamento.ts';

/**
 * `toolsAtivas` é a lista de `api_n8n_tools_ativas`: `pagamento` é linha própria
 * de `catalogo_tools` (61) e entra SÓ quando contratada+ativa e há Asaas no
 * serviço — uma tool = um contrato (regra de superfície do CLAUDE.md).
 */
export function ferramentasDoPerfil(ctx: ContextoTool, perfil: Perfil, toolsAtivas: string[] = []): FerramentaDoModelo[] {
  const basicas = [ferramentaBuscaConhecimento(ctx), ferramentaTransferirHumano(ctx), ferramentaResolverConversa(ctx)];
  if (perfil === 'basico') return basicas;
  const vendas = [...basicas, ferramentaConsultarCatalogo(ctx), ferramentaGerenciarPedido(ctx), ferramentaEnviarFoto(ctx)];
  // 69: a conta que não aceita pagar por link (só na retirada) não recebe a
  // tool, mesmo com `pagamento` contratada — mesma condição da seção do prompt.
  if (temPagamento(toolsAtivas) && ctx.asaas && ctx.aceitaLink !== false) vendas.push(ferramentaGerarLinkPagamento(ctx, ctx.asaas));
  return vendas;
}

export const temPagamento = (toolsAtivas: string[]): boolean => toolsAtivas.includes('pagamento');
