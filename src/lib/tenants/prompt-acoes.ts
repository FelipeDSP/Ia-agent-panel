'use server';

import { revalidatePath } from 'next/cache';

import { exigirUsuario } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

export type EstadoPrompt = {
  erro?: string;
  sucesso?: string;
};

/**
 * Salva o system_prompt de um tenant.
 *
 * Serve os dois papéis. Não precisa ramificar por papel aqui: o UPDATE passa
 * pela RLS (só a própria linha, para tenant_admin) e pelo trigger
 * tenants_guard_colunas — se um tenant_admin tentar embutir outro campo, o
 * banco recusa. system_prompt está na whitelist, então o save passa.
 *
 * O versionamento é automático: o trigger tenants_versionar_prompt grava o
 * prompt anterior em prompt_versoes. Nenhuma escrita explícita aqui — é o que
 * garante que nenhum caminho de edição esqueça de versionar.
 */
export async function salvarPrompt(
  tenantId: string,
  _estado: EstadoPrompt,
  fd: FormData,
): Promise<EstadoPrompt> {
  const usuario = await exigirUsuario();

  // tenant_admin só mexe no próprio tenant. super_admin em qualquer um.
  if (usuario.papel === 'tenant_admin' && usuario.tenantId !== tenantId) {
    return { erro: 'Sem permissão para este cliente.' };
  }

  const novo = String(fd.get('system_prompt') ?? '').trim();
  if (novo.length < 1) return { erro: 'O prompt não pode ficar vazio.' };

  const supabase = await criarClienteServidor();
  const { error } = await supabase
    .from('tenants')
    .update({ system_prompt: novo })
    .eq('id', tenantId);

  if (error) {
    // 42501 = o guard barrou (não deveria acontecer só com system_prompt).
    if (error.code === '42501') {
      return { erro: 'Sem permissão para alterar estes campos.' };
    }
    return { erro: `Não foi possível salvar: ${error.message}` };
  }

  revalidatePath(usuario.papel === 'super_admin' ? `/admin/tenants/${tenantId}` : '/painel');
  return { sucesso: 'Prompt salvo.' };
}

/**
 * Restaura uma versão anterior do prompt.
 *
 * Copia o conteúdo da versão escolhida de volta para tenants.system_prompt. O
 * trigger versiona o prompt vigente antes de trocar, então o rollback não
 * perde o que estava lá — vira mais uma entrada no histórico.
 */
export async function restaurarVersaoPrompt(
  tenantId: string,
  versaoId: string,
): Promise<EstadoPrompt> {
  const usuario = await exigirUsuario();

  if (usuario.papel === 'tenant_admin' && usuario.tenantId !== tenantId) {
    return { erro: 'Sem permissão para este cliente.' };
  }

  const supabase = await criarClienteServidor();

  // Lê a versão sob RLS: só devolve se for do tenant do usuário (ou super).
  const { data: versao, error: erroLeitura } = await supabase
    .from('prompt_versoes')
    .select('conteudo, tenant_id')
    .eq('id', versaoId)
    .maybeSingle();

  if (erroLeitura || !versao) return { erro: 'Versão não encontrada.' };
  if (versao.tenant_id !== tenantId) return { erro: 'Versão não pertence a este cliente.' };

  const { error } = await supabase
    .from('tenants')
    .update({ system_prompt: versao.conteudo })
    .eq('id', tenantId);

  if (error) return { erro: `Não foi possível restaurar: ${error.message}` };

  revalidatePath(usuario.papel === 'super_admin' ? `/admin/tenants/${tenantId}` : '/painel');
  return { sucesso: 'Prompt restaurado a partir da versão selecionada.' };
}
