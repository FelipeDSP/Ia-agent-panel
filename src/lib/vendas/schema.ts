/**
 * Validação do formulário de produto (fatia 1 de vendas).
 *
 * Puro, sem acesso a banco: as Server Actions chamam isto antes de escrever, e
 * o `tenant_id` NUNCA vem daqui — vem do JWT, na action (regra 1 do CLAUDE.md).
 *
 * `variacoes` não é validada nesta fatia: a coluna existe no banco para a fatia
 * 2 e a UI não a expõe.
 */

import { parsearPrecoParaCentavos } from './dinheiro';

/**
 * Espelha o CHECK `produtos_unidade_valida` da migração 23. Mexeu aqui, mexeu
 * lá — o banco recusa valor fora desta lista, então divergir vira erro 23514 na
 * cara do cliente.
 */
export const UNIDADES = [
  { valor: 'un', rotulo: 'Unidade (un)' },
  { valor: 'kg', rotulo: 'Quilo (kg)' },
  { valor: 'g', rotulo: 'Grama (g)' },
  { valor: 'l', rotulo: 'Litro (l)' },
  { valor: 'ml', rotulo: 'Mililitro (ml)' },
  { valor: 'm', rotulo: 'Metro (m)' },
  { valor: 'm2', rotulo: 'Metro quadrado (m²)' },
  { valor: 'peca', rotulo: 'Peça' },
  { valor: 'par', rotulo: 'Par' },
  { valor: 'porcao', rotulo: 'Porção' },
  // Couvert, rodízio, buffet: o restaurante cobra por pessoa, não por unidade.
  // Sem isto o agente confirmaria "4 unidades de couvert" (migração 24).
  { valor: 'pessoa', rotulo: 'Pessoa' },
  { valor: 'hora', rotulo: 'Hora' },
  { valor: 'servico', rotulo: 'Serviço' },
] as const;

const UNIDADES_VALIDAS = new Set(UNIDADES.map((u) => u.valor as string));

const MAX_NOME = 120;
const MAX_DESCRICAO = 2000;
const MAX_ESTOQUE = 1_000_000;

export type ProdutoValidado = {
  nome: string;
  descricao: string | null;
  preco_centavos: number;
  unidade: string;
  categoria_id: string;
  estoque: number | null;
  disponivel: boolean;
};

/** UUID v4 — barra id malformado antes de virar filtro de query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResultadoValidacao =
  | { ok: true; valor: ProdutoValidado }
  | { ok: false; erros: Record<string, string> };

export function validarProduto(fd: FormData): ResultadoValidacao {
  const erros: Record<string, string> = {};

  const nome = String(fd.get('nome') ?? '').trim();
  if (!nome) erros['nome'] = 'Informe o nome do produto.';
  else if (nome.length > MAX_NOME) erros['nome'] = `No máximo ${MAX_NOME} caracteres.`;

  const descricaoBruta = String(fd.get('descricao') ?? '').trim();
  if (descricaoBruta.length > MAX_DESCRICAO) {
    erros['descricao'] = `No máximo ${MAX_DESCRICAO} caracteres.`;
  }
  const descricao = descricaoBruta || null;

  // O cliente digita reais; o banco guarda centavos. A conversão acontece aqui
  // e em nenhum outro lugar do caminho de escrita.
  const preco = parsearPrecoParaCentavos(String(fd.get('preco') ?? ''));
  if (!preco.ok) erros['preco'] = preco.erro;

  const unidade = String(fd.get('unidade') ?? '').trim() || 'un';
  if (!UNIDADES_VALIDAS.has(unidade)) erros['unidade'] = 'Escolha uma unidade da lista.';

  // O SKU NÃO VEM DAQUI, e a ausência é o ponto: desde a migração 57 ele é
  // gerado pelo banco (trigger `trg_produtos_sku`, sequência por tenant) e o
  // formulário não o oferece. Ler `fd.get('sku')` aqui reabriria a porta para o
  // cliente digitar um número que colide com a sequência — e o índice único
  // recusaria o cadastro seguinte, com o erro caindo num campo que a tela nem
  // mostra mais.
  //
  // Editar produto também não manda sku: o UPDATE não inclui a coluna, então o
  // valor gerado permanece. Número que nunca muda é o que faz um pedido antigo
  // continuar apontando para o mesmo produto.

  // Categoria: obrigatória no FORMULÁRIO, nullable no banco. A coluna aceita
  // null porque os 90 produtos legados entraram pelo backfill da 57 e um
  // `not null` teria obrigado a inventar uma categoria "sem categoria" — o mesmo
  // vazio com outro nome, e um nome que o agente falaria ao cliente na fase 2.
  const categoriaId = String(fd.get('categoria_id') ?? '').trim();
  if (!categoriaId) erros['categoria_id'] = 'Escolha uma categoria.';
  else if (!UUID.test(categoriaId)) erros['categoria_id'] = 'Categoria inválida.';

  // Vazio = não controla estoque (null), diferente de 0 = controla e esgotou.
  const estoqueBruto = String(fd.get('estoque') ?? '').trim();
  let estoque: number | null = null;
  if (estoqueBruto !== '') {
    const n = Number(estoqueBruto);
    if (!Number.isInteger(n)) erros['estoque'] = 'Use um número inteiro, ou deixe vazio.';
    else if (n < 0) erros['estoque'] = 'O estoque não pode ser negativo.';
    else if (n > MAX_ESTOQUE) erros['estoque'] = `No máximo ${MAX_ESTOQUE.toLocaleString('pt-BR')}.`;
    else estoque = n;
  }

  // Pausar o item sem mexer no estoque nem removê-lo do catálogo. Checkbox
  // ausente no POST significa desmarcado — por isso o campo espelho
  // `disponivel_presente`, que distingue "desmarcou" de "o form nem tem o campo".
  const disponivel = fd.has('disponivel_presente')
    ? fd.get('disponivel') === 'on' || fd.get('disponivel') === 'true'
    : true;

  if (Object.keys(erros).length > 0) return { ok: false, erros };

  return {
    ok: true,
    valor: {
      nome,
      descricao,
      preco_centavos: preco.ok ? preco.centavos : 0,
      unidade,
      categoria_id: categoriaId,
      estoque,
      disponivel,
    },
  };
}
