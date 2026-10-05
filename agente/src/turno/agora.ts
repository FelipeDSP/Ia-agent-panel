/**
 * QUE DIA É HOJE — o fato que o agente não tinha.
 *
 * Achado na conversa 48 do Empório, domingo 04/10/2026 às 07:09 (Porto Velho).
 * O cliente perguntou "vocês abrem hoje para o café?" e o agente respondeu:
 *
 *   "Hoje o Empório Leite Franco está fechado, pois fechamos às segundas-feiras.
 *    Posso deixar algo separado para você buscar amanhã de manhã, quando
 *    abrirmos às 7h?"
 *
 * Três erros numa frase, e nenhum deles é do prompt do cliente — que está
 * correto e diz "ter-sex 7h-10h e 16h-19h · sáb e dom 8h-11h · fechado às
 * segundas e no último domingo do mês". Era DOMINGO: a loja abriria às 8h,
 * dali a 50 minutos; "amanhã" era a segunda, o único dia fechado; e o motivo
 * dado ("fechamos às segundas") descrevia um dia que não era o de hoje.
 *
 * A causa não é alucinação no sentido usual: **o modelo não tinha como saber.**
 * O prompt lista horários POR DIA DA SEMANA e em lugar nenhum dizia qual dia é
 * hoje. Perguntado sobre "hoje", ele tinha de adivinhar — e adivinhou.
 *
 * É uma classe inteira de erro, não um caso: "abre hoje?", "ainda dá tempo?",
 * "amanhã tem?", "até que horas vocês ficam?" — toda pergunta ancorada no
 * presente dependia de sorte. E é o pior tipo de erro para este produto,
 * porque a resposta sai com a mesma segurança de uma certa, e quem lê não tem
 * como desconfiar.
 *
 * ONDE ISTO ENTRA, e por quê aqui: como FATO DO SISTEMA do turno
 * (`estadoDoSistema`), não no prompt. O prompt é cacheado e tem hash — pôr
 * nele um texto que muda a cada minuto quebraria o cache de entrada da OpenAI
 * (3.712 dos 3.999 tokens daquele turno vieram de cache) e encheria
 * `agente_prompts` de uma versão por minuto. O estado do sistema já existe
 * exatamente para isto: fato que muda por turno, que vem do código e não da
 * dedução do modelo.
 *
 * O fuso é o do tenant quando ele configurou horário (`horario_agente`); sem
 * isso, America/Sao_Paulo — o mesmo default do resto do serviço. Dizer a hora
 * errada seria pior que não dizer nada.
 */

/** Fuso padrão quando o tenant não configurou horário. O mesmo de `transferir_humano`. */
export const FUSO_PADRAO = 'America/Sao_Paulo';

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/**
 * "FATO DO SISTEMA ...: agora é domingo, 04/10/2026, 07:09 (America/Porto_Velho)."
 *
 * Puro: recebe o instante e o fuso, devolve o texto. O teste não depende do
 * relógio da máquina — que é como o `disponivelAgora` já era testado desde que
 * ele ficou vermelho às 18:01 de um dia qualquer.
 */
export function narrarAgora(agora: Date, timezone: string | null | undefined): string {
  const tz = (timezone ?? '').trim() || FUSO_PADRAO;
  let partes: Record<string, string>;
  try {
    partes = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(agora).map((p) => [p.type, p.value]),
    );
  } catch {
    // Fuso inválido gravado por engano não pode derrubar o turno: cai no padrão.
    return narrarAgora(agora, FUSO_PADRAO);
  }
  const mapa: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dia = DIAS[mapa[partes.weekday ?? ''] ?? 0] ?? '';
  // `hour12: false` devolve "24" à meia-noite em algumas plataformas.
  const hora = String(Number(partes.hour ?? '0') % 24).padStart(2, '0');
  return `FATO DO SISTEMA (relógio do servidor, não do cliente): agora é ${dia}, ${partes.day}/${partes.month}/${partes.year}, ${hora}:${partes.minute} (${tz}). `
    + 'Use isto para qualquer pergunta sobre "hoje", "amanhã", "ainda dá tempo" ou horário de funcionamento — nunca suponha o dia da semana.';
}
