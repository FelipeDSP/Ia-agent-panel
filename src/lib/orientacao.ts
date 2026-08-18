/**
 * Orientação para o admin do cliente (tenant_admin) que vai montar o prompt e a
 * base de conhecimento do próprio agente — normalmente alguém não técnico.
 *
 * Puro (sem 'use client' nem 'server-only'): é importado tanto pelo editor de
 * prompt no browser quanto pela página da base no servidor.
 */

/**
 * Esqueleto de prompt em blocos. O admin usa como ponto de partida e substitui
 * os trechos entre colchetes. O bloco mais importante é o "não sei": instruir o
 * agente a verificar/transferir em vez de inventar resolve a maioria dos casos
 * de resposta errada.
 */
export const MODELO_PROMPT = `# Quem você é
Você é o atendente virtual da [NOME DO NEGÓCIO]. Você fala em nome da empresa, na primeira pessoa.

# Tom de voz
[Ex.: cordial, direto e objetivo. Trate o cliente por "você". Sem gírias e sem emojis.]

# O que você faz
- Tira dúvidas sobre [produtos / serviços].
- Informa horário, endereço, formas de pagamento e preços — sempre com base no que está na base de conhecimento.
- [outras tarefas...]

# O que você NÃO faz
- Nunca inventa preço, prazo, promoção ou qualquer informação que não esteja na base de conhecimento.
- Quando não souber ou não tiver certeza, diz que vai verificar e oferece transferir para um atendente. Nunca "chuta" uma resposta.

# Regras do negócio
[Ex.: Não damos desconto por este canal. Pedidos só dentro do horário de atendimento.]

# Quando chamar um atendente humano
Ofereça transferir para uma pessoa quando: [ex.: o cliente pedir; for uma reclamação; for assunto fora do que você resolve]. A transferência só vale dentro do horário de atendimento configurado.

# Nunca
- Não peça dados sensíveis (senha, número completo de cartão, documento).
- Não prometa nada que a empresa não possa cumprir.`;

/** Dicas curtas ao lado do editor de prompt. */
export const DICAS_PROMPT: string[] = [
  'Comece dizendo quem o agente é e de qual empresa ele fala.',
  'Regra de ouro: quando não souber, mandar verificar ou transferir — nunca inventar.',
  'Seja específico nas regras do negócio (horário, o que não pode prometer).',
  'Diga o tom de voz: formal ou informal, curto ou detalhado, com ou sem emoji.',
  'Preços, horários e endereço ficam melhor na base de conhecimento do que no prompt — assim você atualiza sem mexer no prompt.',
];

/** Dicas para montar a base de conhecimento. */
export const DICAS_BASE: string[] = [
  'Um assunto por documento (horário, pagamento, serviços, entrega…), não um manual gigante.',
  'Escreva como se estivesse respondendo a um cliente, não como documento interno.',
  'Prefira parágrafos curtos e diretos — o agente encontra a resposta com mais precisão.',
  'Use as palavras que o cliente usa ("quanto custa", "valor", "preço" na mesma resposta).',
  'Mudou algo? Atualize a base. O agente responde pelo que está aqui, não pelo histórico das conversas.',
];

/**
 * O CRITÉRIO QUE DECIDE ONDE CADA COISA MORA.
 *
 * Existia — é o quinto item de `DICAS_PROMPT` — e estava dentro de um
 * `<details>` fechado, nas DUAS telas. Ou seja: a regra de maior consequência do
 * painel exigia dois cliques e uma leitura até o fim da lista.
 *
 * O Empório é a prova de que não chegava: 5.708 caracteres de fatos (horário,
 * entrega, pagamento, endereço) no prompt e 127 na base — exatamente a inversão
 * contra a qual a dica avisa. E o erro é caro e mudo: o prompt entra em TODA
 * chamada ao modelo, a base só quando alguém pergunta. Ninguém percebe pelo
 * atendimento; percebe-se na fatura, meses depois.
 *
 * Por isso a frase saiu do acordeão e virou texto fixo. As duas metades são
 * recíprocas de propósito: em qualquer das duas telas que a pessoa caia, ela
 * aprende a divisão inteira. Vivem aqui, juntas, para não divergirem quando
 * alguém editar só uma.
 */
export const CRITERIO_NO_PROMPT =
  'Aqui vai QUEM o agente é e COMO ele se comporta: tom de voz, regras e o que ele nunca deve fazer. ' +
  'Preço, horário, endereço, entrega e pagamento ficam melhor na base de conhecimento — lá você atualiza sem mexer no prompt.';

export const CRITERIO_NA_BASE =
  'Aqui vai o que MUDA: preço, horário, endereço, entrega, pagamento, políticas de troca. ' +
  'Como o agente fala e o que ele não pode prometer ficam no prompt, na Visão geral.';

/**
 * Quantos trechos a busca devolve por pergunta.
 *
 * NÃO é enfeite de texto: é o número que a tool do n8n passa para
 * `api_n8n_buscar_kb` (`n8n/workflows/Tool - Busca KB Multi-Tenant.json`, nó
 * `Busca Vetorial`). O aviso de base pequena diz "o agente recebe TODOS os seus
 * trechos" e isso só é verdade enquanto o total couber aqui — se os dois
 * divergirem, o painel passa a afirmar algo falso sobre o comportamento do
 * agente. `tests/conhecimento-lista.mjs` compara os dois.
 */
export const TRECHOS_POR_BUSCA = 5;
