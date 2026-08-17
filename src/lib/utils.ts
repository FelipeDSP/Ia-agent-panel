import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Junta classes resolvendo conflitos do Tailwind. Convencao do shadcn/ui. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const formatadorData = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export function formatarData(valor: string | null): string {
  if (!valor) return '—';
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '—';
  return formatadorData.format(data);
}

const formatadorDataUTC = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * Data de um TIMESTAMPTZ que representa uma FRONTEIRA DE DIA, não um instante.
 *
 * `formatarData` renderiza no fuso do cliente, e para instante isso é o certo.
 * Para fronteira de dia é errado por um dia inteiro: `precos_modelo.vigente_desde`
 * é gravado como `2025-01-01T00:00:00+00` e a tabela de preços exibia
 * **31/12/2024** em UTC−3 — numa tela cuja pergunta é exatamente "a partir de que
 * data este preço vale". Aqui o fuso é fixado em UTC, o mesmo em que o valor foi
 * escrito e em que a RPC compara `vigente_desde <= criado_em`.
 *
 * Não troquei `formatarData`: as outras telas exibem instante (criação, envio),
 * onde o fuso local é o comportamento desejado. Ver `AUDIT-A11Y-I18N.md`.
 */
export function formatarDataUTC(valor: string | null): string {
  if (!valor) return '—';
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '—';
  return formatadorDataUTC.format(data);
}

export function formatarDataHora(valor: string | null): string {
  if (!valor) return '—';
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '—';
  return data.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
