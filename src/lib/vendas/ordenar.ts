/**
 * Ordenação do catálogo na tela.
 *
 * Puro, sem React e sem banco: o componente importa daqui e o teste também, para
 * não haver duas cópias da regra. Uma cópia no teste divergiria em silêncio da
 * do componente — a família de defeito que mordeu três vezes nesta semana (fonte
 * muda, derivado não acompanha, verificação olha um lado só).
 *
 * ---------------------------------------------------------------------------
 * O NOME NA INTERFACE É "ID". A COLUNA DO BANCO CONTINUA `sku`.
 *
 * Não é inconsistência para alguém arrumar depois — é decisão, e renomear a
 * coluna seria o erro:
 *
 *   - `produtos.id` JÁ EXISTE e é o UUID. Renomear `sku` para `id` deixaria
 *     duas coisas chamadas ID na mesma tabela;
 *   - a fase 2 vai ensinar o agente a RESOLVER referência de produto ("quero o
 *     11"). É o pior momento possível para haver ambiguidade entre o
 *     identificador que o cliente FALA e a chave primária.
 *
 * Então: rótulo muda, schema não. Se você veio aqui para "unificar", pare.
 *
 * ---------------------------------------------------------------------------
 * POR QUE A ORDENAÇÃO POR ID NÃO PODE SER DE TEXTO
 *
 * `sku` é `text`. Ordenado como texto, o catálogo do emporio sai
 *
 *   1, 10, 11, 12, ..., 2, 20, 21, ..., 3, 30, ...
 *
 * que é PIOR que a ordem alfabética de hoje — o cliente procura o 2 e o encontra
 * depois do 19. Tem de ser numérica quando o valor é numérico.
 *
 * E nem todo valor é numérico: três produtos herdados de antes da migração 57
 * têm SKU de texto (`BEB-AGUA-500`, `BEB-CHOPP-300`, `LAV-CAM-SOC`), nos dois
 * tenants de teste. Eles não são uniformizados para número: `BEB-AGUA-500` foi
 * digitado com intenção, e reescrevê-lo destruiria informação para arrumar uma
 * tela que nenhum cliente real usa.
 *
 * A regra é: NUMÉRICOS PRIMEIRO, em ordem numérica; os de TEXTO depois, em ordem
 * alfabética. Assim o legado fica agrupado no fim, visível, sem se intercalar no
 * meio da sequência.
 */

export const ORDENS = [
  { valor: 'id', rotulo: 'ID' },
  { valor: 'nome', rotulo: 'Nome' },
] as const;

export type Ordem = (typeof ORDENS)[number]['valor'];

/** Padrão na primeira visita. */
export const ORDEM_PADRAO: Ordem = 'id';

/** Chave do localStorage. Preferência de visualização, não dado de negócio. */
export const CHAVE_ORDEM = 'catalogo:ordem';

export function ehOrdem(v: unknown): v is Ordem {
  return ORDENS.some((o) => o.valor === v);
}

/**
 * `12` -> 12, `BEB-AGUA-500` -> null.
 *
 * O teste é sobre a string INTEIRA (`^[0-9]+$`), não sobre o começo dela. Com
 * `parseInt`, `BEB-AGUA-500` viraria `NaN` (ok) mas `500ml` viraria `500` — e um
 * SKU futuro como `12A` seria lido como 12 e colidiria na ordenação com o 12 de
 * verdade.
 */
export function comoNumero(sku: string | null): number | null {
  if (sku === null) return null;
  const t = sku.trim();
  return /^[0-9]+$/.test(t) ? Number(t) : null;
}

/**
 * Comparador de ID: numéricos antes, em ordem numérica; texto depois, em ordem
 * alfabética. `null` (produto sem SKU) vai para o fim de tudo — não deveria
 * existir depois da 57, mas ordenar não é lugar de assumir invariante de outro.
 */
export function compararPorId(a: string | null, b: string | null): number {
  const na = comoNumero(a);
  const nb = comoNumero(b);

  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1; // número antes de texto
  if (nb !== null) return 1;

  // os dois são texto (ou nulos)
  if (a === null && b === null) return 0;
  if (a === null) return 1; // sem SKU por último
  if (b === null) return -1;
  return a.localeCompare(b, 'pt-BR');
}

/** Nome em ordem alfabética, com as regras do português (acento, caixa). */
export function compararPorNome(a: string, b: string): number {
  return a.localeCompare(b, 'pt-BR');
}

export type Ordenavel = { nome: string; sku: string | null };

/** Devolve uma cópia ordenada — não muta a lista recebida. */
export function ordenarProdutos<T extends Ordenavel>(produtos: readonly T[], ordem: Ordem): T[] {
  const copia = [...produtos];
  if (ordem === 'nome') {
    copia.sort((x, y) => compararPorNome(x.nome, y.nome));
  } else {
    // Desempate por nome: dois produtos com o mesmo SKU não deveriam existir (o
    // índice único impede por tenant), mas uma ordenação instável faria a lista
    // trocar de ordem entre renderizações se acontecesse.
    copia.sort((x, y) => compararPorId(x.sku, y.sku) || compararPorNome(x.nome, y.nome));
  }
  return copia;
}
