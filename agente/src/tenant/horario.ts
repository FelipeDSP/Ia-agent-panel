/**
 * Horário de atendimento do AGENTE (migração 74) — o do estabelecimento, que o
 * cliente configura em Configurações. Não confundir com o horário da
 * transferência (`transferir_humano.config.horario`), que diz quando há
 * humano. NULL/ausente = sempre aberto: é o comportamento de antes.
 *
 * Tudo puro e com `agora` injetável: teste nenhum afirma relógio de parede.
 *
 * ---------------------------------------------------------------------------
 * JANELAS (07/10) — por que a forma mudou
 *
 * A 74 modelou o horário como UMA faixa por semana: `dias_semana` + uma hora
 * de início e uma de fim. O Empório abre **ter–sex das 7h às 10h e das 16h às
 * 19h**, e sáb/dom das 8h às 11h. Isso não cabia, e o que estava gravado era
 * a união grosseira (7h–19h, todos os dias menos segunda). O efeito não era
 * teórico: às 12h de uma quarta o agente respondia "estamos abertos", com a
 * loja fechada havia duas horas, e marcava retirada para um horário em que
 * não há ninguém no balcão.
 *
 * A chave nova é `janelas`, e a leitura é ADITIVA — ausente, uma janela é
 * derivada do par legado, então toda conta viva segue byte a byte igual:
 *
 *   "janelas": [
 *     { "dias": [2,3,4,5], "inicio": "07:00", "fim": "10:00" },
 *     { "dias": [2,3,4,5], "inicio": "16:00", "fim": "19:00" },
 *     { "dias": [0,6],     "inicio": "08:00", "fim": "11:00" }
 *   ]
 *
 * Os campos legados CONTINUAM sendo gravados pelo painel (a união das
 * janelas). Não é redundância decorativa: painel e serviço são deploys
 * separados, e um serviço que ainda não subiu precisa ler algo coerente em
 * vez de achar que a loja nunca abre. Ele erra para "aberto demais", que é
 * exatamente o que ele já fazia.
 *
 * Minuto, e não hora cheia, porque meia hora é comum em comércio (a secretaria
 * do CEEJAAR abre 7h30) e porque custa o mesmo.
 */
export type Postura = 'aviso' | 'silencio' | 'atender';

/** Uma faixa contínua de atendimento, nos dias que ela cobre. */
export interface Janela {
  dias: number[];   // 0 = dom … 6 = sáb
  inicio: number;   // minutos desde a meia-noite local
  fim: number;      // minutos, exclusivo
}

export interface HorarioAgente {
  timezone: string;
  diasSemana: number[];          // 0 = dom … 6 = sáb (legado; a união de `janelas`)
  horaInicio: number;            // 0..23 (legado)
  horaFim: number;               // 1..24 (exclusivo, legado)
  janelas: Janela[];             // a verdade; nunca vazio
  fechados: string[];            // 'YYYY-MM-DD' no fuso do tenant
  foraHorario: Postura;
  mensagem: string | null;       // null = texto padrão
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DIAS_CURTO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** `"07:00"` / `"7"` / `7` → minutos; null quando não dá para ler. */
export function minutosDe(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 24) return v * 60;
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]); const min = m[2] ? Number(m[2]) : 0;
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  const total = h * 60 + min;
  return total >= 0 && total <= 24 * 60 ? total : null;
}

/** `420` → `07h`; `450` → `07h30`. O sufixo de minuto só aparece quando existe. */
export function horaHumana(minutos: number): string {
  const h = Math.floor(minutos / 60); const m = minutos % 60;
  return `${String(h).padStart(2, '0')}h${m ? String(m).padStart(2, '0') : ''}`;
}

function lerJanelas(bruto: unknown): Janela[] {
  if (!Array.isArray(bruto)) return [];
  const out: Janela[] = [];
  for (const item of bruto) {
    if (!item || typeof item !== 'object') continue;
    const j = item as Record<string, unknown>;
    const dias = Array.isArray(j['dias']) ? [...new Set(j['dias'].map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
    const inicio = minutosDe(j['inicio']); const fim = minutosDe(j['fim']);
    // Janela sem dia, sem horas ou invertida é descartada em silêncio, como
    // todo o resto da leitura: config torta não pode derrubar o atendimento.
    if (dias.length === 0 || inicio === null || fim === null || fim <= inicio) continue;
    out.push({ dias, inicio, fim });
  }
  return out;
}

export function lerHorarioAgente(bruto: unknown): HorarioAgente | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const h = bruto as Record<string, unknown>;
  const dias = Array.isArray(h['dias_semana']) ? h['dias_semana'].map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [1, 2, 3, 4, 5];
  const ini = Number(h['hora_inicio']); const fim = Number(h['hora_fim']);
  const postura = h['fora_horario'];
  const diasSemana = [...new Set(dias)];
  const horaInicio = Number.isInteger(ini) && ini >= 0 && ini <= 23 ? ini : 8;
  const horaFim = Number.isInteger(fim) && fim >= 1 && fim <= 24 ? fim : 18;
  const janelas = lerJanelas(h['janelas']);
  return {
    timezone: typeof h['timezone'] === 'string' && h['timezone'] ? h['timezone'] : 'America/Sao_Paulo',
    diasSemana,
    horaInicio,
    horaFim,
    // Sem `janelas` (ou com todas inválidas), a faixa legada É a janela. É o
    // que mantém toda conta de hoje idêntica.
    janelas: janelas.length ? janelas : [{ dias: diasSemana, inicio: horaInicio * 60, fim: horaFim * 60 }],
    fechados: Array.isArray(h['fechados']) ? h['fechados'].filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) : [],
    foraHorario: postura === 'silencio' || postura === 'atender' ? postura : 'aviso',
    mensagem: typeof h['mensagem'] === 'string' && h['mensagem'].trim() ? h['mensagem'].trim() : null,
  };
}

/** Data/hora locais no fuso do tenant. */
function local(h: HorarioAgente, agora: Date): { data: string; diaSemana: number; minuto: number } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: h.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(agora).map((x) => [x.type, x.value]));
  const mapa: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hora = parseInt(p.hour ?? '0', 10) % 24;
  return { data: `${p.year}-${p.month}-${p.day}`, diaSemana: mapa[p.weekday ?? ''] ?? -1, minuto: hora * 60 + parseInt(p.minute ?? '0', 10) };
}

/** As janelas de um dia da semana, da mais cedo para a mais tarde. */
export function janelasDoDia(h: HorarioAgente, dia: number): Janela[] {
  return h.janelas.filter((j) => j.dias.includes(dia)).sort((a, b) => a.inicio - b.inicio);
}

export interface Situacao { aberto: boolean; motivo: 'aberto' | 'dia_fechado' | 'data_fechada' | 'fora_da_hora'; proximaAbertura: string | null }

/**
 * Está aberto agora? Quando não, diz por quê e QUANDO abre (texto humano, para
 * o aviso e para o prompt), procurando até 14 dias à frente.
 *
 * A próxima abertura olha primeiro as janelas de HOJE que ainda vão começar —
 * é o caso do intervalo de almoço, que a forma de uma faixa só não tinha como
 * representar: às 12h de uma quarta a resposta certa é "hoje às 16h", não
 * "amanhã às 07h".
 */
export function situacao(h: HorarioAgente | null, agora = new Date()): Situacao {
  if (!h) return { aberto: true, motivo: 'aberto', proximaAbertura: null };
  const l = local(h, agora);
  const doDia = janelasDoDia(h, l.diaSemana);

  let motivo: Situacao['motivo'] = 'aberto';
  if (h.fechados.includes(l.data)) motivo = 'data_fechada';
  else if (doDia.length === 0) motivo = 'dia_fechado';
  else if (!doDia.some((j) => l.minuto >= j.inicio && l.minuto < j.fim)) motivo = 'fora_da_hora';
  if (motivo === 'aberto') return { aberto: true, motivo, proximaAbertura: null };

  // Ainda abre hoje? (só quando o dia não está inteiro fechado)
  if (motivo === 'fora_da_hora') {
    const aindaHoje = doDia.find((j) => j.inicio > l.minuto);
    if (aindaHoje) return { aberto: false, motivo, proximaAbertura: `hoje às ${horaHumana(aindaHoje.inicio)}` };
  }
  for (let i = 1; i <= 14; i++) {
    const d = new Date(agora.getTime() + i * 86_400_000);
    const ld = local(h, d);
    const js = janelasDoDia(h, ld.diaSemana);
    if (js.length > 0 && !h.fechados.includes(ld.data)) {
      const quando = `${i === 1 ? 'amanhã' : `${DIAS[ld.diaSemana]} (${ld.data.slice(8, 10)}/${ld.data.slice(5, 7)})`} às ${horaHumana(js[0]!.inicio)}`;
      return { aberto: false, motivo, proximaAbertura: quando };
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

/**
 * A GRADE da semana, em texto, para o modelo responder "que horas abre?",
 * "abrem domingo?" e "estão abertos agora?" sem adivinhar.
 *
 * Por que isto existe (07/10): o horário estava escrito à mão no
 * `system_prompt` de quem tem loja — e horário no prompt é a mesma doença do
 * catálogo no prompt. Envelhece no dia em que muda, e o cliente que mudou em
 * Configurações continua sendo desmentido pelo texto. Derivando da config, a
 * fonte passa a ser uma só e muda na hora.
 *
 * Dias com a MESMA grade são agrupados ("terça a sexta"), porque a lista dia a
 * dia é longa e o modelo copia o que lê.
 */
export function secaoHorario(h: HorarioAgente, s: Situacao): string {
  const grade = (dia: number) => janelasDoDia(h, dia).map((j) => `${horaHumana(j.inicio)}–${horaHumana(j.fim)}`).join(' e ') || 'fechado';

  // Agrupa dias CONSECUTIVOS de grade igual. Começa na segunda: "terça a
  // sexta" é como o lojista fala, e domingo no fim evita "domingo, terça a..."
  const ordem = [1, 2, 3, 4, 5, 6, 0];
  const linhas: string[] = [];
  let i = 0;
  while (i < ordem.length) {
    const g = grade(ordem[i]!);
    let j = i;
    while (j + 1 < ordem.length && grade(ordem[j + 1]!) === g) j++;
    const nome = i === j ? DIAS[ordem[i]!]! : `${DIAS[ordem[i]!]} a ${DIAS[ordem[j]!]}`;
    linhas.push(`- ${nome}: ${g}`);
    i = j + 1;
  }

  let txt = '## Horário desta loja (fonte única — não repita horário vindo de outro lugar)\n' + linhas.join('\n') + '\n';
  if (h.fechados.length) txt += '- Há também datas específicas fechadas, já cadastradas: quando o cliente perguntar por um dia, confie nesta seção e no estado do sistema.\n';
  txt += s.aberto
    ? '- AGORA a loja está ABERTA.\n'
    : `- AGORA a loja está FECHADA.${s.proximaAbertura ? ` Abre ${s.proximaAbertura}.` : ''}\n`;
  txt += '- Nunca invente horário, nunca prometa atendimento fora dele e nunca marque retirada em hora fechada.\n\n';
  return txt;
}
