/**
 * Manutenção — o que o n8n não tem e o desenho exige (§1 e §6):
 *
 *   retenção   1x por dia: `api_agente_varrer_passos(dias)`, e o total
 *              removido vai para um turno sintético `manutencao` — a limpeza
 *              é visível, não silenciosa;
 *   agente mudo  a cada ciclo: tenant em 'codigo' com ENTRADA em
 *              `mensagens_log` e nenhuma SAÍDA depois dela por mais de N
 *              minutos -> aviso por WAHA (uma vez por tenant por hora, para
 *              não virar laço de aviso).
 *
 * As duas leituras vêm de funções (`api_agente_mudos`), porque o role não lê
 * tabela nenhuma.
 */
import { fnTodas, fnValor, type Db } from './db.ts';
import type { Waha } from './waha/notificar.ts';
import { log, erroTexto } from './log.ts';

export interface DepsManutencao { db: Db; waha: Waha | null; retencaoDias: number; mudoMinutos: number; alarme: { sessao: string; destino: string } | null }

export async function varrerRetencao(deps: DepsManutencao): Promise<number> {
  const n = Number(await fnValor<number>(deps.db, 'api_agente_varrer_passos', [deps.retencaoDias]) ?? 0);
  log('info', 'manutencao.retencao', { removidos: n, dias: deps.retencaoDias });
  return n;
}

interface Mudo { tenant_id: string; slug: string; ultima_entrada: Date; minutos_mudo: number }

const avisados = new Map<string, number>();   // tenant_id -> quando avisou (ms)

export async function alarmeAgenteMudo(deps: DepsManutencao, agora = Date.now()): Promise<Mudo[]> {
  const mudos = await fnTodas<Mudo>(deps.db, 'api_agente_mudos', [deps.mudoMinutos]);
  for (const m of mudos) {
    const ultimo = avisados.get(m.tenant_id) ?? 0;
    if (agora - ultimo < 60 * 60 * 1000) continue;
    avisados.set(m.tenant_id, agora);
    log('erro', 'alarme.agente_mudo', { tenant: m.slug, minutos: m.minutos_mudo });
    if (deps.waha && deps.alarme) {
      try {
        await deps.waha.enviarTexto(deps.alarme.sessao, deps.alarme.destino,
          `🔇 AGENTE MUDO: ${m.slug} recebeu mensagem há ${Math.round(m.minutos_mudo)} min e não respondeu (agente em código).`);
      } catch (e) {
        log('erro', 'alarme.waha_falhou', { erro: erroTexto(e) });
      }
    }
  }
  return mudos;
}
