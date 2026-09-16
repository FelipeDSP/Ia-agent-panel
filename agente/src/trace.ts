/**
 * O trace por turno (DESENHO §6) — a substituição da UI de execuções do n8n.
 * Tudo por `api_agente_*`; o truncamento acontece no banco (§6).
 */
import { fnValor, type Db } from './db.ts';
import { log, erroTexto } from './log.ts';

export type TipoPasso = 'entrada' | 'memoria' | 'modelo' | 'tool' | 'portao' | 'envio' | 'registro' | 'falha';

export class Turno {
  readonly db: Db;
  readonly tenantId: string;
  readonly id: string;
  private ordem = 0;

  constructor(db: Db, tenantId: string, id: string) {
    this.db = db;
    this.tenantId = tenantId;
    this.id = id;
  }

  static async abrir(db: Db, p: {
    tenantId: string; conversationId: number; filaId: string | null;
    acao: string | null; perfil: string | null; modelo: string | null; promptHash: string | null;
  }): Promise<Turno> {
    const id = await fnValor<string>(db, 'api_agente_turno_abrir',
      [p.tenantId, p.conversationId, p.filaId, p.acao, p.perfil, p.modelo, p.promptHash]);
    return new Turno(db, p.tenantId, id);
  }

  /** Grava um passo. Nunca lança: trace que derruba o turno é pior que trace ausente. */
  async passo(tipo: TipoPasso, nome: string, dados: { entrada?: unknown; saida?: unknown; erro?: string | null; duracaoMs?: number | null } = {}): Promise<void> {
    this.ordem += 1;
    try {
      await fnValor(this.db, 'api_agente_passo', [
        this.tenantId, this.id, this.ordem, tipo, nome,
        dados.entrada === undefined ? null : JSON.stringify(dados.entrada),
        dados.saida === undefined ? null : JSON.stringify(dados.saida),
        dados.erro ?? null, dados.duracaoMs ?? null,
      ]);
    } catch (e) {
      // deliberado (ver acima) — mas visível no log do processo.
      log('erro', 'trace.passo_falhou', { turno: this.id, tipo, nome, erro: erroTexto(e) });
    }
  }

  /** Mede a duração de `fn` e grava o passo com o resultado ou o erro. Relança o erro. */
  async medir<T>(tipo: TipoPasso, nome: string, entrada: unknown, fn: () => Promise<T>, resumo?: (r: T) => unknown): Promise<T> {
    const t0 = Date.now();
    try {
      const r = await fn();
      await this.passo(tipo, nome, { entrada, saida: resumo ? resumo(r) : r, duracaoMs: Date.now() - t0 });
      return r;
    } catch (e) {
      await this.passo('falha', nome, { entrada, erro: e instanceof Error ? `${e.name}: ${e.message}` : String(e), duracaoMs: Date.now() - t0 });
      throw e;
    }
  }

  async fechar(p: {
    status: 'ok' | 'falhou' | 'descartado' | 'manutencao';
    usageEntrada?: number | null; usageSaida?: number | null; chamadasModelo?: number | null; toolsChamadas?: number | null;
    portaoVeredito?: string | null; mensagensLogSaidaId?: string | null; erro?: string | null;
  }): Promise<void> {
    try {
      await fnValor(this.db, 'api_agente_turno_fechar', [
        this.tenantId, this.id, p.status, p.usageEntrada ?? null, p.usageSaida ?? null,
        p.chamadasModelo ?? null, p.toolsChamadas ?? null, p.portaoVeredito ?? null,
        p.mensagensLogSaidaId ?? null, p.erro ?? null,
      ]);
    } catch (e) {
      log('erro', 'trace.fechar_falhou', { turno: this.id, erro: erroTexto(e) });
    }
  }
}
