'use server';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { invocarLimparMemoria } from '@/lib/n8n';
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
  const { data, error } = await supabase
    .from('conversas')
    .update({
      status: novoStatus,
      pausado_em: novoStatus === 'pausado' ? new Date().toISOString() : null,
      // Migração 47. `manual` NUNCA caduca — é o que separa este clique da pausa
      // que o n8n grava (`mensagem_humana`, que caduca por
      // `tenants.pausa_expira_minutos`). O sistema desfazer sozinho uma decisão
      // explícita de gente é a pior categoria de surpresa.
      //
      // Obrigatório, não decorativo: a constraint `conversas_pausa_tem_motivo`
      // recusa `status = 'pausado'` sem motivo. Por isso este arquivo tem de
      // subir DEPOIS do SQL da 47 — na ordem inversa o toggle quebra em `column
      // motivo_pausa does not exist`, que é opaco, em vez de na violação de
      // constraint, que se explica.
      //
      // O carimbo continua vindo do JS enquanto `pausado_em` do n8n vem do
      // `now()` do banco. Não incomoda aqui: pausa manual não é medida contra a
      // janela. (E é essa diferença de origem que permitiu identificar, no
      // backfill da 47, qual das 11 conversas paradas tinha sido clicada.)
      motivo_pausa: novoStatus === 'pausado' ? 'manual' : null,
    })
    .eq('tenant_id', usuario.tenantId)
    .eq('conversation_id', conversationId)
    .select('conversation_id');

  if (error) return { erro: `Não foi possível atualizar: ${error.message}` };
  // 0 linhas = conversa não é deste tenant (ou não existe): não finge sucesso.
  if (!data || data.length === 0) return { erro: 'Conversa não encontrada.' };

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

/**
 * Limpa a memória conversacional do agente (Redis, via n8n) para uma, várias ou
 * TODAS as conversas do tenant. Serve para que, depois de atualizar a base de
 * conhecimento, o agente não responda a partir do que "lembrou" e volte a
 * consultar a base.
 *
 * Não apaga o histórico exibido no painel (mensagens_log é log de auditoria/
 * billing e permanece) — só a memória que o agente usa como contexto.
 *
 * Isolamento: os conversation_id são SEMPRE resolvidos do banco escopados por
 * tenant_id (do JWT). Uma lista crua do request nunca vira alvo direto — só
 * limpamos memória de conversas comprovadamente deste tenant. `'todas'` busca
 * todos os conversation_id do próprio tenant.
 */
export async function limparMemoriaConversas(
  alvo: number[] | 'todas',
): Promise<EstadoConversa> {
  const usuario = await exigirTenantAdmin();

  // 'todas': o n8n varre tenant_<uuid>_* — pega até buffers de conversas que já
  // saíram da tabela. Não precisa enumerar ids; o tenant_id já escopa.
  if (alvo === 'todas') {
    const r = await invocarLimparMemoria({
      tenantId: usuario.tenantId,
      escopo: 'todas',
      conversationIds: [],
    });
    if (!r.ok) return { erro: r.motivo };
    revalidatePath('/painel/conversas');
    return { sucesso: 'Memória de todas as conversas limpa. O agente recomeça consultando a base.' };
  }

  // Específicas: só limpa conversas comprovadamente deste tenant. Resolvemos os
  // ids do banco escopados por tenant_id (do JWT) — lista crua do request nunca
  // vira alvo direto.
  const pedidos = alvo.filter((n) => Number.isInteger(n));
  if (pedidos.length === 0) return { erro: 'Nenhuma conversa selecionada.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase
    .from('conversas')
    .select('conversation_id')
    .eq('tenant_id', usuario.tenantId)
    .in('conversation_id', pedidos);

  if (error) return { erro: `Não foi possível carregar as conversas: ${error.message}` };

  const ids = (data ?? []).map((c) => c.conversation_id as number);
  if (ids.length === 0) return { erro: 'Nenhuma conversa encontrada para limpar.' };

  const r = await invocarLimparMemoria({
    tenantId: usuario.tenantId,
    escopo: 'conversas',
    conversationIds: ids,
  });
  if (!r.ok) return { erro: r.motivo };

  revalidatePath('/painel/conversas');
  return {
    sucesso:
      ids.length === 1
        ? 'Memória limpa nesta conversa. O agente volta a consultar a base do zero.'
        : `Memória limpa em ${ids.length} conversas.`,
  };
}
