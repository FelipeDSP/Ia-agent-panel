/**
 * O que está incoerente na configuração de uma conta — PURO, sem banco.
 *
 * Por que isto existe separado do assistente (08/10): num só dia, lendo a
 * configuração de três clientes à mão, apareceram oito defeitos — e nenhum
 * deles precisava de inteligência para ser achado. Precisava de alguém
 * olhando. O `{{CATALOGO_DE_CURSOS}}` da estud.you, o horário escrito no
 * prompt do Empório contradizendo a configuração, o documento com job
 * `concluido` de 80 chunks e zero linhas na tabela, a polpa duplicada.
 *
 * A divisão de trabalho com a LLM é esta, e ela é deliberada:
 *
 *   MECÂNICO (aqui)  — o que uma comparação resolve. Não erra, não custa
 *                      token, e o resultado é um FATO que o assistente cita.
 *   SEMÂNTICO (LLM)  — "este prompt manda rotear mas a conta vende",
 *                      "este documento do cliente não cabe no prompt".
 *
 * Um assistente que descobre o mecânico conversando é um assistente que
 * ADIVINHA sobre a conta do cliente. Estes achados entram no contexto dele
 * prontos, e ele fala sobre eles em vez de procurá-los.
 *
 * Puro de propósito: roda em teste sem banco, e sabotar uma detecção é
 * trocar uma linha e ver o teste reprovar.
 */

export type Gravidade = 'erro' | 'aviso' | 'nota';

export type Achado = {
  /** Estável: é por ela que o teste e o assistente se referem ao achado. */
  chave: string;
  gravidade: Gravidade;
  titulo: string;
  /** O que está errado, em uma frase, para quem não escreveu o sistema. */
  detalhe: string;
  /** Onde se conserta, na linguagem do painel. */
  onde: string;
};

/** O retrato da conta. Montado em `snapshot.ts`; aqui só é lido. */
export type RetratoConta = {
  prompt: string;
  /** `tenants.horario_agente` já lido, ou null quando a conta não configurou. */
  horario: { janelas: { dias: number[]; inicio: string; fim: string }[] } | null;
  /** Tools contratadas E ativas. */
  toolsAtivas: string[];
  vendas: { pagamentos: string[]; retirada_fisica: boolean } | null;
  produtos: { nome: string; preco_centavos: number; disponivel: boolean }[];
  /** Um por documento: o que o job disse e o que existe na tabela. */
  documentos: { nome: string; status: string; chunksJob: number; chunksTabela: number }[];
  /** Respostas que o portão barrou nos últimos 7 dias. */
  barradas: { conversationId: number; veredito: string; bruto: string | null }[];
};

/**
 * O ELO entre um job de ingestão e os chunks dele em `kb_documentos`.
 *
 * Mora aqui, puro e testado, porque errá-lo não dá erro — dá FALSO POSITIVO.
 * A primeira versão cruzava tudo por `'texto:' || id` e acusou 16 de 22
 * documentos como sumidos, incluindo os 13 da estud.you, que estavam
 * perfeitamente no lugar. O número certo é 3. Uma tela de diagnóstico que erra
 * para mais manda o cliente reenviar o que já está lá, e queima a confiança
 * na tela inteira.
 *
 *   tipo = 'arquivo'  -> a origem é o CAMINHO NO STORAGE (`arquivo_path`)
 *   tipo = 'texto'    -> a origem é `texto:<id do job>`
 */
export function chaveDeOrigem(job: { id: string; tipo: string; arquivo_path?: string | null }): string {
  return job.tipo === 'arquivo' ? (job.arquivo_path ?? '') : `texto:${job.id}`;
}

/** `{{...}}` esquecido: o serviço concatena o prompt verbatim, sem substituir. */
function placeholders(texto: string): string[] {
  return [...new Set(
    [...String(texto ?? '').matchAll(/\{\{([^{}]{1,200})\}\}/g)].map((m) => m[1]!.trim()).filter(Boolean),
  )];
}

/**
 * O prompt fala de horário? Procura hora (`7h`, `19:00`) ou os dias da semana
 * escritos — é como o lojista escreve, e foi como estava no Empório.
 */
function falaDeHorario(texto: string): boolean {
  return /\b\d{1,2}\s?h\b|\b\d{1,2}:\d{2}\b|segunda a sexta|ter[çc]a a sexta|fim de semana/i.test(texto);
}

/** O prompt enumera forma de pagamento? */
function falaDePagamento(texto: string): boolean {
  return /\b(pix|cart[ãa]o|dinheiro|d[ée]bito|cr[ée]dito)\b/i.test(texto);
}

export function detectar(c: RetratoConta): Achado[] {
  const achados: Achado[] = [];
  const add = (a: Achado) => achados.push(a);

  // ---- prompt ---------------------------------------------------------
  const ph = placeholders(c.prompt);
  if (ph.length > 0) {
    add({
      chave: 'prompt_placeholders',
      gravidade: 'erro',
      titulo: `O prompt tem ${ph.length === 1 ? 'um marcador' : `${ph.length} marcadores`} que ninguém preenche`,
      detalhe: `O agente lê ${ph.slice(0, 3).map((p) => `{{${p}}}`).join(', ')} como texto, exatamente assim. `
        + 'Nada neste sistema substitui marcador — não há motor de template.',
      onde: 'Prompt',
    });
  }

  // Horário em DOIS lugares. Só é problema quando a conta configurou horário:
  // sem configuração, o prompt é o único lugar onde ele pode estar.
  if (c.horario && c.horario.janelas.length > 0 && falaDeHorario(c.prompt)) {
    add({
      chave: 'horario_em_dois_lugares',
      gravidade: 'aviso',
      titulo: 'O horário está no prompt E na configuração',
      detalhe: 'A grade da semana já vai ao agente a partir de Configurações, e muda na hora em que você mexe lá. '
        + 'O que está escrito no prompt não muda — e passa a desmentir a configuração.',
      onde: 'Prompt / Configurações → Horário',
    });
  }

  // Pagamento em dois lugares, pela mesma razão.
  if (c.vendas && falaDePagamento(c.prompt)) {
    add({
      chave: 'pagamento_em_dois_lugares',
      gravidade: 'aviso',
      titulo: 'As formas de pagamento estão no prompt e na configuração',
      detalhe: 'Quando as duas discordam, o agente tem duas verdades no mesmo turno — '
        + 'o prompt chega sempre, a base de conhecimento chega quando a busca traz.',
      onde: 'Prompt / Configurações → Vendas',
    });
  }

  // ---- catálogo --------------------------------------------------------
  const vivos = c.produtos.filter((p) => p.disponivel);
  const porNome = new Map<string, number>();
  for (const p of c.produtos) {
    const k = p.nome.trim().toLowerCase();
    porNome.set(k, (porNome.get(k) ?? 0) + 1);
  }
  const duplicados = [...porNome.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (duplicados.length > 0) {
    add({
      chave: 'produto_duplicado',
      gravidade: 'aviso',
      titulo: `${duplicados.length === 1 ? 'Um produto aparece' : `${duplicados.length} produtos aparecem`} duas vezes no catálogo`,
      detalhe: `Repetido: ${duplicados.slice(0, 3).join(', ')}. O agente pode anotar um e você separar o outro.`,
      onde: 'Catálogo',
    });
  }
  const semPreco = vivos.filter((p) => p.preco_centavos <= 0);
  if (semPreco.length > 0) {
    add({
      chave: 'produto_sem_preco',
      gravidade: 'erro',
      titulo: `${semPreco.length} produto(s) disponível(eis) com preço zerado`,
      detalhe: `O agente vai oferecer por R$ 0,00: ${semPreco.slice(0, 3).map((p) => p.nome).join(', ')}.`,
      onde: 'Catálogo',
    });
  }
  // Vende sem catálogo é o agente sem nada para oferecer.
  if (c.toolsAtivas.includes('vendas') && vivos.length === 0) {
    add({
      chave: 'vendas_sem_catalogo',
      gravidade: 'erro',
      titulo: 'A conta vende, e o catálogo está vazio',
      detalhe: 'Sem produto disponível o agente não tem o que oferecer nem como montar pedido.',
      onde: 'Catálogo',
    });
  }

  // ---- base de conhecimento -------------------------------------------
  // O job diz que concluiu e a tabela não tem nada. A tela mostra o documento
  // como presente e o agente nunca o encontra — silencioso dos dois lados.
  // (Empório, "Lei da Prevenção": job concluído com 80 chunks, zero linhas.)
  const sumiram = c.documentos.filter((d) => d.status === 'concluido' && d.chunksJob > 0 && d.chunksTabela === 0);
  if (sumiram.length > 0) {
    add({
      chave: 'documento_sem_chunks',
      gravidade: 'erro',
      titulo: `${sumiram.length} documento(s) aparecem na tela mas o agente não encontra`,
      detalhe: `${sumiram.slice(0, 2).map((d) => `"${d.nome}" (o processamento disse ${d.chunksJob} trechos, há 0)`).join('; ')}. `
        + 'Precisa ser enviado de novo.',
      onde: 'Base de conhecimento',
    });
  }
  if (c.documentos.length === 0) {
    add({
      chave: 'base_vazia',
      gravidade: 'nota',
      titulo: 'A base de conhecimento está vazia',
      detalhe: 'Tudo o que o agente sabe vem do prompt. Horário, endereço, políticas e perguntas frequentes '
        + 'rendem mais na base: ela é consultada quando faz falta e não ocupa espaço em toda mensagem.',
      onde: 'Base de conhecimento',
    });
  }

  // ---- o que o portão barrou ------------------------------------------
  if (c.barradas.length > 0) {
    add({
      chave: 'portao_barrou',
      gravidade: c.barradas.length >= 3 ? 'erro' : 'aviso',
      titulo: `${c.barradas.length} resposta(s) do agente foram bloqueadas nos últimos 7 dias`,
      detalhe: 'O bloqueio troca a resposta por um texto genérico, e o cliente lê esse texto. '
        + 'Em geral é sinal de que o prompt manda afirmar algo que o agente não consegue registrar.',
      onde: 'Conversas',
    });
  }

  // ---- coerência entre o que vende e o que o prompt diz ----------------
  if (!c.toolsAtivas.includes('vendas') && /\bpedido\b/i.test(c.prompt)) {
    add({
      chave: 'fala_de_pedido_sem_vender',
      gravidade: 'nota',
      titulo: 'O prompt fala em "pedido" e a conta não tem vendas',
      detalhe: 'Não é defeito — "pedido" também quer dizer solicitação. Fica anotado porque é a origem '
        + 'de confusão quando alguém for ler a configuração depois.',
      onde: 'Prompt',
    });
  }

  return achados;
}

/** Ordena por gravidade: erro, aviso, nota. Para a tela e para o contexto. */
export const PESO: Record<Gravidade, number> = { erro: 0, aviso: 1, nota: 2 };
export function ordenar(a: Achado[]): Achado[] {
  return [...a].sort((x, y) => PESO[x.gravidade] - PESO[y.gravidade]);
}
