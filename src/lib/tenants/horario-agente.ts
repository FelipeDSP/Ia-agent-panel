/**
 * Horário de atendimento do AGENTE (`tenants.horario_agente`, migração 74).
 *
 * É do CLIENTE (está na whitelist do guard de `tenants`). NULL = sempre
 * aberto. O serviço lê com `lerHorarioAgente` (agente/src/tenant/horario.ts) e
 * assume os mesmos defaults; mudar nome de chave aqui é mudar lá.
 *
 *   { timezone, dias_semana[], hora_inicio, hora_fim,
 *     fechados: ['YYYY-MM-DD'], fora_horario: 'aviso'|'silencio'|'atender', mensagem? }
 *
 * Puro: importado pelo formulário no browser.
 */
// relativo (não `@/`): o teste puro `tests/horario-agente.mjs` importa este arquivo pelo loader TS
import { DIAS_SEMANA, TIMEZONES_BR, type Horario } from '../tools/transferir-humano';

export { DIAS_SEMANA, TIMEZONES_BR };

export const POSTURAS = [
  { valor: 'aviso', rotulo: 'Avisar que está fechado', resumo: 'Uma mensagem por conversa dizendo que está fechado e quando abre; depois fica em silêncio até abrir.' },
  { valor: 'silencio', rotulo: 'Não responder', resumo: 'O agente não responde fora do horário. As mensagens ficam no Chatwoot e entram na memória dele.' },
  { valor: 'atender', rotulo: 'Atender mesmo fechado', resumo: 'Responde normalmente, mas sabe que a loja está fechada: não promete retirada agora e deixa o pedido para quando abrir.' },
] as const;
export type Postura = (typeof POSTURAS)[number]['valor'];

export type HorarioAgente = Horario & {
  fechados: string[];
  fora_horario: Postura;
  mensagem?: string;
};

export const MAX_MENSAGEM = 300;
export const MAX_FECHADOS = 60;

/** jsonb do banco → forma da tela; null = sempre aberto (sem horário). */
export function lerHorarioAgente(bruto: unknown): HorarioAgente | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const h = bruto as Record<string, unknown>;
  const dias = Array.isArray(h['dias_semana']) ? h['dias_semana'].map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [1, 2, 3, 4, 5];
  const ini = Number(h['hora_inicio']); const fim = Number(h['hora_fim']);
  const p = h['fora_horario'];
  return {
    timezone: typeof h['timezone'] === 'string' && (TIMEZONES_BR as readonly string[]).includes(h['timezone']) ? h['timezone'] : 'America/Sao_Paulo',
    dias_semana: [...new Set(dias)],
    hora_inicio: Number.isInteger(ini) && ini >= 0 && ini <= 23 ? ini : 8,
    hora_fim: Number.isInteger(fim) && fim >= 1 && fim <= 24 ? fim : 18,
    fechados: Array.isArray(h['fechados']) ? h['fechados'].filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) : [],
    fora_horario: p === 'silencio' || p === 'atender' ? p : 'aviso',
    ...(typeof h['mensagem'] === 'string' && h['mensagem'].trim() ? { mensagem: h['mensagem'].trim() } : {}),
  };
}

type Resultado<T> = { ok: true; valor: T } | { ok: false; erros: Record<string, string> };

function inteiro(fd: FormData, campo: string): number | null {
  const bruto = String(fd.get(campo) ?? '').trim();
  if (bruto === '') return null;
  const n = Number(bruto);
  return Number.isInteger(n) ? n : null;
}

/** Uma data por linha (ou separadas por vírgula), `YYYY-MM-DD` ou `DD/MM/YYYY`. */
export function lerDatasFechadas(bruto: string): { datas: string[]; invalidas: string[] } {
  const datas: string[] = []; const invalidas: string[] = [];
  for (const tok of bruto.split(/[\n,;]+/).map((t) => t.trim()).filter(Boolean)) {
    let iso: string | null = null;
    const br = tok.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (br) iso = `${br[3]}-${br[2]!.padStart(2, '0')}-${br[1]!.padStart(2, '0')}`;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) iso = tok;
    if (iso) {
      const d = new Date(`${iso}T12:00:00Z`);
      if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso) { if (!datas.includes(iso)) datas.push(iso); continue; }
    }
    invalidas.push(tok);
  }
  return { datas: datas.sort(), invalidas };
}

/**
 * Valida o formulário do cliente. `ativo` desligado → `null` (sempre aberto),
 * e o resto do formulário nem é olhado.
 */
export function validarHorarioAgente(fd: FormData): Resultado<HorarioAgente | null> {
  const ativo = fd.get('horario_ativo') === 'on' || fd.get('horario_ativo') === 'true';
  if (!ativo) return { ok: true, valor: null };

  const erros: Record<string, string> = {};
  const timezone = String(fd.get('timezone') ?? '').trim();
  if (!(TIMEZONES_BR as readonly string[]).includes(timezone)) erros['timezone'] = 'Escolha um fuso horário válido.';

  const dias_semana = DIAS_SEMANA.map((d) => d.valor).filter((v) => fd.get(`dia_${v}`) === 'on');
  if (dias_semana.length === 0) erros['dias_semana'] = 'Selecione ao menos um dia.';

  const hora_inicio = inteiro(fd, 'hora_inicio');
  const hora_fim = inteiro(fd, 'hora_fim');
  if (hora_inicio === null || hora_inicio < 0 || hora_inicio > 23) erros['hora_inicio'] = 'Hora de início entre 0 e 23.';
  if (hora_fim === null || hora_fim < 1 || hora_fim > 24) erros['hora_fim'] = 'Hora de fim entre 1 e 24.';
  if (hora_inicio !== null && hora_fim !== null && !erros['hora_inicio'] && !erros['hora_fim'] && hora_inicio >= hora_fim) {
    erros['hora_fim'] = 'A hora de fim precisa ser maior que a de início.';
  }

  const { datas, invalidas } = lerDatasFechadas(String(fd.get('fechados') ?? ''));
  if (invalidas.length) erros['fechados'] = `Data inválida: ${invalidas.slice(0, 3).join(', ')}. Use DD/MM/AAAA, uma por linha.`;
  if (datas.length > MAX_FECHADOS) erros['fechados'] = `No máximo ${MAX_FECHADOS} datas.`;

  const posturaBruta = String(fd.get('fora_horario') ?? 'aviso');
  const fora_horario: Postura = posturaBruta === 'silencio' || posturaBruta === 'atender' ? posturaBruta : 'aviso';

  const mensagem = String(fd.get('mensagem') ?? '').trim();
  if (mensagem.length > MAX_MENSAGEM) erros['mensagem'] = `Mensagem com no máximo ${MAX_MENSAGEM} caracteres.`;

  if (Object.keys(erros).length > 0) return { ok: false, erros };
  return {
    ok: true,
    valor: {
      timezone, dias_semana, hora_inicio: hora_inicio as number, hora_fim: hora_fim as number,
      fechados: datas, fora_horario, ...(mensagem ? { mensagem } : {}),
    },
  };
}

/** Para preencher o textarea: `DD/MM/AAAA` por linha. */
export function datasParaExibir(fechados: string[] | undefined): string {
  return (fechados ?? []).map((d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`).join('\n');
}
