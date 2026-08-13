'use server';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { ERRO_NAO_CONTRATADA, temToolContratada } from '@/lib/tools/contratacao';
import { criarClienteServidor } from '@/lib/supabase/server';
import { LIMITE_BYTES, MIMES_ACEITOS } from '@/lib/vendas/foto';

export type EstadoFoto = {
  erro?: string;
  sucesso?: string;
};

/** UUID v4 — barra id malformado antes de virar filtro de query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BUCKET = 'produto-fotos';

/**
 * Path FIXO por produto: `{tenant_id}/{produto_id}.jpg`.
 *
 * Fixo em vez de UUID por upload, de propósito. Com UUID, trocar a foto deixaria
 * o arquivo anterior órfão no bucket, e um cliente que ajusta a foto cinco vezes
 * pagaria armazenamento por cinco. Com path fixo, o `upsert` substitui.
 *
 * A URL entregue à tela é assinada e de vida curta, então cache de navegador não
 * é problema: cada carregamento gera uma assinatura nova.
 */
function pathDaFoto(tenantId: string, produtoId: string): string {
  return `${tenantId}/${produtoId}.jpg`;
}

/**
 * Sobe (ou substitui) a foto de um produto do próprio cliente.
 *
 * A imagem chega JÁ redimensionada pelo navegador (`@/lib/vendas/foto`). Esta
 * action NÃO confia nisso: revalida MIME e tamanho antes de subir, e o
 * `file_size_limit` do bucket é a terceira barreira. As três existem porque a
 * primeira é a única que um `fetch` fora da UI consegue pular.
 *
 * `tenant_id` vem de `exigirTenantAdmin` (JWT), nunca do formulário — regra 1 do
 * CLAUDE.md. O produto é confirmado como do tenant ANTES do upload: sem isso,
 * um `produto_id` alheio faria o arquivo cair na pasta de quem chamou com o
 * nome de um produto que não é dele, e a coluna do outro tenant ficaria
 * intocada — lixo silencioso.
 */
export async function salvarFotoProduto(
  _estado: EstadoFoto,
  fd: FormData,
): Promise<EstadoFoto> {
  const usuario = await exigirTenantAdmin();
  // Superficie de tool: a action e entrada propria. Esconder o menu e
  // recusar a rota nao cobre uma chamada RPC direta.
  if (!(await temToolContratada(usuario.tenantId, 'foto_produto'))) {
    return { erro: ERRO_NAO_CONTRATADA };
  }

  const produtoId = String(fd.get('produto_id') ?? '');
  if (!UUID.test(produtoId)) return { erro: 'Produto inválido.' };

  const arquivo = fd.get('foto');
  if (!(arquivo instanceof File) || arquivo.size === 0) {
    return { erro: 'Selecione uma imagem.' };
  }
  if (!MIMES_ACEITOS.includes(arquivo.type)) {
    return { erro: 'Formato não suportado. Envie JPG, PNG ou WEBP.' };
  }
  if (arquivo.size > LIMITE_BYTES) {
    return { erro: `Imagem acima de ${Math.round(LIMITE_BYTES / 1024)} KB. Envie uma foto menor.` };
  }

  const supabase = await criarClienteServidor();

  const { data: produto, error: erroProd } = await supabase
    .from('produtos')
    .select('id')
    .eq('tenant_id', usuario.tenantId)
    .eq('id', produtoId)
    .is('deletado_em', null)
    .maybeSingle();
  if (erroProd) return { erro: `Não foi possível carregar o produto: ${erroProd.message}` };
  if (!produto) return { erro: 'Produto não encontrado.' };

  const path = pathDaFoto(usuario.tenantId, produtoId);

  const { error: erroUp } = await supabase.storage
    .from(BUCKET)
    .upload(path, arquivo, { contentType: 'image/jpeg', upsert: true });
  if (erroUp) return { erro: `Falha no upload: ${erroUp.message}` };

  const { error: erroCol } = await supabase
    .from('produtos')
    .update({ foto_path: path })
    .eq('tenant_id', usuario.tenantId)
    .eq('id', produtoId);

  if (erroCol) {
    // Coluna não gravou: remove o arquivo para não deixar objeto sem dono na
    // tabela. Mesmo tratamento que `subirArquivo` dá ao job órfão da ingestão.
    await supabase.storage.from(BUCKET).remove([path]);
    return { erro: `Não foi possível vincular a foto: ${erroCol.message}` };
  }

  revalidatePath('/painel/catalogo');
  return { sucesso: 'Foto atualizada.' };
}

/**
 * Remove a foto: apaga o objeto e zera a coluna.
 *
 * Diferente da exclusão de PRODUTO, em que o arquivo FICA — lá o soft delete
 * preserva histórico de pedido, e apagar a imagem quebraria a visualização de um
 * pedido antigo (decisão registrada em VENDAS-ESTADO.md). Aqui o cliente está
 * dizendo "esta foto não", e mantê-la seria guardar o que ele pediu para tirar.
 */
export async function removerFotoProduto(
  _estado: EstadoFoto,
  fd: FormData,
): Promise<EstadoFoto> {
  const usuario = await exigirTenantAdmin();
  // Superficie de tool: a action e entrada propria. Esconder o menu e
  // recusar a rota nao cobre uma chamada RPC direta.
  if (!(await temToolContratada(usuario.tenantId, 'foto_produto'))) {
    return { erro: ERRO_NAO_CONTRATADA };
  }

  const produtoId = String(fd.get('produto_id') ?? '');
  if (!UUID.test(produtoId)) return { erro: 'Produto inválido.' };

  const supabase = await criarClienteServidor();
  const path = pathDaFoto(usuario.tenantId, produtoId);

  // Zera a coluna PRIMEIRO. Se a ordem fosse a inversa e o update falhasse, a
  // tela apontaria para um arquivo que não existe mais; assim o pior caso é um
  // objeto órfão, que não quebra nada e a próxima troca sobrescreve.
  const { error: erroCol } = await supabase
    .from('produtos')
    .update({ foto_path: null })
    .eq('tenant_id', usuario.tenantId)
    .eq('id', produtoId);
  if (erroCol) return { erro: `Não foi possível remover: ${erroCol.message}` };

  await supabase.storage.from(BUCKET).remove([path]);

  revalidatePath('/painel/catalogo');
  return { sucesso: 'Foto removida.' };
}
