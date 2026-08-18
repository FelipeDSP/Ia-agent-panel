/**
 * A aritmética dos Relatórios do cliente, fora da UI.
 *
 * Está aqui, e não no Server Component, pelo mesmo motivo de
 * `src/lib/billing/consumo.ts`: os casos que quebram são os que ninguém testa
 * abrindo a tela — fuso na virada do dia, mês sem nada, turno sem par de
 * mensagens. Componente não se testa; função pura se testa.
 *
 * PERGUNTAS QUE ESTA TELA RESPONDE, e por que essas: são as que o dono da loja
 * não consegue responder em lugar nenhum. Quantas conversas por dia ele vê no
 * Chatwoot; a que HORAS o procuram, quantas o agente resolveu sozinho e quanto
 * virou pedido, não.
 */

/** Uma linha de `mensagens_log` — só o que o relatório usa. */
export type LinhaMensagem = {
  criado_em: string;
  direcao: string;
  execucao_id: string | null;
};

export type LinhaConversa = {
  status: string;
  phone: string | null;
  criado_em: string;
  pausado_em: string | null;
};

export type LinhaPedido = {
  status: string;
  total_centavos: number | null;
  criado_em: string;
};

/**
 * A hora local do tenant, não a do servidor nem a do navegador.
 *
 * `criado_em` é TIMESTAMPTZ e chega em UTC. Mostrar "o pico é às 22h" para uma
 * loja em Rondônia (UTC-4) quando o pico é às 18h não é imprecisão: é errado, e
 * o cliente percebe na primeira olhada — ele sabe a que horas atende.
 *
 * `Intl` faz a conversão com as regras de fuso reais (horário de verão
 * incluso), o que uma subtração de horas não faz.
 */
export function horaLocal(iso: string, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  });
  const h = Number(fmt.format(new Date(iso)));
  // `24` aparece em algumas combinações de runtime/fuso para meia-noite.
  return h === 24 ? 0 : h;
}

/** Dia local no formato `AAAA-MM-DD`, para agrupar por dia sem virar o fuso. */
export function diaLocal(iso: string, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(iso));
}

/**
 * Pergunta 2: a que horas os clientes procuram a loja.
 *
 * Conta só `entrada` — mensagem DELE. Contar a saída dobraria tudo e mediria o
 * agente, não o movimento.
 */
export function porHora(linhas: LinhaMensagem[], timezone: string): number[] {
  const horas = Array<number>(24).fill(0);
  for (const l of linhas) {
    if (l.direcao !== 'entrada') continue;
    // `noUncheckedIndexedAccess` trata `horas[i]` como possivelmente undefined,
    // e `+= 1` sobre undefined viraria NaN silencioso — o tipo está protegendo
    // de um bug real, não implicando.
    const h = horaLocal(l.criado_em, timezone);
    horas[h] = (horas[h] ?? 0) + 1;
  }
  return horas;
}

/** As faixas com mais movimento, para a tela dizer a conclusão e não só o gráfico. */
export function picos(horas: number[], quantas = 3): { hora: number; n: number }[] {
  return horas
    .map((n, hora) => ({ hora, n }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.hora - b.hora)
    .slice(0, quantas);
}

/**
 * Pergunta 3: quantas o agente levou sozinho e quantas viraram gente.
 *
 * `pausado_em` preenchido é a marca de que ALGUÉM assumiu — inclusive em
 * conversa que voltou a `ativo` depois. Contar só `status = 'pausado'` mediria
 * "está pausada agora", que é outra pergunta e some quando a pessoa termina o
 * atendimento.
 */
export function atendimento(linhas: LinhaConversa[]) {
  const total = linhas.length;
  const comHumano = linhas.filter((l) => l.pausado_em !== null).length;
  const pausadasAgora = linhas.filter((l) => l.status === 'pausado').length;
  return {
    total,
    comHumano,
    soAgente: total - comHumano,
    pausadasAgora,
    // Sem conversa nenhuma não existe percentual; devolver 0 faria a tela dizer
    // "0% precisaram de atendente", que soa como resultado e é ausência de dado.
    pctSoAgente: total > 0 ? Math.round(((total - comHumano) / total) * 100) : null,
  };
}

/** Pergunta 7 — sai de graça da mesma consulta de conversas. */
export function clientesQueVoltaram(linhas: LinhaConversa[]) {
  const porTelefone = new Map<string, number>();
  for (const l of linhas) {
    if (!l.phone) continue;
    porTelefone.set(l.phone, (porTelefone.get(l.phone) ?? 0) + 1);
  }
  const comMaisDeUma = [...porTelefone.values()].filter((n) => n > 1).length;
  return { pessoas: porTelefone.size, voltaram: comMaisDeUma };
}

/** Pergunta 1 — também de graça: conversas por dia, para a linha do tempo. */
export function conversasPorDia(linhas: LinhaConversa[], timezone: string) {
  const dias = new Map<string, number>();
  for (const l of linhas) {
    const d = diaLocal(l.criado_em, timezone);
    dias.set(d, (dias.get(d) ?? 0) + 1);
  }
  return [...dias.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dia, n]) => ({ dia, n }));
}

/**
 * Pergunta 4: quanto virou pedido.
 *
 * `pago` é receita; `aguardando_pagamento` é promessa; `rascunho` é carrinho
 * que o cliente montou e largou — e é o número que ninguém olha e que mais
 * ensina, porque é intenção que existiu e não fechou.
 */
export function pedidos(linhas: LinhaPedido[]) {
  const contar = (s: string) => linhas.filter((l) => l.status === s).length;
  const pagos = linhas.filter((l) => l.status === 'pago');
  return {
    total: linhas.length,
    pago: pagos.length,
    aguardando: contar('aguardando_pagamento'),
    rascunho: contar('rascunho'),
    cancelado: contar('cancelado'),
    expirado: contar('expirado'),
    receitaCentavos: pagos.reduce((a, l) => a + (l.total_centavos ?? 0), 0),
  };
}

/**
 * Pergunta 6: quanto o agente demora para responder.
 *
 * O par entrada/saída do mesmo turno compartilha `execucao_id` (migração 37).
 * Turno sem par — retry, execução que morreu no meio — é DESCARTADO em vez de
 * virar zero: zero seria resposta instantânea, e uma falha entraria na conta
 * como excelência.
 */
export function tempoDeResposta(linhas: LinhaMensagem[]) {
  const porExecucao = new Map<string, { entrada?: number; saida?: number }>();
  for (const l of linhas) {
    if (!l.execucao_id) continue;
    const t = new Date(l.criado_em).getTime();
    const par = porExecucao.get(l.execucao_id) ?? {};
    if (l.direcao === 'entrada') par.entrada = Math.min(par.entrada ?? t, t);
    else par.saida = Math.max(par.saida ?? t, t);
    porExecucao.set(l.execucao_id, par);
  }
  const segundos: number[] = [];
  for (const { entrada, saida } of porExecucao.values()) {
    if (entrada === undefined || saida === undefined) continue;
    const d = (saida - entrada) / 1000;
    if (d >= 0) segundos.push(d);
  }
  if (segundos.length === 0) return null;
  segundos.sort((a, b) => a - b);
  // MEDIANA, não média: um turno preso em 40s puxaria a média e diria que o
  // agente é lento quando a maioria respondeu em 8.
  const meio = Math.floor(segundos.length / 2);
  const mediana = segundos.length % 2
    ? segundos[meio]!
    : (segundos[meio - 1]! + segundos[meio]!) / 2;
  return { turnos: segundos.length, medianaSegundos: Math.round(mediana) };
}

/** `14` -> `"14h"`; usado no gráfico e no texto de pico. */
export function rotuloHora(h: number): string {
  return `${String(h).padStart(2, '0')}h`;
}
