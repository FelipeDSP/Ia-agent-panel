import 'server-only';

import { formatarUsd } from '@/lib/billing/consumo';

import { situacaoDaConta, tempoRelativo } from './situacao';
import { DIAS_JANELA, DIAS_RECENTE, type LinhaPanorama } from './panorama';

/**
 * A montagem do panorama — a parte que fala com o banco.
 *
 * Separada de `panorama.ts` porque aquele arquivo é importado pelo componente
 * de cliente da lista. Regra e dado puro ficam lá; consulta fica aqui.
 */

type Tenant = {
  id: string; slug: string; nome: string; ativo: boolean; agente_ativo: boolean;
  chatwoot_account_id: number | null; chatwoot_inbox_id: number | null; criado_em: string;
};

type Turno = { tenant_id: string; conversation_id: number | string; status: string; iniciado_em: string; acao: string };

type Supa = { from: (t: string) => { select: (...a: any[]) => any }; rpc: (f: string, p?: unknown) => any };

export async function montarPanorama(
  supabase: Supa,
  tenants: Tenant[],
  agora = new Date(),
): Promise<{ linhas: LinhaPanorama[]; erros: string[] }> {
  const erros: string[] = [];
  const desdeJanela = new Date(agora.getTime() - DIAS_JANELA * 86_400_000).toISOString();
  const desdeRecente = new Date(agora.getTime() - DIAS_RECENTE * 86_400_000);

  /*
   * `acao <> 'ensaio'` porque o ensaio é a agência testando, não atendimento:
   * contá-lo faria uma conta parada parecer viva no dia em que alguém abrisse
   * o assistente dela.
   */
  let turnos: Turno[] = [];
  try {
    const { data, error } = await supabase
      .from('agente_turnos')
      .select('tenant_id, conversation_id, status, iniciado_em, acao')
      .gte('iniciado_em', desdeJanela)
      .neq('acao', 'ensaio')
      .order('iniciado_em', { ascending: false })
      .limit(20_000);
    if (error) throw new Error(error.message);
    turnos = (data ?? []) as Turno[];
  } catch (e) {
    erros.push(`atividade: ${e instanceof Error ? e.message : String(e)}`);
  }

  /*
   * O custo vem da MESMA função que a tela de Consumo usa. Recalcular aqui
   * criaria um segundo número para o mesmo mês — e dois números para a mesma
   * coisa divergem no dia em que um preço muda.
   */
  const custoPorTenant = new Map<string, number>();
  try {
    const { data, error } = await supabase.rpc('billing_consumo_mensal');
    if (error) throw new Error(error.message);
    const mesAtual = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}`;
    for (const l of (data ?? []) as { tenant_id: string; mes: string; custo_usd: number | string }[]) {
      if (String(l.mes).slice(0, 7) !== mesAtual) continue;
      custoPorTenant.set(l.tenant_id, Number(l.custo_usd) || 0);
    }
  } catch (e) {
    erros.push(`custo: ${e instanceof Error ? e.message : String(e)}`);
  }

  const porTenant = new Map<string, { conversas: Set<string>; turnos: number; falhas: number; ultimo: Date | null }>();
  for (const t of turnos) {
    const q = porTenant.get(t.tenant_id) ?? { conversas: new Set<string>(), turnos: 0, falhas: 0, ultimo: null };
    const quando = new Date(t.iniciado_em);
    if (!q.ultimo || quando > q.ultimo) q.ultimo = quando;
    if (quando >= desdeRecente) {
      q.turnos += 1;
      q.conversas.add(String(t.conversation_id));
      if (t.status === 'falhou') q.falhas += 1;
    }
    porTenant.set(t.tenant_id, q);
  }

  const linhas = tenants.map((t) => {
    const q = porTenant.get(t.id);
    const ultima = q?.ultimo ?? null;
    const custo = custoPorTenant.has(t.id) ? (custoPorTenant.get(t.id) as number) : null;
    return {
      id: t.id,
      slug: t.slug,
      nome: t.nome,
      ativo: t.ativo,
      agenteAtivo: t.agente_ativo,
      chatwootAccountId: t.chatwoot_account_id,
      chatwootInboxId: t.chatwoot_inbox_id,
      criadoEm: t.criado_em,
      conversas7d: q?.conversas.size ?? 0,
      turnos7d: q?.turnos ?? 0,
      falhas7d: q?.falhas ?? 0,
      ultimaAtividade: ultima,
      ultimaAtividadeTexto: tempoRelativo(ultima, agora),
      custoMesUsd: custo,
      custoMesTexto: custo === null ? '—' : formatarUsd(custo),
      situacao: situacaoDaConta({
        ativo: t.ativo,
        agenteAtivo: t.agente_ativo,
        temChatwoot: t.chatwoot_account_id !== null,
        ultimaAtividade: ultima,
      }, agora),
    };
  });

  return { linhas, erros };
}
