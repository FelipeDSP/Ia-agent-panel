/**
 * Horário de atendimento do AGENTE (migração 74) — o do estabelecimento, que o
 * cliente configura em Configurações. Não confundir com o horário da
 * transferência (`transferir_humano.config.horario`), que diz quando há
 * humano. NULL/ausente = sempre aberto: é o comportamento de antes.
 *
 * Tudo puro e com `agora` injetável: teste nenhum afirma relógio de parede.
 */
export type Postura = 'aviso' | 'silencio' | 'atender';

export interface HorarioAgente {
  timezone: string;
  diasSemana: number[];          // 0 = dom … 6 = sáb
  horaInicio: number;            // 0..23
  horaFim: number;               // 1..24 (exclusivo)
  fechados: string[];            // 'YYYY-MM-DD' no fuso do tenant
  foraHorario: Postura;
  mensagem: string | null;       // null = texto padrão
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export function lerHorarioAgente(bruto: unknown): HorarioAgente | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const h = bruto as Record<string, unknown>;
  const dias = Array.isArray(h['dias_semana']) ? h['dias_semana'].map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [1, 2, 3, 4, 5];
  const ini = Number(h['hora_inicio']); const fim = Number(h['hora_fim']);
  const postura = h['fora_horario'];
  return {
    timezone: typeof h['timezone'] === 'string' && h['timezone'] ? h['timezone'] : 'America/Sao_Paulo',
    diasSemana: [...new Set(dias)],
    horaInicio: Number.isInteger(ini) && ini >= 0 && ini <= 23 ? ini : 8,
    horaFim: Number.isInteger(fim) && fim >= 1 && fim <= 24 ? fim : 18,
    fechados: Array.isArray(h['fechados']) ? h['fechados'].filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) : [],
    foraHorario: postura === 'silencio' || postura === 'atender' ? postura : 'aviso',
    mensagem: typeof h['mensagem'] === 'string' && h['mensagem'].trim() ? h['mensagem'].trim() : null,
  };
}

/** Data/hora locais no fuso do tenant. */
function local(h: HorarioAgente, agora: Date): { data: string; diaSemana: number; hora: number } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: h.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: 'numeric', hour12: false });
  const p = Object.fromEntries(f.formatToParts(agora).map((x) => [x.type, x.value]));
  const mapa: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { data: `${p.year}-${p.month}-${p.day}`, diaSemana: mapa[p.weekday ?? ''] ?? -1, hora: parseInt(p.hour ?? '0', 10) % 24 };
}

export interface Situacao { aberto: boolean; motivo: 'aberto' | 'dia_fechado' | 'data_fechada' | 'fora_da_hora'; proximaAbertura: string | null }

/**
 * Está aberto agora? Quando não, diz por quê e QUANDO abre (texto humano, para
 * o aviso e para o prompt), procurando até 14 dias à frente.
 */
export function situacao(h: HorarioAgente | null, agora = new Date()): Situacao {
  if (!h) return { aberto: true, motivo: 'aberto', proximaAbertura: null };
  const l = local(h, agora);
  const abreNoDia = (data: string, dia: number) => h.diasSemana.includes(dia) && !h.fechados.includes(data);
  let motivo: Situacao['motivo'] = 'aberto';
  if (h.fechados.includes(l.data)) motivo = 'data_fechada';
  else if (!h.diasSemana.includes(l.diaSemana)) motivo = 'dia_fechado';
  else if (!(l.hora >= h.horaInicio && l.hora < h.horaFim)) motivo = 'fora_da_hora';
  if (motivo === 'aberto') return { aberto: true, motivo, proximaAbertura: null };

  // próxima abertura: hoje mais tarde (antes do início) ou o próximo dia que abre
  const hh = `${String(h.horaInicio).padStart(2, '0')}h`;
  if (motivo === 'fora_da_hora' && l.hora < h.horaInicio && abreNoDia(l.data, l.diaSemana)) {
    return { aberto: false, motivo, proximaAbertura: `hoje às ${hh}` };
  }
  for (let i = 1; i <= 14; i++) {
    const d = new Date(agora.getTime() + i * 86_400_000);
    const ld = local(h, d);
    if (abreNoDia(ld.data, ld.diaSemana)) {
      return { aberto: false, motivo, proximaAbertura: `${i === 1 ? 'amanhã' : `${DIAS[ld.diaSemana]} (${ld.data.slice(8, 10)}/${ld.data.slice(5, 7)})`} às ${hh}` };
    }
  }
  return { aberto: false, motivo, proximaAbertura: null };
}

/** O aviso que o cliente lê. `{proxima}` no texto do tenant vira a próxima abertura. */
export function textoDoAviso(h: HorarioAgente, s: Situacao): string {
  const prox = s.proximaAbertura ? ` Voltamos ${s.proximaAbertura}.` : '';
  if (h.mensagem) return h.mensagem.replace(/\{proxima\}/gi, s.proximaAbertura ?? '').replace(/\s{2,}/g, ' ').trim();
  return `Olá! No momento estamos fechados.${prox} Sua mensagem fica registrada e respondemos assim que abrirmos. 😊`;
}

/** Linha do prompt quando a postura é `atender` fora do horário. */
export function linhaDoPromptFechado(s: Situacao): string {
  return '## Atenção: a loja está FECHADA agora\n'
    + `- Não prometa retirada, entrega ou atendimento imediato. ${s.proximaAbertura ? `A loja volta a abrir ${s.proximaAbertura}.` : ''}\n`
    + '- Pode tirar dúvidas e anotar pedido, deixando claro que ele fica para quando a loja abrir.\n\n';
}
