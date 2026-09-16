/**
 * Manutenção — o que o n8n não tem e o desenho exige (§1 e §6):
 *
 *   retenção   1x por dia: `api_agente_varrer_passos(dias)`, e o total
 *              removido vai para um turno sintético `manutencao` — a limpeza
 *              é visível, não silenciosa;
 *   encerramento a cada `ENCERRAMENTO.intervalo_minutos` (5): links de pagamento
 *              vencidos são desativados no Asaas e as cobranças PENDING deles
 *              removidas (migração 64; docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md
 *              §12). O Asaas NUNCA fecha o link sozinho — sem isto o cliente
 *              que nunca volta paga um pedido morto;
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
import type { Asaas } from './pagamento/asaas.ts';

export interface DepsManutencao { db: Db; waha: Waha | null; retencaoDias: number; mudoMinutos: number; alarme: { sessao: string; destino: string } | null; asaas?: Asaas | null }

interface CobrancaVencida { tenant_id: string; cobranca_id: string; link_id: string; ambiente: string; base_url: string; api_key: string; expira_em: Date; tentativas_detalhe: string | null }

export interface ResultadoEncerramento { vencidas: number; encerradas: number; falhas: number }

/**
 * Os DOIS passos por cobrança vencida, na ordem que a sonda D obriga:
 * desativar o link primeiro (para não nascer cobrança nova no meio) e remover
 * as PENDING depois. `confirmar_encerramento(ok=true)` só com os dois 2xx;
 * senão grava o detalhe e a próxima varredura tenta de novo. A chave é a do
 * tenant da cobrança e não sai daqui.
 */
export async function encerrarLinksVencidos(deps: DepsManutencao): Promise<ResultadoEncerramento> {
  const r: ResultadoEncerramento = { vencidas: 0, encerradas: 0, falhas: 0 };
  if (!deps.asaas) return r;
  const vencidas = await fnTodas<CobrancaVencida>(deps.db, 'api_n8n_cobrancas_a_encerrar', [50]);
  r.vencidas = vencidas.length;
  for (const c of vencidas) {
    const passos: string[] = [];
    let ok = false;
    try {
      const d = await deps.asaas.desativarLink(c.base_url, c.api_key, c.link_id);
      passos.push(`PUT ${d.status}`);
      if (d.ok) {
        const p = await deps.asaas.cobrancasPendentes(c.base_url, c.api_key, c.link_id);
        passos.push(`GET ${p.status} pendentes=${p.ids.length}`);
        if (p.ok) {
          let removidas = 0;
          for (const id of p.ids) {
            const x = await deps.asaas.removerCobranca(c.base_url, c.api_key, id);
            passos.push(`DELETE ${id} ${x.status}`);
            // 404 = já removida (varredura anterior parcial): conta como feito.
            if (x.ok || x.status === 404) removidas++;
          }
          ok = removidas === p.ids.length;
        }
      }
    } catch (e) {
      passos.push(erroTexto(e));
    }
    const detalhe = passos.join('; ').slice(0, 500);
    try {
      await fnValor(deps.db, 'api_n8n_confirmar_encerramento', [c.tenant_id, c.cobranca_id, ok, detalhe]);
    } catch (e) {
      log('erro', 'encerramento.confirmar_falhou', { cobranca: c.cobranca_id, erro: erroTexto(e) });
    }
    if (ok) r.encerradas++; else r.falhas++;
    log(ok ? 'info' : 'aviso', 'encerramento.link', { tenant: c.tenant_id, cobranca: c.cobranca_id, link: c.link_id, ok, detalhe });
  }
  return r;
}

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
