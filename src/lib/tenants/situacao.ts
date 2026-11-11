/**
 * COMO A CONTA ESTÁ — a coluna que a lista de clientes não tinha.
 *
 * Puro: recebe números e devolve um veredito. Sem banco e sem React, porque a
 * regra é o que envelhece, não a tabela.
 *
 * ================== POR QUE ISTO EXISTE ==================
 *
 * A lista mostrava `ativo` em onze linhas iguais. Uma coluna que nunca varia é
 * uma coluna que não informa — e o que ela escondia era o que importa: um
 * cliente conectado e **sem tráfego há trinta dias** aparecia exatamente igual
 * a um que atendeu hoje de manhã.
 *
 * `tenants.ativo` responde "a agência suspendeu?". A pergunta que leva alguém à
 * lista é outra: "o agente está atendendo?". São coisas diferentes e a tela
 * misturava as duas.
 *
 * A ORDEM DOS TESTES É A ORDEM DA GRAVIDADE, e é deliberada: suspenso ganha de
 * tudo (não adianta dizer que não tem tráfego se a conta está desligada),
 * depois o agente desligado, depois a falta de conexão com o Chatwoot — sem
 * caixa não há como chegar mensagem, então "sem tráfego" ali seria culpar o
 * cliente por uma pendência da agência.
 */

/**
 * A GRAVIDADE SEPARA "QUEBROU" DE "AINDA NÃO COMEÇOU", e essa distinção veio
 * de ver a tela pronta: na primeira versão, `não conectado` contava como
 * alerta, e o cabeçalho anunciou "8 pedem atenção" numa agência com QUATRO
 * clientes atendendo e zero problemas. Os oito eram tenants de teste e contas
 * recém-criadas que nunca foram ligadas — pendência de implantação, não
 * incidente. Alarme que conta o que não é alarme ensina a ignorar o alarme.
 *
 *   erro    — alguém desligou: suspenso, agente off. Cliente pagando e mudo.
 *   alerta  — estava funcionando e silenciou. É o caso que a tela escondia.
 *   neutro  — nunca foi configurado. É trabalho a fazer, não sino tocando.
 *   ok      — atendendo.
 */
export type Gravidade = 'erro' | 'alerta' | 'ok' | 'neutro';

export type Situacao = {
  /** Chave estável: é por ela que o teste se refere ao caso. */
  chave: 'suspenso' | 'agente_desligado' | 'nao_conectado' | 'nunca_atendeu' | 'parado' | 'ativo';
  rotulo: string;
  gravidade: Gravidade;
  /** Uma frase curta para o title/tooltip — o que fazer a respeito. */
  detalhe: string;
};

/** Acima disto a conta é "parada". Dez dias cobrem feriado e viagem sem alarmar. */
export const DIAS_PARADO = 10;

export type DadosDaConta = {
  ativo: boolean;
  agenteAtivo: boolean;
  temChatwoot: boolean;
  /** Último turno do agente, ou null se nunca houve. */
  ultimaAtividade: Date | null;
};

export function situacaoDaConta(d: DadosDaConta, agora = new Date()): Situacao {
  if (!d.ativo) {
    return { chave: 'suspenso', rotulo: 'suspenso', gravidade: 'erro', detalhe: 'A agência suspendeu esta conta.' };
  }
  if (!d.agenteAtivo) {
    return { chave: 'agente_desligado', rotulo: 'agente desligado', gravidade: 'erro', detalhe: 'O agente está desligado nas configurações da conta.' };
  }
  if (!d.temChatwoot) {
    return { chave: 'nao_conectado', rotulo: 'não conectado', gravidade: 'neutro', detalhe: 'Falta apontar o Agent Bot para uma caixa do Chatwoot. É implantação pendente, não falha.' };
  }
  if (!d.ultimaAtividade) {
    return { chave: 'nunca_atendeu', rotulo: 'nunca atendeu', gravidade: 'neutro', detalhe: 'Conectado, mas nenhuma mensagem chegou até hoje.' };
  }
  const dias = Math.floor((agora.getTime() - d.ultimaAtividade.getTime()) / 86_400_000);
  if (dias >= DIAS_PARADO) {
    return {
      chave: 'parado',
      rotulo: `parado há ${dias} dias`,
      gravidade: 'alerta',
      detalhe: 'Conectado e ligado, mas sem nenhuma conversa. Vale verificar se o número mudou.',
    };
  }
  return { chave: 'ativo', rotulo: 'atendendo', gravidade: 'ok', detalhe: 'Teve conversa nos últimos dias.' };
}

/**
 * "há 2 h", "ontem", "há 5 dias". O número exato de uma data antiga não ajuda
 * ninguém a decidir nada; a distância, sim.
 */
export function tempoRelativo(quando: Date | null, agora = new Date()): string {
  if (!quando) return 'nunca';
  const min = Math.floor((agora.getTime() - quando.getTime()) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'ontem';
  if (d < 30) return `há ${d} dias`;
  const m = Math.floor(d / 30);
  return m === 1 ? 'há 1 mês' : `há ${m} meses`;
}
