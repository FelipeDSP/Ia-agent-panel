/**
 * A política de retenção como o PAINEL a vê (docs/POLITICA-RETENCAO.md).
 *
 * O banco corta pelo serviço (`api_agente_retencao`, migração 67, diário);
 * o painel mostra a mesma janela, para tela e banco contarem a mesma
 * história: conversa mais velha que a janela não aparece na lista (o texto
 * dela já foi, e a identidade vai em seguida).
 *
 * Global, decidida em 16/09/2026: 45 dias. Se um dia for por tenant, vira
 * coluna como as outras (66) e este módulo passa a receber o valor.
 */
export const RETENCAO_TEXTO_DIAS = 45;

/** `atualizado_em >= desde` para a lista de conversas. */
export function desdeJanela(dias = RETENCAO_TEXTO_DIAS, agora = new Date()): string {
  return new Date(agora.getTime() - dias * 24 * 60 * 60 * 1000).toISOString();
}
