'use server';

import { revalidatePath } from 'next/cache';

import { exigirMembro } from '@/lib/auth';
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
  nao_esta_em_aberto: 'Só dá para separar pedido fechado que ainda não saiu.',
  sem_permissao: 'Você não tem permissão para marcar pedidos. Fale com o administrador da conta.',
};

/** As ações que `painel_marcar_pedido` aceita (83). A lista mora aqui e no banco. */
const ACOES = ['pago', 'retirado', 'separado', 'desfazer_separado'] as const;
const SUCESSO: Record<string, string> = {
  pago: 'Pedido marcado como pago.',
  retirado: 'Pedido marcado como retirado.',
  separado: 'Pedido separado.',
  desfazer_separado: 'Pedido voltou para a fila.',
};

/**
 * O usuário da conta marca um pedido como pago ou retirado (migração 69).
 *
 * Quem decide é `painel_marcar_pedido` no banco, com o tenant vindo do JWT da
 * sessão (`auth_tenant_id()`): o id do pedido vem do formulário, o tenant
 * nunca. Superfície de `vendas` — checagem de contratação aqui porque a
 * action é entrada própria, e a capacidade `marcar_pedido` entra nela (80).
 *
 * 83: `separado` e `desfazer_separado` entram como ações NOVAS da mesma função
 * — a assinatura `(uuid, text)` não mudou, então nenhum grant se perdeu e
 * nenhuma chamada virou ambígua.
 */
export async function marcarPedido(_estado: EstadoPedido, fd: FormData): Promise<EstadoPedido> {
  const usuario = await exigirMembro('marcar_pedido');
  if (!(await temToolContratada(usuario.tenantId, TOOL_VENDAS))) return { erro: ERRO_NAO_CONTRATADA };

  const pedidoId = String(fd.get('pedido_id') ?? '').trim();
  const acao = String(fd.get('acao') ?? '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(pedidoId)) return { erro: 'Pedido inválido.' };
  if (!(ACOES as readonly string[]).includes(acao)) return { erro: MOTIVOS['acao_invalida'] ?? 'Ação inválida.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('painel_marcar_pedido', { p_pedido_id: pedidoId, p_acao: acao });
  if (error) return { erro: `Não foi possível marcar: ${error.message}` };
  const linha = (Array.isArray(data) ? data[0] : data) as { ok: boolean; motivo: string } | undefined;
  if (!linha?.ok) return { erro: MOTIVOS[linha?.motivo ?? ''] ?? 'Não foi possível marcar.' };

  revalidatePath('/painel/pedidos');
  revalidatePath(`/painel/pedidos/${pedidoId}`);
  return { sucesso: SUCESSO[acao] ?? 'Pedido atualizado.' };
}
