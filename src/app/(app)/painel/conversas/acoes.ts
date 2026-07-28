'use server';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

export type EstadoConversa = { erro?: string; sucesso?: string };

const STATUS_VALIDOS = new Set(['ativo', 'pausado', 'resolvido']);

/**
 * Pausa/retoma o agente numa conversa. UPDATE direto em conversas.status pelo
 * cliente do servidor — RLS garante que só alcança conversa do próprio tenant.
 * Não passa pela api_n8n_* (aquela é a superfície do role n8n).
 *
 * O workflow do n8n já respeita status = 'pausado' (lê no conversa_sync), então
 * mudar aqui pausa o agente naquela conversa sem tocar no n8n.
 *
 * tenant_id vem do JWT (exigirTenantAdmin), nunca do request — e ainda filtramos
 * explícito por ele além do RLS (regra 6).
 */
export async function definirStatusConversa(
  conversationId: number,
  novoStatus: string,
): Promise<EstadoConversa> {
  const usuario = await exigirTenantAdmin();

  if (!STATUS_VALIDOS.has(novoStatus)) {
    return { erro: 'Status inválido.' };
  }

  const supabase = await criarClienteServidor();
  const { error } = await supabase
    .from('conversas')
    .update({
      status: novoStatus,
      pausado_em: novoStatus === 'pausado' ? new Date().toISOString() : null,
    })
    .eq('tenant_id', usuario.tenantId)
    .eq('conversation_id', conversationId);

  if (error) return { erro: `Não foi possível atualizar: ${error.message}` };

  revalidatePath('/painel/conversas');
  revalidatePath(`/painel/conversas/${conversationId}`);
  return {
    sucesso:
      novoStatus === 'pausado'
        ? 'Agente pausado nesta conversa.'
        : novoStatus === 'ativo'
          ? 'Agente reativado.'
          : 'Conversa marcada como resolvida.',
  };
}
