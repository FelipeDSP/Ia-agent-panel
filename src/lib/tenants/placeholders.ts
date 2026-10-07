/**
 * Marcadores `{{...}}` esquecidos no prompt de um cliente.
 *
 * O serviço NÃO substitui nada: `montarSystemMessage`
 * (agente/src/agente/prompt.ts) concatena o `system_prompt` do tenant verbatim,
 * de propósito — o wrapper é byte a byte o do n8n e não há motor de template
 * em lugar nenhum. Então `{{CATALOGO_DE_CURSOS}}` chega ao modelo como esses
 * 22 caracteres, e não como o catálogo.
 *
 * O que isso custou (07/10, conversa 51 do sendbox): o prompt da estud.you tem
 * `{{CATALOGO_DE_CURSOS}}` e, logo abaixo, "Consulte exclusivamente este
 * catálogo". O agente ficou instruído a consultar exclusivamente uma lista que
 * não existe — e por isso não chamou `consultar_catalogo` nenhuma vez em nove
 * turnos, enquanto o Empório chamou onze. Um cliente pediu "Treinamento de
 * NR 01", que está no catálogo por R$ 69,90, e ouviu uma aula sobre a norma.
 *
 * Por que AVISO e não erro: no CEEJAAR os marcadores são propositais — são
 * perguntas abertas para a secretaria ("{{GRATUITO? HÁ TAXA?}}"), e o próprio
 * prompt diz o que fazer sem elas ("Sem definição, transfira"). Bloquear o
 * save apagaria um uso legítimo para resolver outro. O que faltava não era
 * proibição, era alguém falando.
 */

/** Quantos marcadores a mensagem cita antes de resumir o resto. */
export const MAX_CITADOS = 4;

/** Corte do nome citado: há marcadores que são frases inteiras no CEEJAAR. */
const MAX_NOME = 40;

/**
 * Os marcadores distintos, na ordem em que aparecem.
 *
 * `[^{}]` no miolo (e não `[\s\S]`, que é guloso e casaria do primeiro `{{`
 * ao último `}}`, devolvendo o prompt inteiro como se fosse UM marcador —
 * um achado grande demais para ser verdade, e vacuamente "detectado").
 */
export function placeholdersNoPrompt(texto: string): string[] {
  const achados = [...String(texto ?? '').matchAll(/\{\{([^{}]{1,200})\}\}/g)]
    .map((m) => m[1]!.trim())
    .filter((n) => n.length > 0);
  return [...new Set(achados)];
}

/** O aviso pronto, ou null quando não há nada a dizer. */
export function avisoDePlaceholders(texto: string): string | null {
  const nomes = placeholdersNoPrompt(texto);
  if (nomes.length === 0) return null;
  const curtos = nomes.slice(0, MAX_CITADOS).map((n) => `{{${n.length > MAX_NOME ? n.slice(0, MAX_NOME) + '…' : n}}}`);
  const resto = nomes.length - curtos.length;
  const lista = curtos.join(', ') + (resto > 0 ? ` e mais ${resto}` : '');
  return `Este prompt tem ${nomes.length === 1 ? 'um marcador' : `${nomes.length} marcadores`} ${lista}. Nada substitui isso: o agente lê o texto entre chaves do jeito que está. Se era para ser o catálogo, troque por uma instrução para o agente consultar o catálogo; se é uma pergunta em aberto, escreva o que ele deve fazer enquanto não houver resposta.`;
}
