/**
 * Registry de tools (§5.1). Mapa tool_nome -> definição de UI.
 *
 * Fonte de verdade do rótulo/resumo que o painel mostra (o cliente não lê o
 * catálogo no banco). Ao adicionar uma tool nova, registre-a aqui e crie a
 * linha no catálogo (`catalogo_tools`) — provisionar vira um checkbox.
 *
 * Puro: sem 'use server'/'use client'.
 */

import type { DefinicaoTool } from './tipos';
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
};

/** Definição de UI de uma tool, ou null se não estiver registrada. */
export function definicaoTool(nome: string): DefinicaoTool | null {
  return REGISTRO_TOOLS[nome] ?? null;
}
