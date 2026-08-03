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
