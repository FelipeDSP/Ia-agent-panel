/**
 * O agrupamento que vira a lista de "Documentos na base".
 *
 * POR QUE VIVE AQUI e não dentro do Server Component. Em 17/08/2026 o painel do
 * `emporio` mostrou 1 documento com 2 no banco, e o invisível não podia ser
 * removido pela tela — só por SQL. A lógica estava inline no `page.tsx`, que é
 * Server Component: nenhum teste conseguia importá-la, então a única forma de
 * conferir a lista era abrir o navegador. Aqui `tests/conhecimento-lista.mjs`
 * importa a FONTE e compara com o banco; reimplementar a regra no teste
 * produziria um teste que concorda consigo mesmo para sempre.
 *
 * A base não tem tabela de documento: documento É o conjunto de chunks que
 * compartilham `origem`. Isso torna `origem` a identidade, e é por isso que
 * `excluirDocumento(origem)` funciona — e por isso que um chunk sem `origem` é
 * um documento que a tela mostra e a tela não consegue apagar.
 */

export type ChunkDaLista = {
  origem: string | null;
  metadata: Record<string, unknown> | null;
  criado_em: string;
};

export type Documento = {
  origem: string;
  nome: string;
  chunks: number;
  criadoEm: string;
};

/** Sentinela para chunk sem `origem`. Ver a nota sobre exclusão em `SEM_ORIGEM`. */
export const SEM_ORIGEM = '(sem origem)';

export function agruparDocumentos(chunks: ChunkDaLista[] | null | undefined): Documento[] {
  const porOrigem = new Map<string, Documento>();

  for (const c of chunks ?? []) {
    const origem = c.origem ?? SEM_ORIGEM;
    const meta = (c.metadata ?? {}) as Record<string, unknown>;
    const nome = (meta['arquivo'] as string) ?? (meta['fonte'] as string) ?? origem;
    const existente = porOrigem.get(origem);
    if (existente) {
      existente.chunks += 1;
    } else {
      porOrigem.set(origem, { origem, nome, chunks: 1, criadoEm: c.criado_em });
    }
  }

  return Array.from(porOrigem.values());
}

/**
 * Documentos DIFERENTES que colapsaram numa linha só.
 *
 * `origem` é a identidade, então dois uploads com a mesma `origem` viram uma
 * linha — e a contagem da tela continua batendo com `count(distinct origem)`,
 * porque as duas estão erradas do mesmo jeito. Só o `metadata.arquivo` denuncia:
 * uma origem com dois nomes de arquivo é dois documentos escondidos num.
 *
 * É a lacuna da checagem óbvia, e por isso mora ao lado dela.
 */
export function origensComNomesConflitantes(
  chunks: ChunkDaLista[] | null | undefined,
): { origem: string; nomes: string[] }[] {
  const nomesPorOrigem = new Map<string, Set<string>>();

  for (const c of chunks ?? []) {
    const origem = c.origem ?? SEM_ORIGEM;
    const arquivo = (c.metadata as Record<string, unknown> | null)?.['arquivo'];
    if (typeof arquivo !== 'string' || !arquivo) continue;
    if (!nomesPorOrigem.has(origem)) nomesPorOrigem.set(origem, new Set());
    nomesPorOrigem.get(origem)!.add(arquivo);
  }

  return [...nomesPorOrigem.entries()]
    .filter(([, nomes]) => nomes.size > 1)
    .map(([origem, nomes]) => ({ origem, nomes: [...nomes] }));
}
