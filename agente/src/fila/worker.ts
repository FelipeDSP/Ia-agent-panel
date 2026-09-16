/**
 * O worker da fila — o debounce do n8n, pela fila do Postgres (DESENHO §3b).
 *
 *   reivindicar (global, por data, skip locked)
 *     -> para cada linha: turno_da_conversa (sob lock da conversa)
 *          'desistir'  -> nada (a mais nova responde por todas)
 *          'adiar'     -> nada (outro turno em andamento; volta em 10 s)
 *          'responder' -> executarTurno com TODAS as mensagens -> concluir
 *
 * Uma passada (`umCiclo`) é testável sozinha, com o `db` de uma transação
 * abortada: o `main` só a chama num laço com intervalo.
 */
import { fnTodas, fnUma, fnValor, type Db } from '../db.ts';
import type { Tenant } from '../tenant/resolver.ts';
import { executarTurno, type MensagemDaFila, type Deps as DepsTurno } from '../turno/executar.ts';
import { log, erroTexto } from '../log.ts';

export interface DepsWorker extends Omit<DepsTurno, never> {
  workerId: string; lote: number; leaseMinutos: number;
}

interface LinhaFila {
  id: string; tenant_id: string; conversation_id: string | number; estado: string;
  executar_em: Date; tentativas: number;
}
interface Decisao { decisao: 'desistir' | 'adiar' | 'responder'; fila_ids: string[]; mensagens: MensagemDaFila[] }

export interface ResumoCiclo { reivindicadas: number; respondidas: number; desistidas: number; adiadas: number; falhas: number }

export async function umCiclo(deps: DepsWorker): Promise<ResumoCiclo> {
  const resumo: ResumoCiclo = { reivindicadas: 0, respondidas: 0, desistidas: 0, adiadas: 0, falhas: 0 };
  const lote = await fnTodas<LinhaFila>(deps.db, 'api_agente_reivindicar', [deps.workerId, deps.lote, deps.leaseMinutos]);
  resumo.reivindicadas = lote.length;

  for (const linha of lote) {
    const conversationId = Number(linha.conversation_id);
    let d: Decisao | undefined;
    try {
      d = await fnUma<Decisao>(deps.db, 'api_agente_turno_da_conversa', [linha.tenant_id, conversationId, linha.id, deps.workerId, deps.leaseMinutos]);
    } catch (e) {
      // 55P03 = outro worker já levou esta linha (lease vencida e reivindicada de novo). Não é falha.
      if ((e as { code?: string }).code === '55P03') continue;
      resumo.falhas++;
      log('erro', 'fila.turno_da_conversa', { fila_id: linha.id, erro: erroTexto(e) });
      continue;
    }
    if (!d) continue;
    if (d.decisao === 'desistir') { resumo.desistidas++; continue; }
    if (d.decisao === 'adiar') { resumo.adiadas++; continue; }

    // O tenant, com o que o turno precisa (modelo, mensagens fixas, debounce).
    const tenant = await tenantPorId(deps.db, linha.tenant_id);
    if (!tenant) {
      await fnValor(deps.db, 'api_agente_concluir', [linha.tenant_id, d.fila_ids, 'falhou', null, 'tenant indisponivel']);
      resumo.falhas++;
      continue;
    }

    const r = await executarTurno(deps, { tenant, conversationId, filaIds: d.fila_ids, mensagens: d.mensagens });
    const estadoFinal = r.status === 'ok' ? 'concluida' : r.status === 'descartado' ? 'descartada' : 'falhou';
    await fnValor(deps.db, 'api_agente_concluir', [linha.tenant_id, d.fila_ids, estadoFinal, r.turnoId, r.motivo ?? null]);
    if (r.status === 'ok') resumo.respondidas++; else if (r.status === 'falhou') resumo.falhas++;
    log(r.status === 'falhou' ? 'erro' : 'info', 'fila.turno', { tenant: tenant.slug, conversa: conversationId, turno: r.turnoId, status: r.status, mensagens: d.mensagens.length, veredito: r.veredito, motivo: r.motivo });
  }
  return resumo;
}

/**
 * O tenant por id. Não há `api_n8n_tenant_por_id`; a função que existe resolve
 * pelo par (conta, caixa), e a linha da fila só tem o tenant. Então: a caixa
 * está na mensagem enfileirada — e a resolução pelo par é a MESMA do receptor.
 */
async function tenantPorId(db: Db, tenantId: string): Promise<Tenant | null> {
  const par = await fnUma<{ chatwoot_account_id: number | null; chatwoot_inbox_id: number | null }>(db, 'api_agente_par_chatwoot', [tenantId]);
  if (!par || par.chatwoot_inbox_id === null) return null;
  const t = await fnUma<Tenant>(db, 'api_n8n_tenant_por_chatwoot', [par.chatwoot_account_id, par.chatwoot_inbox_id]);
  return t && t.tenant_id === tenantId ? t : null;
}
