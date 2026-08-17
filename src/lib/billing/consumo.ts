/**
 * Consumo mensal: a aritmética de `/admin/consumo`, fora da UI.
 *
 * POR QUE MÓDULO SEPARADO. Nada aqui toca banco nem React — é ordenação,
 * comparação com o mês anterior e preenchimento de buraco no histórico. Posto
 * dentro do `page.tsx` isso só seria exercitado abrindo a tela no navegador, e
 * o caso que interessa (mês anterior zerado, cliente que parou, virada de ano)
 * é justamente o que ninguém abre a tela para ver. Aqui `tests/consumo-mes.mjs`
 * importa a fonte e sabota.
 *
 * TUDO EM UTC. `billing_consumo_mensal()` faz `date_trunc('month', criado_em)`
 * na sessão do PostgREST, que o Supabase mantém em UTC. Se o mês corrente
 * viesse do relógio local do servidor, nas primeiras horas do dia 1 o painel
 * pediria um mês que o banco ainda não começou a preencher (ou o contrário) e a
 * tela apareceria vazia sem motivo visível. `toISOString()` é UTC
 * independentemente do TZ do processo — é por isso que ele é usado, e não
 * `getMonth()`.
 */

/**
 * Linha crua de `billing_consumo_mensal()`.
 *
 * NUMERIC e BIGINT chegam do PostgREST como string (adendo §5): `custo_usd` e
 * os três de token vêm com aspas. Converter antes de somar — `'0.04' + '0.04'`
 * é `'0.040.04'`, e o total sairia errado sem erro nenhum.
 */
export type LinhaConsumo = {
  tenant_id: string;
  tenant_nome: string;
  mes: string;
  tokens_entrada: number | string;
  tokens_saida: number | string;
  tokens_embedding: number | string;
  custo_usd: number | string;
};

/** Cliente conhecido pelo painel, com ou sem consumo. */
export type TenantConsumo = {
  id: string;
  nome: string;
  /** Soft delete: continua no histórico de custo, mas sinalizado. */
  deletado: boolean;
};

/**
 * LIMIAR DE DESTAQUE — as duas condições, e por que são duas.
 *
 * A pergunta que o destaque responde é "algum cliente está fora do normal", e
 * ela tem dois jeitos de responder errado:
 *
 *  - só percentual: a base hoje é de CENTAVOS. O maior tenant fecha o mês em
 *    US$ 0,04. Ir de 0,02 para 0,04 é +100% e não significa nada — é uma
 *    conversa a mais. Um limiar só percentual acenderia a tela inteira todo mês.
 *  - só absoluto: com o custo atual, nenhum valor absoluto que filtre ruído
 *    dispararia algum dia, e o recurso nasceria morto.
 *
 * Então as duas juntas: metade do mês anterior E dez centavos de diferença.
 * 50% porque volume de mensagem oscila 20–30% por conta de mês curto, feriado e
 * fim de semana — abaixo disso é sazonalidade, não anomalia. Dez centavos
 * porque é o piso mais baixo que ainda separa sinal de ruído na escala de hoje
 * (o maior tenant teria de mais que triplicar para acender).
 *
 * QUANDO MEXER: `LIMIAR_VARIACAO_USD` é o número que envelhece. Ele foi
 * escolhido para a escala de centavos de 2026-08; quando o custo mensal virar
 * dezenas de dólares, dez centavos vira ruído puro e o piso sobe junto. É o
 * mesmo gatilho da pendência de margem (`docs/PENDENCIA-MARGEM.md`): os dois
 * esperam o custo virar número material.
 */
export const LIMIAR_VARIACAO_PCT = 50;
export const LIMIAR_VARIACAO_USD = 0.1;

/**
 * Fração do mês que precisa ter passado para uma QUEDA merecer destaque.
 *
 * O mês corrente é parcial e o anterior é inteiro. No dia 2, todo cliente caiu
 * ~93% — comparar três dias de agosto com trinta e um de julho dá vermelho para
 * a lista toda, todo mês, e vermelho que aparece sempre é vermelho que ninguém
 * mais lê. Alta continua destacando desde o dia 1: subir já com o mês pela
 * metade é sinal mais forte ainda, não mais fraco.
 */
export const FRACAO_MES_PARA_QUEDA = 0.5;

// Tabela fixa em vez de Intl: `toLocaleString('pt-BR', { month: 'short' })`
// devolve 'ago.' com ponto em alguns runtimes e 'ago' em outros, e o rótulo
// mudaria entre o build e o navegador.
const MESES_PT = [
  'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
  'jul', 'ago', 'set', 'out', 'nov', 'dez',
];

/** `'2026-08-01'` (ou ISO completo) -> `'2026-08'`. */
export function mesDe(valor: string): string {
  return String(valor).slice(0, 7);
}

/** Mês corrente em UTC — o mesmo fuso em que a RPC agrupa. */
export function mesCorrente(agora: Date): string {
  return agora.toISOString().slice(0, 7);
}

/** `'2026-08'` -> `[2026, 8]`. */
function partes(mes: string): [number, number] {
  const [ano, m] = mes.split('-');
  return [Number(ano), Number(m)];
}

/** `'2026-01'` -> `'2025-12'`. A virada de ano é o caso que quebra a conta ingênua. */
export function mesAnteriorDe(mes: string): string {
  const [ano, m] = partes(mes);
  if (m === 1) return `${ano - 1}-12`;
  return `${ano}-${String(m - 1).padStart(2, '0')}`;
}

/** `'2026-08'` -> `'ago/2026'`. */
export function rotuloMes(mes: string): string {
  const [ano, m] = partes(mes);
  return `${MESES_PT[m - 1] ?? m}/${ano}`;
}

/** Quanto do mês já passou, de 0 a 1. Em UTC, como todo o resto. */
export function fracaoDoMes(agora: Date): number {
  const dia = agora.getUTCDate();
  // Dia 0 do mês seguinte = último dia deste. Cobre ano bissexto sem tabela.
  const dias = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() + 1, 0)).getUTCDate();
  return dia / dias;
}

export type Variacao =
  /** Sem consumo neste mês nem no anterior. Não há o que comparar. */
  | { tipo: 'sem-consumo' }
  /** Consumiu agora e não tinha nada antes — a divisão por zero, nomeada. */
  | { tipo: 'primeiro-mes' }
  /** Consumia e parou. Também é informação. */
  | { tipo: 'parou'; anterior: number; destacar: boolean }
  | { tipo: 'variou'; pct: number; delta: number; destacar: boolean };

/**
 * Compara o custo do mês corrente com o do anterior.
 *
 * Os dois primeiros casos existem para que `(atual - 0) / 0` nunca aconteça:
 * em JS isso é `Infinity` (ou `NaN`, se ambos forem zero), e `+Infinity%` na
 * tela é o tipo de coisa que só aparece em produção, no mês em que entra
 * cliente novo — que é esta semana.
 */
export function classificarVariacao(
  atual: number,
  anterior: number,
  fracao: number,
): Variacao {
  if (anterior <= 0 && atual <= 0) return { tipo: 'sem-consumo' };
  if (anterior <= 0) return { tipo: 'primeiro-mes' };
  if (atual <= 0) {
    return { tipo: 'parou', anterior, destacar: fracao >= FRACAO_MES_PARA_QUEDA };
  }

  const delta = atual - anterior;
  const pct = (delta / anterior) * 100;
  const relevante =
    Math.abs(pct) >= LIMIAR_VARIACAO_PCT && Math.abs(delta) >= LIMIAR_VARIACAO_USD;

  return {
    tipo: 'variou',
    pct,
    delta,
    // Queda só destaca com o mês já pela metade; alta destaca sempre.
    destacar: relevante && (delta > 0 || fracao >= FRACAO_MES_PARA_QUEDA),
  };
}

export type CardConsumo = {
  tenantId: string;
  nome: string;
  deletado: boolean;
  entrada: number;
  saida: number;
  embedding: number;
  custo: number;
  /** Nenhum token e nenhum custo no mês — vai para o fim da lista, apagado. */
  semConsumo: boolean;
  variacao: Variacao;
};

export type VisaoMensal = {
  mes: string;
  mesAnterior: string;
  total: number;
  cards: CardConsumo[];
};

function somar(linha: LinhaConsumo) {
  return {
    entrada: Number(linha.tokens_entrada),
    saida: Number(linha.tokens_saida),
    embedding: Number(linha.tokens_embedding),
    custo: Number(linha.custo_usd),
  };
}

/**
 * Monta a tela do mês corrente: total, e um card por cliente ordenado do mais
 * caro para o mais barato.
 *
 * A lista de cards é a UNIÃO de `tenants` (os clientes vivos, que o chamador lê
 * de `tenants`) com quem tiver linha no mês. A união importa nas duas pontas:
 * sem `tenants`, cliente que não consumiu simplesmente não existiria na tela —
 * e "esse cliente parou de usar" é a informação mais barata que esta tela dá;
 * sem os `tenant_id` das linhas, um cliente excluído que ainda consumiu no mês
 * sairia dos cards mas continuaria no total, e a soma dos cards não fecharia
 * com o número em destaque no topo.
 */
export function montarVisaoMensal({
  linhas,
  tenants,
  agora,
}: {
  linhas: LinhaConsumo[];
  tenants: TenantConsumo[];
  agora: Date;
}): VisaoMensal {
  const mes = mesCorrente(agora);
  const anterior = mesAnteriorDe(mes);
  const fracao = fracaoDoMes(agora);

  const doMes = linhas.filter((l) => mesDe(l.mes) === mes);
  const doAnterior = linhas.filter((l) => mesDe(l.mes) === anterior);

  const porTenant = new Map(doMes.map((l) => [l.tenant_id, l]));
  const custoAnterior = new Map(doAnterior.map((l) => [l.tenant_id, Number(l.custo_usd)]));

  const conhecidos = new Map(tenants.map((t) => [t.id, t]));
  // Quem tem linha no mês (ou no anterior) e não está na lista de vivos: entrou
  // excluído, e ainda assim conta.
  for (const l of [...doMes, ...doAnterior]) {
    if (!conhecidos.has(l.tenant_id)) {
      conhecidos.set(l.tenant_id, { id: l.tenant_id, nome: l.tenant_nome, deletado: true });
    }
  }

  const cards: CardConsumo[] = [...conhecidos.values()].map((t) => {
    const linha = porTenant.get(t.id);
    const v = linha ? somar(linha) : { entrada: 0, saida: 0, embedding: 0, custo: 0 };
    const tokens = v.entrada + v.saida + v.embedding;

    return {
      tenantId: t.id,
      nome: t.nome,
      deletado: t.deletado,
      ...v,
      // Custo zero NÃO é o mesmo que sem consumo: 50 tokens de embedding custam
      // US$ 0,000001 e arredondam para zero. Quem gastou token usou o sistema.
      semConsumo: tokens === 0 && v.custo === 0,
      variacao: classificarVariacao(v.custo, custoAnterior.get(t.id) ?? 0, fracao),
    };
  });

  cards.sort((a, b) => {
    if (a.semConsumo !== b.semConsumo) return a.semConsumo ? 1 : -1;
    if (b.custo !== a.custo) return b.custo - a.custo;
    // Empate em custo (dois zeros arredondados) desempata por token: quem usou
    // mais aparece antes de quem usou menos.
    const ta = a.entrada + a.saida + a.embedding;
    const tb = b.entrada + b.saida + b.embedding;
    if (tb !== ta) return tb - ta;
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  return {
    mes,
    mesAnterior: anterior,
    // Soma as LINHAS, não os cards: os dois têm de fechar, e somar a fonte
    // deixa a divergência aparecer se algum dia a união acima deixar alguém de fora.
    total: doMes.reduce((acc, l) => acc + Number(l.custo_usd), 0),
    cards,
  };
}

export type MesDoTenant = {
  mes: string;
  entrada: number;
  saida: number;
  embedding: number;
  custo: number;
};

/**
 * Histórico mês a mês de um tenant, do mais recente para o mais antigo.
 *
 * Preenche com zero os meses sem linha entre o primeiro consumo e `ateMes`. A
 * RPC não emite linha para mês sem consumo, e sem o preenchimento a tabela
 * ficaria "ago/2026, jun/2026" com julho invisível — a leitura natural é que
 * julho não existiu, quando o que houve foi um mês parado. Num histórico de
 * custo, mês parado é o dado.
 */
export function historicoDoTenant(
  linhas: LinhaConsumo[],
  tenantId: string,
  ateMes: string,
): MesDoTenant[] {
  const doTenant = linhas.filter((l) => l.tenant_id === tenantId);
  if (doTenant.length === 0) return [];

  const porMes = new Map(doTenant.map((l) => [mesDe(l.mes), { mes: mesDe(l.mes), ...somar(l) }]));
  // `'YYYY-MM'` ordena lexicograficamente igual a cronologicamente — é o motivo
  // de o mês ser carregado como string em vez de Date por toda a tela.
  const meses = [...porMes.keys()].sort();
  const primeiro = meses[0] ?? ateMes;
  const maisRecente = meses[meses.length - 1] ?? ateMes;
  // Se houver linha depois de `ateMes` (relógio atrás do dado), o histórico vai
  // até ela — melhor mostrar dado a mais do que sumir com o mais recente.
  const ultimo = maisRecente > ateMes ? maisRecente : ateMes;

  const saida: MesDoTenant[] = [];
  let cursor = primeiro;
  while (cursor <= ultimo) {
    saida.push(porMes.get(cursor) ?? { mes: cursor, entrada: 0, saida: 0, embedding: 0, custo: 0 });
    cursor = mesSeguinteDe(cursor);
  }

  return saida.reverse();
}

function mesSeguinteDe(mes: string): string {
  const [ano, m] = partes(mes);
  if (m === 12) return `${ano + 1}-01`;
  return `${ano}-${String(m + 1).padStart(2, '0')}`;
}
