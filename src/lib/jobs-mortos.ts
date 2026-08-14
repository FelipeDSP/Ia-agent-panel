/**
 * Quando um job de ingestão para de estar vivo.
 *
 * Módulo próprio, e não dentro de `acoes.ts`, por duas razões: `'use server'`
 * exige que todo export seja função async (uma constante ali não compila), e o
 * teste precisa importar o número DE VERDADE em vez de copiá-lo — teste que
 * repete a constante concorda consigo mesmo para sempre.
 *
 * DUAS COISAS SEPARADAS usam isto, e a separação é deliberada:
 *
 *   1. `marcarJobsMortos` — expira job preso na leitura, sem agendador;
 *   2. `dispensarJob` — deixa o cliente remover um job travado.
 *
 * O (2) é bug próprio, não consequência do (1): antes, um job em `processando`
 * não podia ser dispensado por ninguém. Se alguém um dia remover o (1), o (2)
 * tem de continuar de pé sozinho.
 */

/**
 * Minutos até um job em andamento ser dado como morto.
 *
 * ERRAR PARA O LADO LONGO É DELIBERADO, porque os dois erros não custam o
 * mesmo. Medido em produção: 70 chunks em 6,3 s e 7,9 s (~9 chunks/s). Um PDF
 * de 50 páginas com ~600 chunks dá ~70 s; com o backoff máximo dos 3 retries
 * por lote, alguns minutos.
 *
 * Curto demais marca `erro` num job que AINDA RODA — e se o cliente clicar
 * "Reprocessar", duas ingestões do mesmo documento disputam o swap por
 * (tenant, origem). Longo demais só faz o cliente esperar mais para ver o erro.
 * É a assimetria que escolhe o número, não o valor médio.
 */
export const MINUTOS_JOB_MORTO = 15;

/** Os status em que o job ainda pode estar trabalhando. */
export const STATUS_EM_ANDAMENTO = ['pendente', 'processando'] as const;

/** Instante antes do qual um job em andamento é considerado morto. */
export function limiteJobMorto(agora: Date = new Date()): string {
  return new Date(agora.getTime() - MINUTOS_JOB_MORTO * 60_000).toISOString();
}

/**
 * Filtro PostgREST de "job que não vai mais a lugar nenhum": falhou, ou travou
 * em andamento além do limite.
 *
 * `concluido` fica de fora de propósito — aquilo virou documento, e apagar o
 * registro esconderia o que existe na base.
 *
 * A sintaxe do `or` com `and(...)` aninhado e um timestamp ISO (que tem `:` e
 * `.`) é frágil o suficiente para merecer teste próprio: escrita errada não dá
 * erro de compilação, dá zero linhas.
 */
export function filtroJobDispensavel(limite: string): string {
  return `status.eq.erro,and(status.in.(${STATUS_EM_ANDAMENTO.join(',')}),criado_em.lt.${limite})`;
}

/** Mensagem gravada em `erro_msg` quando o job é dado como interrompido. */
export const MSG_JOB_MORTO =
  `O processamento não respondeu em ${MINUTOS_JOB_MORTO} minutos e foi dado como ` +
  'interrompido. Envie o arquivo de novo.';
