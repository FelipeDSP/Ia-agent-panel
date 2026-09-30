/**
 * O que fez o agente chamar um atendente — a lista que vira conteúdo de base.
 *
 * FASE 0 da ideia do "aprendizado com revisão humana" (30/09): sem tabela
 * nova, sem embedding, sem LLM. Tudo o que esta tela mostra já está no trace,
 * e `agente_passos`/`agente_turnos` são legíveis pelo próprio tenant (policy
 * `tenant_id = auth_tenant_id()`, conferida em 30/09: o CEEJAAR vê os 244
 * turnos dele e nenhum dos 335 do banco).
 *
 * POR QUE ESTE SINAL, E NÃO O ÓBVIO. O caminho natural seria "a busca não
 * achou nada" — e ele não existe: `api_n8n_buscar_kb` não tem piso de
 * similaridade (docs/PENDENCIA-PISO-SIMILARIDADE.md), devolve sempre os 5
 * trechos mais próximos e por isso `NENHUM_RESULTADO` saiu **0 vezes em 76
 * buscas** medidas em 30/09. Um limiar sobre a relevância também não separa:
 * na mesma medição, 61% das buscas ficaram acima de 0,60 e só 4% abaixo de
 * 0,45, com perguntas que a base claramente não cobria ("horário de
 * funcionamento", 0,548) no meio da faixa boa. O único sinal não-ambíguo é a
 * TRANSFERÊNCIA: ali o próprio agente declarou que não deu conta.
 *
 * O QUE ESTA LISTA NÃO É. Não é "lacuna da base" — `transferir_humano`
 * também dispara quando o cliente simplesmente pede para falar com uma
 * pessoa, e isso não vira conteúdo. A tela mostra o que aconteceu e deixa o
 * dono escolher; prometer "lacunas" seria vender classificação que não há.
 *
 * O QUE FALTA, e é decisão de produto, não de código: a RESPOSTA que o
 * atendente deu não está no banco. `humanoAssumiu` pausa a conversa e
 * descarta a fila, mas não registra o conteúdo (conferido em 30/09). Gravá-la
 * é uma mudança no serviço COM consequência: `mensagens_log` é a memória do
 * agente (`api_agente_memoria` lê dali), então a fala do atendente passaria a
 * ser lembrada pelo agente como se fosse dele. Fica para uma fase própria.
 */

/** Uma linha do trace, como o Supabase a devolve. */
export interface PassoTransferencia {
  criado_em: string;
  entrada: { resumo?: unknown } | null;
  saida: { diagnostico?: { disponivel?: unknown; pausou?: unknown; atribuiu?: unknown } } | null;
  agente_turnos: { conversation_id: number | string | null } | { conversation_id: number | string | null }[] | null;
}

export interface Chamada {
  quando: string;
  conversationId: number | null;
  /** O resumo que o agente escreveu para o atendente — o que o cliente queria. */
  resumo: string;
  /** `transferiu` = havia atendente; `fora_do_horario` = não havia, e ninguém assumiu. */
  desfecho: 'transferiu' | 'fora_do_horario';
}

/** O objeto embutido vem como objeto ou array de um, conforme a forma do select. */
function conversaDe(p: PassoTransferencia): number | null {
  const bruto = Array.isArray(p.agente_turnos) ? p.agente_turnos[0] : p.agente_turnos;
  const n = Number(bruto?.conversation_id ?? NaN);
  return Number.isInteger(n) ? n : null;
}

/**
 * Do trace para a tela.
 *
 * Descarta o passo sem resumo: sem ele não há o que mostrar nem o que virar
 * entrada da base, e uma linha vazia na lista é pior que linha nenhuma.
 */
export function chamadasDeAtendente(passos: PassoTransferencia[] | null): Chamada[] {
  return (passos ?? [])
    .map((p): Chamada | null => {
      const resumo = String(p.entrada?.resumo ?? '').trim();
      if (!resumo) return null;
      return {
        quando: p.criado_em,
        conversationId: conversaDe(p),
        resumo,
        desfecho: p.saida?.diagnostico?.disponivel === true ? 'transferiu' : 'fora_do_horario',
      };
    })
    .filter((c): c is Chamada => c !== null);
}

/** Título sugerido para a entrada da base, a partir do resumo. */
export function tituloSugerido(resumo: string): string {
  const limpo = resumo.replace(/\s+/g, ' ').trim();
  const primeiraFrase = limpo.split(/(?<=[.?!])\s/)[0] ?? limpo;
  const base = primeiraFrase.length > 8 && primeiraFrase.length <= 70 ? primeiraFrase : limpo.slice(0, 70);
  return base.replace(/[.\s]+$/, '').slice(0, 70) || 'Dúvida de cliente';
}

/**
 * O rascunho que abre no formulário.
 *
 * O texto NÃO tenta responder: a resposta o dono escreve. Um rascunho que
 * "chuta" o horário entra na base com cara de verdade e passa a ser dito a
 * todos os clientes — é o mesmo defeito que o portão de saída existe para
 * impedir, entrando por outra porta.
 */
export function rascunhoDeEntrada(resumo: string): string {
  return `Pergunta do cliente: ${resumo.replace(/\s+/g, ' ').trim()}\n\nResposta: `;
}
