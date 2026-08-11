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
  { valor: 'hora', rotulo: 'Hora' },
  { valor: 'servico', rotulo: 'Serviço' },
] as const;

const UNIDADES_VALIDAS = new Set(UNIDADES.map((u) => u.valor as string));

const MAX_NOME = 120;
const MAX_DESCRICAO = 2000;
const MAX_SKU = 60;
const MAX_ESTOQUE = 1_000_000;

export type ProdutoValidado = {
  nome: string;
  descricao: string | null;
  preco_centavos: number;
  unidade: string;
  sku: string | null;
  estoque: number | null;
  disponivel: boolean;
};

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

  // SKU em branco vira null, não ''. O índice único é parcial em
  // `sku is not null`: dois produtos com '' colidiriam, dois com null não.
  const skuBruto = String(fd.get('sku') ?? '').trim();
  if (skuBruto.length > MAX_SKU) erros['sku'] = `No máximo ${MAX_SKU} caracteres.`;
  const sku = skuBruto || null;

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
      sku,
      estoque,
      disponivel,
    },
  };
}
