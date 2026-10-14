/**
 * A DIFERENÇA entre dois prompts, por linha — puro, sem React e sem banco.
 *
 * POR QUE EXISTE. O método 2 é "o assistente propõe, o cliente aprova", e
 * aprovar um prompt de 12 KB sem ver o que mudou não é aprovar: é assinar em
 * branco. A proposta devolve o prompt INTEIRO reescrito (é o que permite
 * aplicá-la com uma Server Action que já existe), então a tela precisa saber
 * dizer "estas três linhas saíram, esta entrou".
 *
 * LCS clássico por linhas. O custo é |a|×|b| células: um prompt de 300 linhas
 * contra outro de 300 dá 90 mil, que em JavaScript é instantâneo. Acima do
 * teto a função desiste e devolve "trocou tudo" — honesto e previsível é melhor
 * que travar a tela de um cliente com um prompt gigante.
 */

export type Pedaco =
  | { tipo: 'igual'; linhas: string[] }
  | { tipo: 'fora'; linhas: string[] }
  | { tipo: 'dentro'; linhas: string[] };

/** Acima disto, não vale a pena diferenciar linha a linha. */
export const MAX_LINHAS = 1_200;

/** Quantas linhas iguais são mostradas em volta de uma mudança. */
export const CONTEXTO_LINHAS = 2;

const quebrar = (s: string): string[] => String(s ?? '').split(/\r?\n/);

/**
 * Os pedaços, em ordem, cobrindo os dois textos.
 *
 * `fora` é linha que existia e sai; `dentro` é linha que entra. Linha movida
 * aparece como as duas coisas — e está certo: para quem vai aprovar, mover é
 * uma mudança.
 */
export function diferenca(antes: string, depois: string): Pedaco[] {
  const a = quebrar(antes);
  const b = quebrar(depois);
  if (a.length > MAX_LINHAS || b.length > MAX_LINHAS) {
    return [{ tipo: 'fora', linhas: a }, { tipo: 'dentro', linhas: b }];
  }

  // LCS por tamanho: m[i][j] = maior subsequência comum de a[i:] e b[j:].
  const m: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      m[i]![j] = a[i] === b[j] ? m[i + 1]![j + 1]! + 1 : Math.max(m[i + 1]![j]!, m[i]![j + 1]!);
    }
  }

  const saida: Pedaco[] = [];
  const empurrar = (tipo: Pedaco['tipo'], linha: string) => {
    const ultimo = saida[saida.length - 1];
    if (ultimo && ultimo.tipo === tipo) ultimo.linhas.push(linha);
    else saida.push({ tipo, linhas: [linha] } as Pedaco);
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { empurrar('igual', a[i]!); i++; j++; }
    else if (m[i + 1]![j]! >= m[i]![j + 1]!) { empurrar('fora', a[i]!); i++; }
    else { empurrar('dentro', b[j]!); j++; }
  }
  while (i < a.length) { empurrar('fora', a[i]!); i++; }
  while (j < b.length) { empurrar('dentro', b[j]!); j++; }
  return saida;
}

/**
 * Esconde os trechos longos que não mudaram, deixando algumas linhas de
 * contexto em volta de cada mudança.
 *
 * Sem isto, a diferença de um prompt de 300 linhas com três mudanças mostra 300
 * linhas, e quem aprova procura a mudança com o dedo na tela — que é o mesmo
 * que não mostrar.
 */
export function resumir(pedacos: Pedaco[], contexto = CONTEXTO_LINHAS): (Pedaco | { tipo: 'pulo'; linhas: number })[] {
  const saida: (Pedaco | { tipo: 'pulo'; linhas: number })[] = [];
  for (const [k, p] of pedacos.entries()) {
    if (p.tipo !== 'igual') { saida.push(p); continue; }
    const primeiro = k === 0;
    const ultimo = k === pedacos.length - 1;
    // Guardar contexto só do lado que tem mudança: no começo e no fim do texto
    // não há nada para contextualizar.
    const antes = primeiro ? 0 : contexto;
    const depois = ultimo ? 0 : contexto;
    if (p.linhas.length <= antes + depois) { saida.push(p); continue; }
    if (antes) saida.push({ tipo: 'igual', linhas: p.linhas.slice(0, antes) });
    saida.push({ tipo: 'pulo', linhas: p.linhas.length - antes - depois });
    if (depois) saida.push({ tipo: 'igual', linhas: p.linhas.slice(-depois) });
  }
  return saida;
}

/** Quantas linhas saem e quantas entram — o resumo de uma linha para o cliente. */
export function contagem(pedacos: Pedaco[]): { fora: number; dentro: number } {
  return {
    fora: pedacos.filter((p) => p.tipo === 'fora').reduce((n, p) => n + p.linhas.length, 0),
    dentro: pedacos.filter((p) => p.tipo === 'dentro').reduce((n, p) => n + p.linhas.length, 0),
  };
}
