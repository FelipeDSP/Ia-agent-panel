'use server';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { ERRO_NAO_CONTRATADA, temToolContratada } from '@/lib/tools/contratacao';
import { TOOL_VENDAS } from '@/lib/tools/vendas-config';

export type EstadoPedido = { erro?: string; sucesso?: string };

const MOTIVOS: Record<string, string> = {
  nao_encontrado: 'Pedido não encontrado.',
  nao_esta_aguardando: 'Este pedido não está aguardando pagamento.',
  nao_esta_pago: 'Marque como pago antes de marcar como retirado.',
  ja_retirado: 'Este pedido já foi marcado como retirado.',
  acao_invalida: 'Ação inválida.',
};

/**
 * O usuário da conta marca um pedido como pago ou retirado (migração 69).
 *
 * Quem decide é `painel_marcar_pedido` no banco, com o tenant vindo do JWT da
 * sessão (`auth_tenant_id()`): o id do pedido vem do formulário, o tenant
 * nunca. Superfície de `vendas` — checagem de contratação aqui porque a
 * action é entrada própria. Hoje só há um usuário por conta; quando existir
 * `tenant_agente` (DESENHO-USUARIOS-POR-CONTA), a capacidade `marcar_pedido`
 * entra nesta linha.
 */
export async function marcarPedido(_estado: EstadoPedido, fd: FormData): Promise<EstadoPedido> {
  const usuario = await exigirTenantAdmin();
  if (!(await temToolContratada(usuario.tenantId, TOOL_VENDAS))) return { erro: ERRO_NAO_CONTRATADA };

  const pedidoId = String(fd.get('pedido_id') ?? '').trim();
  const acao = String(fd.get('acao') ?? '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(pedidoId)) return { erro: 'Pedido inválido.' };
  if (acao !== 'pago' && acao !== 'retirado') return { erro: MOTIVOS['acao_invalida'] ?? 'Ação inválida.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('painel_marcar_pedido', { p_pedido_id: pedidoId, p_acao: acao });
  if (error) return { erro: `Não foi possível marcar: ${error.message}` };
  const linha = (Array.isArray(data) ? data[0] : data) as { ok: boolean; motivo: string } | undefined;
  if (!linha?.ok) return { erro: MOTIVOS[linha?.motivo ?? ''] ?? 'Não foi possível marcar.' };

  revalidatePath('/painel/pedidos');
  revalidatePath(`/painel/pedidos/${pedidoId}`);
  return { sucesso: acao === 'pago' ? 'Pedido marcado como pago.' : 'Pedido marcado como retirado.' };
}
