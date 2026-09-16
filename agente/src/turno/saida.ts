/**
 * FILTRO DE SAÍDA — `limparVazamento` do `n8n/estima-tokens.js`, portado
 * verbatim. O modelo às vezes ESCREVE `[Used tools: ...]` com o resultado cru
 * da ferramenta antes da resposta (2 em 165 saídas, medido em 20/08/2026 —
 * docs/VAZAMENTO-USED-TOOLS.md). Varredura de colchetes ANINHADOS, não regex
 * não-gulosa: a não-gulosa para no primeiro `]` e entrega o miolo (o texto
 * interno da KB) ao cliente, limpo e sem marca.
 *
 * `tests/agente-fatia2.mjs` roda este porte e a função original (extraída do
 * corpo do nó) sobre os mesmos textos e exige o mesmo resultado.
 */
export interface Corte { tipo: string; trecho: string }

export function limparVazamento(bruto: unknown): { texto: string; cortes: Corte[] } {
  const cortes: Corte[] = [];
  let t = String(bruto ?? '');

  for (;;) {
    const i = t.search(/\[\s*Used tools?\s*:/i);
    if (i === -1) break;

    let profundidade = 0;
    let fim = -1;
    for (let j = i; j < t.length; j++) {
      if (t[j] === '[') profundidade++;
      else if (t[j] === ']' && --profundidade === 0) { fim = j; break; }
    }
    if (fim === -1) {
      cortes.push({ tipo: 'used_tools_sem_fechamento', trecho: t.slice(i) });
      t = t.slice(0, i);
      break;
    }
    cortes.push({ tipo: 'used_tools', trecho: t.slice(i, fim + 1) });
    t = t.slice(0, i) + t.slice(fim + 1);
  }

  t = t.replace(/\[Trecho\s+\d+\s*\|\s*relev[aâ]ncia\s+[\d.]+\]\s*/gi, (m) => {
    cortes.push({ tipo: 'trecho_kb', trecho: m });
    return '';
  });

  return { texto: t.replace(/[ \t]+\n/g, '\n').trim(), cortes };
}

/**
 * A regra do n8n para o caso "só vazamento": se depois da limpeza não sobra
 * nada, o texto bruto segue (melhor um vazamento visível que resposta vazia),
 * e `_saida_so_vazamento` marca.
 */
export function saidaLimpa(textoModelo: string): { texto: string; cortes: Corte[]; soVazamento: boolean } {
  const l = limparVazamento(textoModelo);
  const soVazamento = l.cortes.length > 0 && l.texto === '';
  return { texto: soVazamento ? textoModelo : l.texto, cortes: l.cortes, soVazamento };
}
