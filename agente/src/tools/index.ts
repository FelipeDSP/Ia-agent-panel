/**
 * As ferramentas por perfil — a mesma composição do n8n:
 *   basico: busca_conhecimento, transferir_humano, resolver_conversa
 *   vendas: as três + consultar_catalogo, gerenciar_pedido, enviar_foto_produto
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

export function ferramentasDoPerfil(ctx: ContextoTool, perfil: Perfil): FerramentaDoModelo[] {
  const basicas = [ferramentaBuscaConhecimento(ctx), ferramentaTransferirHumano(ctx), ferramentaResolverConversa(ctx)];
  if (perfil === 'basico') return basicas;
  return [...basicas, ferramentaConsultarCatalogo(ctx), ferramentaGerenciarPedido(ctx), ferramentaEnviarFoto(ctx)];
}
