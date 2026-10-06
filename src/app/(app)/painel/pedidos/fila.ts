/**
 * A fila de pedidos: o que precisa sair, agrupado por quando.
 *
 * POR QUE AGRUPAR POR DIA, e não só ordenar. Quem prepara pedido não pergunta
 * "qual é o próximo da lista" — pergunta "o que sai hoje" e, no fim do dia, "o
 * que ficou". São perguntas sobre BLOCOS, e o bloco que importa mais é o
 * primeiro: ATRASADO. Uma lista ordenada mostra o atrasado no mesmo tamanho de
 * tudo o que vem depois, e às 7h da terça ninguém repara.
 *
 * Módulo puro e sem I/O: recebe pedidos e o relógio, devolve os grupos. É isto
 * que `teste:fila-de-pedidos` executa — fila que só existe dentro de um
 * componente React se testa clicando, e clicar não entra na suíte.
 */

export type PedidoDaFila = {
  id: string;
  numero: number | null;
  status: string;
  total_centavos: number;
  quando_em: string | null;
  separado_em: string | null;
  retirado_em: string | null;
  pago_em: string | null;
  pagamento_modo: string | null;
  retirada_nome: string | null;
  conversation_id: number;
  criado_em: string;
  itens: number;
};

export type ChaveGrupo = 'atrasado' | 'hoje' | 'amanha' | 'depois' | 'sem_horario';

export const ROTULO_GRUPO: Record<ChaveGrupo, string> = {
  atrasado: 'Atrasado',
  hoje: 'Hoje',
  amanha: 'Amanhã',
  depois: 'Próximos dias',
  sem_horario: 'Sem horário combinado',
};

/** O dia civil (AAAA-MM-DD) de um instante, no fuso da loja. */
export function diaLocal(iso: string | Date, tz: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p['year']}-${p['month']}-${p['day']}`;
}

/** A hora (HH:MM) no fuso da loja. */
export function horaLocal(iso: string, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p['hour']}:${p['minute']}`;
}

/**
 * Um pedido está NA FILA quando foi fechado e ainda não saiu.
 *
 * Rascunho fica de fora de propósito: ele ainda está sendo montado numa
 * conversa e os itens podem mudar. No Empório havia OITO rascunhos no topo da
 * lista — para quem confere pedido, isso é ruído, não trabalho.
 */
export function naFila(p: PedidoDaFila): boolean {
  if (p.retirado_em) return false;
  return p.status === 'aguardando_pagamento' || p.status === 'pago';
}

/** O próximo passo do pedido — um só, que é o que vira botão. */
export function proximoPasso(p: PedidoDaFila): 'separar' | 'pago' | 'retirado' | null {
  if (p.retirado_em) return null;
  if (!p.separado_em) return 'separar';
  if (p.status === 'aguardando_pagamento') return 'pago';
  if (p.status === 'pago') return 'retirado';
  return null;
}

export function grupoDe(p: PedidoDaFila, agora: Date, tz: string): ChaveGrupo {
  if (!p.quando_em) return 'sem_horario';
  const hoje = diaLocal(agora, tz);
  const dia = diaLocal(p.quando_em, tz);
  if (dia < hoje) return 'atrasado';
  if (dia === hoje) {
    // Passou da hora, mas é hoje: continua em HOJE. Mandar para "atrasado" às
    // 7h05 um pedido das 7h faria a tela gritar enquanto a pessoa está
    // justamente atendendo o cliente no balcão.
    return 'hoje';
  }
  const amanha = diaLocal(new Date(agora.getTime() + 24 * 3600 * 1000), tz);
  if (dia === amanha) return 'amanha';
  return 'depois';
}

export const ORDEM_GRUPOS: ChaveGrupo[] = ['atrasado', 'hoje', 'amanha', 'depois', 'sem_horario'];

/**
 * Agrupa e ordena. Dentro do grupo: por hora; sem hora, pelo mais antigo —
 * quem pediu primeiro espera há mais tempo.
 */
export function montarFila(
  pedidos: PedidoDaFila[],
  agora: Date,
  tz: string,
): { chave: ChaveGrupo; rotulo: string; pedidos: PedidoDaFila[] }[] {
  const porGrupo = new Map<ChaveGrupo, PedidoDaFila[]>();
  for (const p of pedidos.filter(naFila)) {
    const g = grupoDe(p, agora, tz);
    const lista = porGrupo.get(g) ?? [];
    lista.push(p);
    porGrupo.set(g, lista);
  }
  return ORDEM_GRUPOS.filter((g) => (porGrupo.get(g) ?? []).length > 0).map((g) => ({
    chave: g,
    rotulo: ROTULO_GRUPO[g],
    pedidos: (porGrupo.get(g) ?? []).sort((a, b) => {
      if (a.quando_em && b.quando_em) return a.quando_em.localeCompare(b.quando_em);
      if (a.quando_em) return -1;
      if (b.quando_em) return 1;
      return a.criado_em.localeCompare(b.criado_em);
    }),
  }));
}

/**
 * A busca que a pessoa de fato faz: número do pedido, ou o nome de quem vem
 * buscar. Sem acento e sem caixa — ninguém digita "Déborah" com o acento certo
 * quando o cliente está esperando no balcão.
 */
export function normalizar(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function casaBusca(p: PedidoDaFila, termo: string): boolean {
  const q = normalizar(termo);
  if (!q) return true;
  const soDigitos = q.replace(/\D/g, '');
  if (soDigitos && p.numero !== null && String(p.numero) === soDigitos) return true;
  if (p.retirada_nome && normalizar(p.retirada_nome).includes(q)) return true;
  if (soDigitos && String(p.conversation_id) === soDigitos) return true;
  return false;
}
