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
  /** Desambigua nomes repetidos na tela. `null` só se o tenant não existir mais. */
  slug: string | null;
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

const USD_CENTAVOS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const USD_DOLARES = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Dinheiro com casas FIXAS dentro da escala.
 *
 * O formatador anterior era `min 2 / max 4`, e o resultado na tela foi uma
 * coluna que se compara com precisões diferentes: `$0.0436`, `$0.0012`,
 * `$0.0002` e então `$0.00` — o último parecia medido em outra régua, quando era
 * só o zero à direita sendo cortado. Aqui, abaixo de um dólar são sempre quatro
 * casas (`$0.0000`), de um dólar para cima sempre duas (`$12.34`), e nunca há
 * duas precisões diferentes na mesma ordem de grandeza.
 */
export function formatarUsd(valor: number): string {
  return Math.abs(valor) >= 1 ? USD_DOLARES.format(valor) : USD_CENTAVOS.format(valor);
}

/**
 * Acima de que percentual o número deixa de informar e vira multiplicador.
 *
 * `▲ 14.433%` foi o que apareceu na tela — em pt-BR o ponto é separador de
 * milhar, então lê-se "quatorze mil por cento", e ao lado de valores com vírgula
 * decimal a leitura fica ambígua. `×145` diz a mesma coisa e cabe na cabeça.
 * Só alta cruza isso: custo não é negativo, então queda não passa de -100%.
 */
export const PCT_VIRA_MULTIPLICADOR = 1000;

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
  /** Nenhum token nos dois meses. Não há o que comparar. */
  | { tipo: 'sem-consumo' }
  /** Usou agora e não tinha usado antes — a divisão por zero, nomeada. */
  | { tipo: 'primeiro-mes' }
  /** Usava e parou. Também é informação. */
  | { tipo: 'parou'; anterior: number; destacar: boolean }
  /**
   * Usou nos dois meses, mas o mês anterior custou MENOS que a menor casa
   * exibível — percentual contra isso não significa nada.
   */
  | { tipo: 'base-zero'; anterior: number }
  | { tipo: 'variou'; pct: number; delta: number; destacar: boolean };

/**
 * Compara o mês corrente com o anterior.
 *
 * QUEM DECIDE "USOU" É O TOKEN, NÃO O CUSTO. A primeira versão classificava por
 * custo e produziu um card que se contradizia na tela: o Empório aparecia com
 * `embedding 50` e, três linhas abaixo, "sem consumo neste mês". Os 50 tokens
 * custam US$ 0,000001, arredondam para zero, e o custo passou a dizer "não usou"
 * enquanto o token dizia "usou". Custo arredonda; token não mente — então
 * presença é token, e o custo entra só como magnitude.
 *
 * `base-zero` é a consequência de ter separado os dois: com presença por token,
 * dá para ter `tokensAnterior > 0` e `custoAnterior == 0`, que é a divisão por
 * zero voltando por outra porta. É o caso do próprio Empório no mês que vem.
 */
export function classificarVariacao({
  custoAtual,
  custoAnterior,
  tokensAtual,
  tokensAnterior,
  fracao,
}: {
  custoAtual: number;
  custoAnterior: number;
  tokensAtual: number;
  tokensAnterior: number;
  fracao: number;
}): Variacao {
  const usouAgora = tokensAtual > 0;
  const usouAntes = tokensAnterior > 0;

  if (!usouAgora && !usouAntes) return { tipo: 'sem-consumo' };
  if (!usouAntes) return { tipo: 'primeiro-mes' };
  if (!usouAgora) {
    return {
      tipo: 'parou',
      anterior: custoAnterior,
      // MESMO PISO DO `variou`, e pelo mesmo motivo. Sem ele, o sandbox que
      // fechou julho em US$ 0,0002 e parou virava o ÚNICO elemento colorido da
      // tela — atenção gasta em dois centésimos de centavo, enquanto a variação
      // de verdade ficava em cinza. Piso ausente aqui contradizia o argumento
      // escrito em LIMIAR_VARIACAO_USD.
      destacar: custoAnterior >= LIMIAR_VARIACAO_USD && fracao >= FRACAO_MES_PARA_QUEDA,
    };
  }
  if (custoAnterior <= 0) return { tipo: 'base-zero', anterior: custoAnterior };

  const delta = custoAtual - custoAnterior;
  const pct = (delta / custoAnterior) * 100;
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
  /**
   * Desambiguador na tela. Havia TRÊS cards com nome parecido e DOIS com nome
   * idêntico ("Sandbox de Testes"), distinguíveis só pelo badge de excluído —
   * numa tela cuja pergunta é "qual cliente está gastando".
   */
  slug: string | null;
  deletado: boolean;
  entrada: number;
  saida: number;
  embedding: number;
  custo: number;
  /** Soma dos três — é o que decide "usou", em vez do custo arredondado. */
  tokens: number;
  /** Nenhum token no mês: vai para o fim da lista, apagado. */
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
 * QUEM ENTRA NA LISTA. Todo cliente vivo, mais todo cliente EXCLUÍDO que tenha
 * linha neste mês ou no anterior. As duas pontas importam: sem os vivos, o
 * cliente que não consumiu não existiria na tela — e "esse cliente parou de
 * usar" é a informação mais barata que esta tela dá; sem os excluídos com linha,
 * um deles sairia dos cards e continuaria no total, e a soma dos cards não
 * fecharia com o número em destaque no topo.
 *
 * `tenants` recebe TODOS os clientes, inclusive os excluídos — é daí que sai o
 * `slug` de quem está excluído. Antes o chamador filtrava `deletado_em` e o
 * excluído entrava só pelo `tenant_nome` da linha, sem slug: dois cards com o
 * nome "Sandbox de Testes" e nada para diferenciar.
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
  const antes = new Map(
    doAnterior.map((l) => {
      const v = somar(l);
      return [l.tenant_id, { custo: v.custo, tokens: v.entrada + v.saida + v.embedding }];
    }),
  );

  const catalogo = new Map(tenants.map((t) => [t.id, t]));
  const comLinha = new Set([...doMes, ...doAnterior].map((l) => l.tenant_id));

  // Vivo entra sempre; excluído entra só se tiver linha no mês ou no anterior —
  // senão a tela acumularia todo cliente já excluído, para sempre.
  const aExibir = tenants.filter((t) => !t.deletado || comLinha.has(t.id));

  // Rede: linha cujo tenant_id não está nem no catálogo (hard delete, que não
  // deveria existir). Entra pelo nome da própria linha, sem slug, em vez de
  // desaparecer e desencontrar a soma.
  for (const id of comLinha) {
    if (!catalogo.has(id)) {
      const l = [...doMes, ...doAnterior].find((x) => x.tenant_id === id);
      aExibir.push({ id, nome: l?.tenant_nome ?? id, slug: null, deletado: true });
    }
  }

  const cards: CardConsumo[] = aExibir.map((t) => {
    const linha = porTenant.get(t.id);
    const v = linha ? somar(linha) : { entrada: 0, saida: 0, embedding: 0, custo: 0 };
    const tokens = v.entrada + v.saida + v.embedding;
    const anteriores = antes.get(t.id) ?? { custo: 0, tokens: 0 };

    return {
      tenantId: t.id,
      nome: t.nome,
      slug: t.slug,
      deletado: t.deletado,
      ...v,
      tokens,
      // TOKEN, não custo: 50 tokens de embedding custam US$ 0,000001 e
      // arredondam para zero. Quem gastou token usou o sistema. (Custo é sempre
      // derivado de token, então token zero implica custo zero — a condição
      // dupla de antes era redundante e, pior, sugeria que podiam divergir.)
      semConsumo: tokens === 0,
      variacao: classificarVariacao({
        custoAtual: v.custo,
        custoAnterior: anteriores.custo,
        tokensAtual: tokens,
        tokensAnterior: anteriores.tokens,
        fracao,
      }),
    };
  });

  cards.sort((a, b) => {
    if (a.semConsumo !== b.semConsumo) return a.semConsumo ? 1 : -1;
    if (b.custo !== a.custo) return b.custo - a.custo;
    // Empate em custo (dois zeros arredondados) desempata por token: quem usou
    // mais aparece antes de quem usou menos.
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
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
