/**
 * As capacidades que uma função de conta pode conceder.
 *
 * Decisão do Felipe, 06/10/2026: funções NOMEADAS, como as funções
 * personalizadas do Chatwoot. O admin da conta cria "Vendedor", marca o que
 * ela pode, e atribui a função às pessoas — mudar a função muda todo mundo
 * que a tem. Desenho em `docs/DESENHO-USUARIOS-POR-CONTA.md` §6–10.
 *
 * O CLIENTE COMPÕE FUNÇÕES, NÃO INVENTA CAPACIDADE. Esta lista é fixa e vive
 * no código, como o registry de tools — e o banco tem a mesma lista em
 * `capacidades_conhecidas()`, porque a RLS precisa dela para saber o que
 * "admin pode tudo" quer dizer.
 *
 * SÃO DOIS LADOS DE UM PAR DERIVADO, e par derivado diverge. Por isso
 * `teste:funcoes-por-conta` EXECUTA a função do banco e compara com este
 * arquivo, em vez de confiar que alguém manteve os dois iguais — é a mesma
 * disciplina de `migracao-portao-venda`, que roda o SQL em vez de comparar
 * texto.
 */
export const CAPACIDADES = [
  {
    chave: 'ver_conversas',
    rotulo: 'Ver conversas',
    resumo: 'Abrir a lista de conversas e ler o histórico com os clientes.',
  },
  {
    chave: 'pausar_retomar',
    rotulo: 'Pausar e retomar o agente',
    resumo: 'Fazer o agente parar de responder numa conversa, e voltar.',
  },
  {
    chave: 'limpar_memoria',
    rotulo: 'Limpar a memória de uma conversa',
    resumo: 'Fazer o agente esquecer o que foi dito e recomeçar do zero.',
  },
  {
    chave: 'marcar_pedido',
    rotulo: 'Marcar pedido como pago ou retirado',
    resumo: 'Confirmar no painel que o cliente pagou ou buscou o pedido.',
  },
  {
    chave: 'editar_catalogo',
    rotulo: 'Editar o catálogo',
    resumo: 'Criar, mudar e remover produtos, categorias e fotos.',
  },
  {
    chave: 'editar_prompt',
    rotulo: 'Editar o prompt do agente',
    resumo: 'Mudar quem o agente é e como ele se comporta.',
  },
  {
    chave: 'editar_base',
    rotulo: 'Editar a base de conhecimento',
    resumo: 'Subir e remover documentos que o agente consulta para responder.',
  },
  {
    chave: 'ver_consumo',
    rotulo: 'Ver relatórios e consumo',
    resumo: 'Abrir os relatórios de atendimento e o uso do agente.',
  },
] as const;

export type Capacidade = (typeof CAPACIDADES)[number]['chave'];

/** Só as chaves, na ordem — é esta lista que o banco também tem. */
export const CHAVES_CAPACIDADES: readonly string[] = CAPACIDADES.map((c) => c.chave);

export function definicaoCapacidade(chave: string) {
  return CAPACIDADES.find((c) => c.chave === chave) ?? null;
}

/** `tenant_admin` e `super_admin` não têm função: podem tudo, sempre. */
export const PAPEIS = ['super_admin', 'tenant_admin', 'tenant_agente'] as const;
export type Papel = (typeof PAPEIS)[number];

export function podeTudo(papel: string): boolean {
  return papel === 'super_admin' || papel === 'tenant_admin';
}

/**
 * O que ESTE usuário pode. Espelha `auth_capacidades()` do banco — mas a
 * decisão de verdade é sempre a do banco: isto serve para a TELA esconder o
 * que não adianta mostrar, e a RLS/função é que nega de fato.
 *
 * As duas camadas são de propósito (regra 6 do CLAUDE.md, e a nota de
 * superfície de tool: esconder não é o mesmo que não poder).
 */
export function capacidadesDe(papel: string, daFuncao: readonly string[] | null | undefined): string[] {
  if (podeTudo(papel)) return [...CHAVES_CAPACIDADES];
  return (daFuncao ?? []).filter((c) => CHAVES_CAPACIDADES.includes(c));
}

export function pode(papel: string, daFuncao: readonly string[] | null | undefined, capacidade: Capacidade): boolean {
  return capacidadesDe(papel, daFuncao).includes(capacidade);
}
