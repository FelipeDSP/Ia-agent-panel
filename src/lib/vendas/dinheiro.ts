/**
 * Conversão reais <-> centavos. É a borda: valor em reais NUNCA chega ao banco,
 * centavo NUNCA aparece na tela.
 *
 * O banco guarda `preco_centavos` como integer justamente para não haver float
 * no caminho do dinheiro. Todo o parsing aqui trabalha em string e só vira
 * número inteiro no fim — `parseFloat('24.90') * 100` daria 2489.9999... e
 * `Math.round` esconderia o problema em vez de evitá-lo.
 *
 * Puro: sem imports, sem 'use server'/'use client'. Importável dos dois lados e
 * testável por `node tests/dinheiro.mjs`.
 */

export type ResultadoPreco =
  | { ok: true; centavos: number }
  | { ok: false; erro: string };

/** Limite defensivo: R$ 10.000.000,00. Acima disso é dedo escorregando, não preço. */
const MAX_CENTAVOS = 1_000_000_000;

/**
 * Separador só pode ser lido como milhar se o agrupamento fizer sentido:
 * primeiro grupo com 1 a 3 dígitos, os demais com exatamente 3.
 *
 * Sem isto, "24,90,5" seria lido como 24905 (R$ 249.050,00) em vez de recusado —
 * o cliente digitou errado e receberia um preço mil vezes maior, calado.
 */
function agrupamentoDeMilharValido(partes: string[]): boolean {
  if (partes.length < 2) return true;
  const primeiro = partes[0] ?? '';
  if (!/^\d{1,3}$/.test(primeiro)) return false;
  return partes.slice(1).every((p) => /^\d{3}$/.test(p));
}

/**
 * "24,90" | "24.90" | "1.234,56" | "R$ 24,90" | "1234" -> centavos.
 *
 * Aceita vírgula e ponto porque o cliente digita dos dois jeitos. As regras,
 * na ordem em que resolvem a ambiguidade:
 *
 *  - com vírgula E ponto: o ÚLTIMO separador é o decimal, o outro é milhar.
 *    "1.234,56" -> 1234.56 e "1,234.56" -> 1234.56.
 *  - só vírgula: é decimal ("24,9" -> 24.90). Duas ou mais vírgulas é milhar
 *    à moda inglesa sem decimais ("1,234,567").
 *  - só ponto, uma vez, com exatamente 3 dígitos depois: é MILHAR. "1.234" no
 *    Brasil é mil duzentos e trinta e quatro, não um e vinte e três.
 *  - só ponto, uma vez, com 1 ou 2 dígitos depois: é decimal ("24.9", "24.90").
 *  - só ponto, várias vezes: milhar ("1.234.567").
 *
 * Mais de 2 casas decimais é recusado em vez de arredondado: arredondar em
 * silêncio muda o preço que o cliente digitou.
 */
export function parsearPrecoParaCentavos(bruto: string): ResultadoPreco {
  const limpo = String(bruto ?? '')
    .replace(/r\$/gi, '')
    .replace(/\s/g, '')
    .trim();

  if (limpo === '') return { ok: false, erro: 'Informe o preço.' };
  if (!/^-?[\d.,]+$/.test(limpo)) return { ok: false, erro: 'Use apenas números, vírgula e ponto.' };
  if (limpo.startsWith('-')) return { ok: false, erro: 'O preço não pode ser negativo.' };

  const virgulas = (limpo.match(/,/g) ?? []).length;
  const pontos = (limpo.match(/\./g) ?? []).length;

  let inteiros: string;
  let decimais: string;

  const invalido = { ok: false as const, erro: 'Preço inválido.' };

  if (virgulas > 0 && pontos > 0) {
    const decimalEh = limpo.lastIndexOf(',') > limpo.lastIndexOf('.') ? ',' : '.';
    const milhar = decimalEh === ',' ? '.' : ',';
    const partes = limpo.split(decimalEh);
    if (partes.length > 2) return invalido;
    const grupos = (partes[0] ?? '').split(milhar);
    if (!agrupamentoDeMilharValido(grupos)) return invalido;
    inteiros = grupos.join('');
    decimais = partes[1] ?? '';
  } else if (virgulas === 1) {
    const partes = limpo.split(',');
    inteiros = partes[0] ?? '';
    decimais = partes[1] ?? '';
  } else if (virgulas > 1) {
    const grupos = limpo.split(',');
    if (!agrupamentoDeMilharValido(grupos)) return invalido;
    inteiros = grupos.join('');
    decimais = '';
  } else if (pontos === 1) {
    const partes = limpo.split('.');
    const depois = partes[1] ?? '';
    if (depois.length === 3) {
      // "1.234" -> milhar. Só vale se o primeiro grupo também couber na regra.
      if (!agrupamentoDeMilharValido(partes)) return invalido;
      inteiros = (partes[0] ?? '') + depois;
      decimais = '';
    } else {
      inteiros = partes[0] ?? '';
      decimais = depois;
    }
  } else if (pontos > 1) {
    const grupos = limpo.split('.');
    if (!agrupamentoDeMilharValido(grupos)) return invalido;
    inteiros = grupos.join('');
    decimais = '';
  } else {
    inteiros = limpo;
    decimais = '';
  }

  if (decimais.length > 2) {
    return { ok: false, erro: 'Use no máximo 2 casas decimais (centavos).' };
  }
  if (inteiros === '' && decimais === '') return { ok: false, erro: 'Informe o preço.' };
  if (!/^\d*$/.test(inteiros) || !/^\d*$/.test(decimais)) {
    return { ok: false, erro: 'Preço inválido.' };
  }

  const centavos = Number(inteiros || '0') * 100 + Number(decimais.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(centavos)) return { ok: false, erro: 'Preço fora do limite.' };
  if (centavos > MAX_CENTAVOS) return { ok: false, erro: 'Preço acima do limite (R$ 10.000.000,00).' };

  return { ok: true, centavos };
}

/** Centavos -> "24,90". Para exibir em tabela e preencher input de edição. */
export function centavosParaReais(centavos: number): string {
  const n = Number.isFinite(centavos) ? Math.trunc(centavos) : 0;
  const sinal = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sinal}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/** Centavos -> "R$ 24,90", com separador de milhar. Só para leitura. */
export function formatarBRL(centavos: number): string {
  const n = Number.isFinite(centavos) ? Math.trunc(centavos) : 0;
  return (n / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  });
}
