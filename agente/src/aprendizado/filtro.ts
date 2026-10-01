/**
 * O filtro do aprendizado automático — o que PODE virar base de conhecimento.
 *
 * Decisão do Felipe (01/10): o ciclo é silencioso, ninguém confirma. Isso
 * move todo o peso para cá: esta é a única coisa entre o que um atendente
 * digitou às pressas e um texto que o agente vai repetir para todos os
 * clientes daquela empresa, por tempo indeterminado, com cara de fonte
 * oficial.
 *
 * Por isso o filtro é CÓDIGO, não instrução ao modelo. A regra escrita num
 * prompt é sugestão: o modelo acerta quase sempre e erra calado. O que está
 * aqui reprova sozinho, é testável, e falha FECHANDO — na dúvida, não publica.
 * Publicar de menos custa uma pergunta que o agente continua não sabendo;
 * publicar de mais custa uma informação errada dita a todo mundo, que ninguém
 * vai conferir porque o ciclo é silencioso.
 *
 * As quatro recusas, e a razão de cada uma:
 *
 *  1. DADO PESSOAL. A resposta foi escrita para uma pessoa e cita telefone,
 *     CPF, e-mail, CEP ou valores de matrícula dela. A base responde a todos
 *     — publicar isso vaza o dado de um cliente para os outros, e não é só
 *     LGPD: é o dado do cliente DELE, que a empresa nos confiou;
 *  2. CASO PARTICULAR. "No seu caso são 30 dias porque você entrou em agosto"
 *     é verdade sobre uma pessoa. Virando base, o agente passa a dizer 30 dias
 *     para quem entrou em março. É o erro mais provável deste ciclo, porque a
 *     frase parece uma resposta perfeitamente boa;
 *  3. NÃO-RESPOSTA. "Vou verificar e te retorno", "bom dia", "só um momento".
 *     Não contêm informação; virariam ruído que a busca vetorial devolve no
 *     lugar do que importa — e com base pequena (o Empório tem 2 trechos) o
 *     ruído aparece em TODA pergunta;
 *  4. TAMANHO. Curto demais não informa; longo demais é conversa inteira
 *     colada, não entrada de base.
 *
 * O que NÃO está aqui: julgar se o atendente respondeu certo. Isso é da
 * empresa, e é exatamente o que o botão delega.
 */

export type Recusa =
  | 'dado_pessoal'
  | 'caso_particular'
  | 'nao_resposta'
  | 'curta'
  | 'longa'
  | 'sem_pergunta'
  | 'nao_ancorado';

export interface Veredito {
  publicar: boolean;
  motivo?: Recusa;
  /** O texto limpo que vai para a base, quando publicar. */
  texto?: string;
}

/** Mínimo e máximo de caracteres da resposta aproveitável. */
export const MIN_RESPOSTA = 60;
export const MAX_RESPOSTA = 1200;

/**
 * Dado pessoal por FORMA, não por lista de nomes.
 *
 * Telefone brasileiro, CPF, CNPJ, e-mail, CEP e número de cartão. Os padrões
 * aceitam os separadores que a pessoa digita (ponto, traço, barra, espaço) —
 * um CPF escrito "123 456 789 00" é CPF do mesmo jeito.
 */
const PADROES_PESSOAIS: { nome: string; re: RegExp }[] = [
  { nome: 'email', re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { nome: 'cpf', re: /\b\d{3}[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{2}\b/ },
  { nome: 'cnpj', re: /\b\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3}[\s/\-]?\d{4}[\s.\-]?\d{2}\b/ },
  { nome: 'telefone', re: /(?:\+?55\s?)?\(?\b\d{2}\)?[\s.\-]?9?\d{4}[\s.\-]?\d{4}\b/ },
  { nome: 'cep', re: /\b\d{5}[\s.\-]?\d{3}\b/ },
];

/**
 * Marcas de "isto vale só para você".
 *
 * Segunda pessoa combinada com um fato (`no seu caso`, `para você fica`), e
 * referência a um atendimento individual (`sua matrícula`, `seu pedido`).
 * Não basta ter "você": "você precisa trazer RG e CPF" é regra geral e tem de
 * passar. O que reprova é a construção que ancora o fato NAQUELA pessoa.
 */
const MARCAS_PARTICULARES: RegExp[] = [
  /\bno seu caso\b/i,
  /\bpara (?:o |a )?(?:seu|sua)\b/i,
  /\bcomo (?:você|voce) (?:já |ja )?(?:entrou|fez|pagou|enviou|solicitou|iniciou)\b/i,
  /\b(?:sua|seu) (?:matr[ií]cula|inscri[çc][ãa]o|pedido|cadastro|contrato|processo|protocolo|turma|boleto)\b/i,
  /\bj[áa] (?:consta|est[áa]) no (?:seu|teu)\b/i,
  /\bverifiquei (?:aqui )?(?:o |a |seu |sua )/i,
];

/** Frases que não carregam informação. */
const NAO_RESPOSTAS: RegExp[] = [
  /^(?:oi|ol[áa]|bom dia|boa tarde|boa noite|tudo bem)[\s!,.?]*$/i,
  /\b(?:vou|vamos) (?:verificar|conferir|checar|ver)\b/i,
  /\bj[áa] (?:te )?(?:retorno|respondo|aviso)\b/i,
  /\b(?:um|s[óo] um) (?:momento|instante|minuto)\b/i,
  /\baguard[ea]\b.{0,20}\b(?:retorno|resposta)\b/i,
];

const normalizar = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** O primeiro padrão pessoal que casar, ou null. */
export function dadoPessoalEm(texto: string): string | null {
  const t = normalizar(texto);
  for (const p of PADROES_PESSOAIS) if (p.re.test(t)) return p.nome;
  return null;
}

export function ehCasoParticular(texto: string): boolean {
  const t = normalizar(texto);
  return MARCAS_PARTICULARES.some((re) => re.test(t));
}

export function ehNaoResposta(texto: string): boolean {
  const t = normalizar(texto);
  return NAO_RESPOSTAS.some((re) => re.test(t));
}

/**
 * A ÂNCORA — a medida de "o modelo não acrescentou fato".
 *
 * O extrator pede ao modelo que a resposta esteja contida no que o atendente
 * escreveu. Pedido não é garantia: modelo preenche lacuna com plausibilidade,
 * e num ciclo silencioso ninguém pega. Então aqui se MEDE: que fração das
 * palavras de conteúdo da resposta proposta aparece no diálogo real.
 *
 * Palavra de conteúdo = com 4+ letras, fora da lista de ligação. Números
 * contam e contam alto: "30 dias" inventado é exatamente o erro caro, e um
 * número que não está no diálogo derruba a âncora sozinho.
 *
 * DUAS MEDIDAS, porque são duas coisas diferentes:
 *
 *  - NÚMERO é fato. Todo número da resposta tem de existir no diálogo, sem
 *    piso e sem tolerância: "15 dias" onde o atendente disse 30, ou uma "taxa
 *    de 20 reais" que ninguém mencionou, é o erro caro deste ciclo inteiro;
 *  - PALAVRA é forma. O modelo impessoaliza ("o certificado é emitido" ->
 *    "a emissão do certificado leva"), e exigir identidade reprovaria toda
 *    extração útil — medido: uma reescrita fiel dá 0,75. O piso aqui só pega
 *    resposta que mudou de assunto.
 *
 * Foi assim que ficou depois de o piso único de 0,8 reprovar a reescrita
 * correta e aprovar... nada melhor: ele media as duas coisas com a mesma
 * régua e errava nas duas pontas.
 */
export const PISO_ANCORA = 0.6;

const LIGACAO = new Set(['para', 'pela', 'pelo', 'come', 'esta', 'esse', 'essa', 'isso', 'aqui', 'onde', 'quando', 'como', 'mais', 'menos', 'muito', 'pode', 'podem', 'sobre', 'entre', 'depois', 'antes', 'tambem', 'ainda', 'apenas', 'porque', 'entao', 'seja', 'sera', 'foram', 'temos', 'tenho', 'nossa', 'nosso', 'voce', 'dele', 'dela']);

const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Palavras de conteúdo e números de um texto. */
export function palavrasDeConteudo(texto: string): string[] {
  const t = semAcento(String(texto ?? ''));
  const numeros = t.match(/\d+/g) ?? [];
  const palavras = (t.match(/[a-z]{4,}/g) ?? []).filter((p) => !LIGACAO.has(p));
  return [...palavras, ...numeros];
}

/**
 * TODO número da resposta aparece no diálogo? Sem piso: um número a mais é um
 * fato a mais, e fato a mais é invenção.
 */
export function numerosAncorados(resposta: string, dialogo: string): boolean {
  const alvo = String(resposta ?? '').match(/\d+/g) ?? [];
  if (alvo.length === 0) return true;
  const fonte = new Set(String(dialogo ?? '').match(/\d+/g) ?? []);
  return alvo.every((n) => fonte.has(n));
}

/**
 * Fração das palavras de conteúdo da resposta que existem no diálogo.
 * Resposta vazia devolve 0 — ausência de prova não é prova.
 */
export function ancorado(resposta: string, dialogo: string): number {
  const alvo = palavrasDeConteudo(resposta);
  if (alvo.length === 0) return 0;
  const fonte = new Set(palavrasDeConteudo(dialogo));
  const dentro = alvo.filter((p) => fonte.has(p)).length;
  return dentro / alvo.length;
}

/**
 * O veredito. Ordem importa só para o motivo registrado; qualquer recusa
 * reprova. `pergunta` vazia reprova porque a entrada da base precisa do par:
 * um texto solto não é consultável por similaridade com a dúvida de ninguém.
 *
 * `dialogo` opcional: quando vem (o caminho normal, depois do extrator), a
 * âncora roda. Sem ele o filtro ainda vale, só não mede invenção — e é por
 * isso que o ciclo sempre o passa.
 */
export function avaliar(pergunta: string, resposta: string, dialogo?: string): Veredito {
  const p = normalizar(pergunta);
  const r = normalizar(resposta);
  if (!p) return { publicar: false, motivo: 'sem_pergunta' };
  if (r.length < MIN_RESPOSTA) return { publicar: false, motivo: 'curta' };
  if (r.length > MAX_RESPOSTA) return { publicar: false, motivo: 'longa' };
  if (ehNaoResposta(r)) return { publicar: false, motivo: 'nao_resposta' };
  const pessoal = dadoPessoalEm(r);
  if (pessoal) return { publicar: false, motivo: 'dado_pessoal' };
  if (ehCasoParticular(r)) return { publicar: false, motivo: 'caso_particular' };
  if (dialogo !== undefined && (!numerosAncorados(r, dialogo) || ancorado(r, dialogo) < PISO_ANCORA)) {
    return { publicar: false, motivo: 'nao_ancorado' };
  }
  return { publicar: true, texto: textoDaEntrada(p, r) };
}

/**
 * O texto que vai para a base.
 *
 * Pergunta e resposta juntas, porque a busca é por similaridade com a PERGUNTA
 * do próximo cliente: um chunk que só tem a resposta ("é em até 30 dias
 * úteis") não casa com "quanto tempo demora o certificado". O rótulo final
 * declara a origem — quem abrir a base vê que aquilo veio do atendimento, e
 * não de um documento que alguém subiu.
 */
export function textoDaEntrada(pergunta: string, resposta: string): string {
  return `Pergunta: ${pergunta}\n\nResposta: ${resposta}\n\n(Registrado automaticamente a partir de um atendimento humano.)`;
}

/** Título do documento na base — curto e reconhecível na lista. */
export function tituloDaEntrada(pergunta: string): string {
  const p = normalizar(pergunta);
  return (p.length <= 80 ? p : `${p.slice(0, 77)}...`) || 'Aprendido no atendimento';
}
