import 'server-only';

import { criarClienteServidor } from '@/lib/supabase/server';

/**
 * O marcador "até onde esta pessoa já viu a fila" (migração 84).
 *
 * POR PESSOA, não por conta: duas pessoas em turnos diferentes não têm o mesmo
 * "novo". E no banco, não no navegador — no navegador o marcador sumiria ao
 * trocar de máquina, e elas vão revezar computador.
 *
 * Lê ANTES de carimbar, e devolve o valor antigo: é com ele que a tela decide
 * o que é novo. Carimbar primeiro apagaria exatamente a informação que a tela
 * veio buscar.
 */
export async function lerEMarcarVistos(usuarioId: string, tenantId: string): Promise<string | null> {
  const supabase = await criarClienteServidor();

  const { data } = await supabase
    .from('usuarios_painel')
    .select('pedidos_vistos_em')
    .eq('id', usuarioId)
    .maybeSingle();
  const antes = (data?.pedidos_vistos_em as string | null) ?? null;

  // Falha aqui não quebra a tela: o pior caso é o "novo" aparecer de novo na
  // próxima visita, que é incômodo, não perda. Filtro explícito de tenant além
  // do id, como a regra 6 pede.
  await supabase
    .from('usuarios_painel')
    .update({ pedidos_vistos_em: new Date().toISOString() })
    .eq('id', usuarioId)
    .eq('tenant_id', tenantId);

  return antes;
}

/** Quantos pedidos da fila fecharam depois de `desde`. Para o contador do menu. */
export async function contarNovos(tenantId: string, desde: string | null): Promise<number> {
  if (!desde) return 0;
  const supabase = await criarClienteServidor();
  const { count } = await supabase
    .from('pedidos')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .is('deletado_em', null)
    .in('status', ['aguardando_pagamento', 'pago'])
    .is('retirado_em', null)
    .gt('criado_em', desde);
  return count ?? 0;
}
