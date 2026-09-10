'use server';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { ERRO_NAO_CONTRATADA, temToolContratada } from '@/lib/tools/contratacao';
import { criarClienteServidor } from '@/lib/supabase/server';

/**
 * Categorias do catálogo — criar, renomear, remover.
 *
 * SUPERFÍCIE DE TOOL: categoria é seção de `vendas`, e toda action é entrada
 * própria. Esconder o menu e recusar a rota não cobre uma chamada direta, então
 * as três checam contratação — a mesma regra que `salvarProduto` já segue.
 *
 * `tenant_id` vem do JWT, nunca do formulário (regra 1 do CLAUDE.md). No INSERT
 * é gravado a partir dele; no UPDATE e no DELETE entra no filtro, então um id de
 * outro tenant atinge zero linhas. A RLS de `categorias` é a segunda camada
 * (regra 6).
 *
 * ---------------------------------------------------------------------------
 * REMOVER CATEGORIA QUE TEM PRODUTO: RECUSA, e a decisão está tomada
 *
 * A FK é `on delete restrict`. As alternativas foram descartadas por motivo, não
 * por omissão:
 *
 *   - `set null` deixaria produtos sem categoria em silêncio, e o formulário
 *     passaria a exigir do cliente algo que o próprio sistema acabou de tirar
 *     dele. Na fase 2 a categoria é FALADA ao cliente final: um produto sem
 *     categoria vira um buraco na resposta do agente;
 *   - `cascade` apagaria produtos, que é trabalho de cadastro que ninguém
 *     devolve — a mesma razão pela qual descontratar não apaga catálogo.
 *
 * A tela mostra quantos produtos usam a categoria e manda movê-los antes. É mais
 * passos para quem remove, e é o único caminho em que nada some sem o cliente
 * ter decidido.
 */

export type EstadoCategoria = {
  erro?: string;
  sucesso?: string;
  /** Quantos produtos impediram a remoção — a tela usa para explicar. */
  produtosEmUso?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOME = 60;

/** Espelha `categorias_nome_nao_vazio` e `categorias_nome_tamanho` da 57. */
function validarNome(bruto: unknown): { ok: true; nome: string } | { ok: false; erro: string } {
  const nome = String(bruto ?? '').trim();
  if (!nome) return { ok: false, erro: 'Informe o nome da categoria.' };
  if (nome.length > MAX_NOME) return { ok: false, erro: `No máximo ${MAX_NOME} caracteres.` };
  return { ok: true, nome };
}

// A CHECAGEM DE CONTRATAÇÃO É REPETIDA NAS TRÊS, DE PROPÓSITO.
//
// A primeira versão a extraiu para um `exigirVendas()` compartilhado, que é mais
// limpo de ler e CEGA a guarda: `npm run teste:superficie` conta as ocorrências
// de `temToolContratada(` contra o número de actions do arquivo, e viu 3 actions
// com 1 checagem. A guarda existe porque action é entrada própria — esconder o
// menu e recusar a rota não cobrem uma chamada direta —, e uma guarda textual só
// enxerga o que está escrito.
//
// Entre um helper que a verificação não alcança e três linhas iguais que ela
// conta, a repetição ganha. É a mesma escolha que `salvarProduto` e
// `excluirProduto` já fazem, com o mesmo comentário.

export async function criarCategoria(
  _estadoAnterior: EstadoCategoria,
  fd: FormData,
): Promise<EstadoCategoria> {
  const usuario = await exigirTenantAdmin();
  // Superfície de tool: a action é entrada própria.
  if (!(await temToolContratada(usuario.tenantId, 'vendas'))) {
    return { erro: ERRO_NAO_CONTRATADA };
  }

  const v = validarNome(fd.get('nome'));
  if (!v.ok) return { erro: v.erro };

  const supabase = await criarClienteServidor();
  const { error } = await supabase
    .from('categorias')
    .insert({ nome: v.nome, tenant_id: usuario.tenantId });

  if (error) {
    // 23505 = `uq_categorias_tenant_nome`, que é `(tenant_id, lower(nome))`. A
    // mensagem cita a comparação sem caixa de propósito: sem isso o cliente
    // tenta "QUEIJOS" depois de "Queijos" e não entende a recusa.
    if (error.code === '23505') {
      return { erro: `Você já tem uma categoria "${v.nome}" (a comparação ignora maiúsculas).` };
    }
    return { erro: `Não foi possível criar: ${error.message}` };
  }

  revalidatePath('/painel/catalogo');
  revalidatePath('/painel/catalogo/categorias');
  return { sucesso: `Categoria "${v.nome}" criada.` };
}

export async function renomearCategoria(
  _estadoAnterior: EstadoCategoria,
  fd: FormData,
): Promise<EstadoCategoria> {
  const usuario = await exigirTenantAdmin();
  // Superfície de tool: a action é entrada própria.
  if (!(await temToolContratada(usuario.tenantId, 'vendas'))) {
    return { erro: ERRO_NAO_CONTRATADA };
  }

  const id = String(fd.get('id') ?? '').trim();
  if (!UUID.test(id)) return { erro: 'Categoria inválida.' };

  const v = validarNome(fd.get('nome'));
  if (!v.ok) return { erro: v.erro };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase
    .from('categorias')
    .update({ nome: v.nome })
    .eq('id', id)
    .eq('tenant_id', usuario.tenantId)
    .select('id');

  if (error) {
    if (error.code === '23505') {
      return { erro: `Você já tem uma categoria "${v.nome}" (a comparação ignora maiúsculas).` };
    }
    return { erro: `Não foi possível renomear: ${error.message}` };
  }
  // Zero linhas: id de outro tenant, ou já removida. A mensagem não distingue os
  // dois — dizer "essa categoria é de outro cliente" confirmaria a existência.
  if ((data ?? []).length === 0) return { erro: 'Categoria não encontrada.' };

  revalidatePath('/painel/catalogo');
  revalidatePath('/painel/catalogo/categorias');
  return { sucesso: 'Categoria renomeada.' };
}

export async function removerCategoria(id: string): Promise<EstadoCategoria> {
  const usuario = await exigirTenantAdmin();
  // Superfície de tool: a action é entrada própria.
  if (!(await temToolContratada(usuario.tenantId, 'vendas'))) {
    return { erro: ERRO_NAO_CONTRATADA };
  }

  if (!UUID.test(String(id ?? ''))) return { erro: 'Categoria inválida.' };

  const supabase = await criarClienteServidor();

  // Conta ANTES para poder explicar. A contagem é informativa; quem de fato
  // recusa é o `on delete restrict` da FK, logo abaixo — se este select ficasse
  // sozinho, uma corrida entre a contagem e o delete removeria a categoria de um
  // produto cadastrado no meio.
  const { count } = await supabase
    .from('produtos')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', usuario.tenantId)
    .eq('categoria_id', id)
    .is('deletado_em', null);

  const { data, error } = await supabase
    .from('categorias')
    .delete()
    .eq('id', id)
    .eq('tenant_id', usuario.tenantId)
    .select('id');

  if (error) {
    // 23503 = `produtos_categoria_fk` com `on delete restrict`. É a decisão do
    // cabeçalho acontecendo: nada some sem o cliente ter movido os produtos.
    if (error.code === '23503') {
      return {
        erro: 'Essa categoria ainda tem produtos. Mova-os para outra categoria antes de remover.',
        produtosEmUso: count ?? undefined,
      };
    }
    return { erro: `Não foi possível remover: ${error.message}` };
  }
  if ((data ?? []).length === 0) return { erro: 'Categoria não encontrada.' };

  revalidatePath('/painel/catalogo');
  revalidatePath('/painel/catalogo/categorias');
  return { sucesso: 'Categoria removida.' };
}
