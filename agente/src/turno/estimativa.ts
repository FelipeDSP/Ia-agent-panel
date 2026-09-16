/**
 * A ESTIMATIVA do n8n, calculada ao lado do número REAL — §5.8 do desenho
 * ("diff de custo: tokens reais × estimativa do `Estima Tokens` nos mesmos
 * turnos"). É o dado que decide se o rateio por componente pode viver da
 * estimativa ou precisa do `usage`.
 *
 * Porte da fórmula de `n8n/estima-tokens.js` (seção 2b), com as MESMAS
 * constantes que o gerador injeta no nó (`S_POR_PERFIL`, 3,11 chars/token,
 * memória a /4 — divergência herdada e mantida de propósito lá, então mantida
 * aqui). `tests/estimativa-n8n.mjs` lê o corpo do nó no JSON e exige que as
 * constantes batam: mudar lá sem mudar aqui acusa.
 *
 * O resultado NÃO vai para `mensagens_log` — `api_n8n_registrar_mensagem` só
 * mapeia as chaves que conhece e descartaria o resto. Vai para o trace, como
 * passo `registro:estimativa_n8n`, junto do real do mesmo turno; é o que o
 * `scripts/diff-custo.mjs` lê.
 */
export const S_POR_PERFIL: Record<string, number> = { basico: 266, vendas: 778 };
export const CRESCIMENTO_POR_CHAMADA = 55;
export const CHARS_POR_TOKEN = 3.11;

export const emTokens = (t: string | null | undefined): number => Math.ceil((t ?? '').length / CHARS_POR_TOKEN);

export interface EntradaEstimativa {
  perfil: string;
  chamadas: number;
  /** o wrapper: system message SEM o prompt do tenant (o `WRAPPER` do nó). */
  wrapper: string;
  systemPrompt: string;
  /** a(s) mensagem(ns) do cliente neste turno, já fundidas. */
  mensagens: string;
  /** `historico_chars` do `api_n8n_conversa_sync` — é o que o nó lê de `Sync Conversa`. */
  historicoChars: number;
  textoSaida: string;
}

export interface Estimativa {
  entrada: number;
  saida: number;
  componentes: { wrapper: number; system_prompt: number; schema_tools: number; mensagens: number; memoria: number; round_trip: number };
}

export function estimarComoN8n(e: EntradaEstimativa): Estimativa {
  const chamadas = Math.max(1, e.chamadas);
  const tokensFerramentas = S_POR_PERFIL[e.perfil] ?? S_POR_PERFIL.basico!;
  const componentes = {
    wrapper: chamadas * emTokens(e.wrapper),
    system_prompt: chamadas * emTokens(e.systemPrompt),
    mensagens: chamadas * emTokens(e.mensagens),
    schema_tools: chamadas * tokensFerramentas,
    memoria: chamadas * Math.ceil((e.historicoChars || 0) / 4),
    round_trip: CRESCIMENTO_POR_CHAMADA * ((chamadas * (chamadas - 1)) / 2),
  };
  const entrada = Object.values(componentes).reduce((a, b) => a + b, 0);
  return { entrada, saida: emTokens(e.textoSaida), componentes };
}

/** Desvio da estimativa em relação ao real, em % (positivo = estimou a mais). */
export function desvioPct(estimado: number, real: number): number | null {
  if (!real) return null;
  return Math.round(((estimado - real) / real) * 1000) / 10;
}
