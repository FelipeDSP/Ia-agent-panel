'use server';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { ERRO_NAO_CONTRATADA, temToolContratada } from '@/lib/tools/contratacao';
import { criarClienteServidor } from '@/lib/supabase/server';
import { validarProduto } from '@/lib/vendas/schema';

export type EstadoProduto = {
  erro?: string;
  errosCampo?: Record<string, string>;
  sucesso?: string;
  /**
   * O que o cliente digitou, devolvido quando a validação falha.
   *
   * O React 19 reseta formulário não-controlado depois que a action retorna —
   * inclusive quando ela retorna erro. Sem isto, errar o preço apagava nome,
   * descrição e todo o resto: o cliente digitava um produto inteiro e recomeçava
   * do zero por causa de uma vírgula.
   */
  enviado?: Record<string, string>;
  /**
   * Contador de submissões. A tela usa como parte da `key` do formulário para
   * remontá-lo a cada retorno da action — é isso que faz `defaultValue` valer de
   * novo. Sem remontar, `defaultValue` só se aplica na montagem: a última
   * unidade escolhida não chegaria ao próximo cadastro, e `form.reset()`
   * devolveria o valor de quando o form montou.
   */
  tentativa?: number;
};

/** Campos de texto do formulário, para devolver ao cliente em caso de erro. */
function capturarEnviado(fd: FormData): Record<string, string> {
  const campos = ['nome', 'descricao', 'preco', 'unidade', 'sku', 'estoque'];
  const saida: Record<string, string> = {};
  for (const c of campos) saida[c] = String(fd.get(c) ?? '');
  saida['disponivel'] = fd.get('disponivel') === 'on' ? 'on' : '';
  return saida;
}

/** UUID v4 — barra id malformado antes de virar filtro de query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cria ou edita um produto do catálogo do próprio cliente.
 *
 * `tenant_id` vem de exigirTenantAdmin (JWT), nunca do formulário — regra 1 do
 * CLAUDE.md. No INSERT ele é gravado a partir do JWT; no UPDATE ele entra no
 * filtro. Um `produto_id` de outro tenant chegando por chamada direta da action
 * atinge zero linhas, porque o filtro é montado com o tenant de quem chamou. A
 * RLS de `produtos` é a segunda camada (regra 6).
 *
 * O preço chega em reais e sai em centavos daqui: `validarProduto` converte, e
 * nenhum outro ponto do caminho de escrita toca no valor.
 */
export async function salvarProduto(
  estadoAnterior: EstadoProduto,
  fd: FormData,
): Promise<EstadoProduto> {
  const usuario = await exigirTenantAdmin();
  // Superficie de tool: a action e entrada propria. Esconder o menu e
  // recusar a rota nao cobre uma chamada RPC direta.
  if (!(await temToolContratada(usuario.tenantId, 'vendas'))) {
    return { erro: ERRO_NAO_CONTRATADA };
  }

  // Toda saída de erro devolve o que foi digitado — ver `enviado` em EstadoProduto.
  const proximaTentativa = (estadoAnterior.tentativa ?? 0) + 1;
  const comEntrada = (parcial: EstadoProduto): EstadoProduto => ({
    ...parcial,
    enviado: capturarEnviado(fd),
    tentativa: proximaTentativa,
  });

  const id = String(fd.get('id') ?? '').trim();
  if (id && !UUID.test(id)) return comEntrada({ erro: 'Produto inválido.' });

  const validado = validarProduto(fd);
  if (!validado.ok) return comEntrada({ errosCampo: validado.erros });

  const supabase = await criarClienteServidor();
  const campos = validado.valor;

  const { error } = id
    ? await supabase
        .from('produtos')
        .update(campos)
        .eq('id', id)
        .eq('tenant_id', usuario.tenantId)
        .is('deletado_em', null)
    : await supabase.from('produtos').insert({ ...campos, tenant_id: usuario.tenantId });

  if (error) {
    // 23505 = índice único (tenant_id, sku) parcial. Só pode ser SKU: é o único
    // unique da tabela além da PK.
    if (error.code === '23505') {
      return comEntrada({ errosCampo: { sku: 'Já existe um produto ativo com esse SKU.' } });
    }
    if (error.code === '42501') {
      return comEntrada({ erro: 'Sem permissão para alterar este produto.' });
    }
    return comEntrada({ erro: `Não foi possível salvar: ${error.message}` });
  }

  revalidatePath('/painel/catalogo');
  // Sem `enviado`: no sucesso o formulário remonta com os defaults — vazio para
  // um cadastro novo, com os valores salvos numa edição.
  return {
    sucesso: id ? 'Produto atualizado.' : `"${campos.nome}" adicionado ao catálogo.`,
    tentativa: proximaTentativa,
  };
}

/**
 * Remove um produto do catálogo — soft delete, como o resto do schema.
 *
 * Físico quebraria histórico: na fatia 2 um `pedido_itens` antigo referencia o
 * produto pelo id. Além disso o índice único de SKU é parcial em
 * `deletado_em is null`, então apagar assim libera o SKU para reuso.
 */
export async function excluirProduto(id: string): Promise<EstadoProduto> {
  const usuario = await exigirTenantAdmin();
  // Superficie de tool: a action e entrada propria. Esconder o menu e
  // recusar a rota nao cobre uma chamada RPC direta.
  if (!(await temToolContratada(usuario.tenantId, 'vendas'))) {
    return { erro: ERRO_NAO_CONTRATADA };
  }

  if (!UUID.test(String(id ?? ''))) return { erro: 'Produto inválido.' };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase
    .from('produtos')
    .update({ deletado_em: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', usuario.tenantId)
    .is('deletado_em', null)
    .select('id');

  if (error) return { erro: `Não foi possível remover: ${error.message}` };
  // Zero linhas: id de outro tenant, ou já removido. A mensagem não distingue os
  // dois — dizer "esse produto é de outro cliente" confirmaria a existência dele.
  if ((data ?? []).length === 0) return { erro: 'Produto não encontrado.' };

  revalidatePath('/painel/catalogo');
  return { sucesso: 'Produto removido do catálogo.' };
}
