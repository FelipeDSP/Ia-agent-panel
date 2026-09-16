/**
 * O trace do agente em código, como o painel o lê.
 *
 * `agente_turnos` e `agente_passos` (migração 62) substituem a tela de
 * execuções do n8n: um turno por resposta, um passo por coisa que aconteceu
 * (sync, portão de entrada, transcrição, prompt, cada chamada ao modelo, cada
 * tool, portão de saída, envio, registro). A leitura é por RLS: super_admin vê
 * tudo, tenant_admin só o próprio — a policy da 62 é `auth_is_super_admin() or
 * tenant_id = auth_tenant_id()`, e o painel não repete a regra em SQL.
 *
 * Puro (sem `server-only`): o teste importa e exercita os filtros, o resumo e
 * o rótulo de cada estado sem banco.
 */
export type StatusTurno = 'aberto' | 'ok' | 'falhou' | 'descartado' | 'manutencao';

export interface TurnoLinha {
  id: string;
  tenant_id: string;
  conversation_id: number | string;
  acao: string | null;
  perfil: string | null;
  modelo: string | null;
  status: StatusTurno | string;
  usage_entrada: number | null;
  usage_saida: number | null;
  chamadas_modelo: number | null;
  tools_chamadas: number | null;
  portao_veredito: string | null;
  erro: string | null;
  iniciado_em: string;
  concluido_em: string | null;
}

export interface PassoLinha {
  id: string;
  turno_id: string;
  ordem: number;
  tipo: string;
  nome: string;
  entrada: unknown;
  saida: unknown;
  erro: string | null;
  duracao_ms: number | null;
  criado_em: string;
}

/** Os filtros da lista, lidos da query string e SANEADOS — nunca vão crus ao banco. */
export interface FiltrosTrace { tenantId: string | null; status: StatusTurno | null; horas: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: StatusTurno[] = ['aberto', 'ok', 'falhou', 'descartado', 'manutencao'];
export const HORAS_PERMITIDAS = [1, 6, 24, 72, 168] as const;

export function lerFiltros(q: Record<string, string | string[] | undefined>): FiltrosTrace {
  const um = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const tenant = um(q.tenant);
  const status = um(q.status) as StatusTurno;
  const horas = Number(um(q.horas));
  return {
    tenantId: UUID.test(tenant) ? tenant : null,
    status: STATUS.includes(status) ? status : null,
    horas: (HORAS_PERMITIDAS as readonly number[]).includes(horas) ? horas : 24,
  };
}

/** `iniciado_em >= desde` para o filtro de período. */
export function desde(horas: number, agora = new Date()): string {
  return new Date(agora.getTime() - horas * 3600 * 1000).toISOString();
}

export function duracaoMs(t: Pick<TurnoLinha, 'iniciado_em' | 'concluido_em'>): number | null {
  if (!t.concluido_em) return null;
  return new Date(t.concluido_em).getTime() - new Date(t.iniciado_em).getTime();
}

export function formatarDuracao(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

/** Cor do badge por estado — `falhou` e `barrado_*` são o que alguém precisa olhar. */
export function corDoStatus(status: string): 'success' | 'danger' | 'warning' | 'secondary' | 'outline' {
  if (status === 'ok') return 'success';
  if (status === 'falhou') return 'danger';
  if (status === 'aberto') return 'warning';
  if (status === 'descartado') return 'secondary';
  return 'outline';
}

export function corDoVeredito(v: string | null): 'success' | 'danger' | 'secondary' {
  if (!v) return 'secondary';
  return v === 'passou' ? 'success' : 'danger';
}

/** As tools chamadas num turno, a partir dos passos `tool` (com o que cada uma disse, resumido). */
export function toolsDoTurno(passos: PassoLinha[]): string[] {
  return passos.filter((p) => p.tipo === 'tool').map((p) => p.nome);
}

/** Os totais do período, para o cabeçalho da lista. */
export function resumo(turnos: TurnoLinha[]): { total: number; ok: number; falhou: number; barrados: number; tokens: number } {
  return turnos.reduce((a, t) => ({
    total: a.total + 1,
    ok: a.ok + (t.status === 'ok' ? 1 : 0),
    falhou: a.falhou + (t.status === 'falhou' ? 1 : 0),
    barrados: a.barrados + (t.portao_veredito && t.portao_veredito !== 'passou' ? 1 : 0),
    tokens: a.tokens + (t.usage_entrada ?? 0) + (t.usage_saida ?? 0),
  }), { total: 0, ok: 0, falhou: 0, barrados: 0, tokens: 0 });
}

/** O texto de um passo para a tela: o que importa de cada tipo, sem despejar JSON inteiro. */
export function linhaDoPasso(p: PassoLinha): string {
  const s = (p.saida ?? {}) as Record<string, unknown>;
  const e = (p.entrada ?? {}) as Record<string, unknown>;
  if (p.erro) return p.erro;
  switch (p.tipo) {
    case 'modelo': {
      const uso = s.usage as { entrada?: number; saida?: number } | undefined;
      const texto = typeof s.texto === 'string' ? s.texto : null;
      return `${uso ? `${uso.entrada ?? 0}/${uso.saida ?? 0} tokens · ` : ''}${s.tool_calls ? `${s.tool_calls} tool call(s)` : (texto ?? '')}`;
    }
    case 'tool': return typeof s.texto === 'string' ? s.texto : JSON.stringify(s);
    case 'portao': return typeof s.veredito === 'string' ? `veredito: ${s.veredito}` : JSON.stringify(s);
    case 'entrada': return typeof e.texto === 'string' ? e.texto : JSON.stringify(e);
    case 'memoria': return typeof s.mensagens === 'number' || typeof s.mensagens === 'string' ? `${s.mensagens} mensagens` : JSON.stringify(s);
    default: return JSON.stringify(s);
  }
}

export function jsonBonito(v: unknown): string {
  if (v === null || v === undefined) return '';
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
