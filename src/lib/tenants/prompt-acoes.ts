'use server';

import { revalidatePath } from 'next/cache';

import { ERRO_SEM_CAPACIDADE, exigirUsuario, membroPode, type UsuarioAtual } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

/**
 * Quem pode mexer no prompt deste cliente.
 *
 * ERA FROUXA ATÉ 15/10, e o buraco não era pequeno: a checagem antiga só
 * perguntava se um `tenant_admin` estava mexendo em OUTRO cliente. Um
 * `tenant_agente` passava inteiro — e a RLS de `tenants` deixava, porque ela
 * só confere o tenant, não a capacidade. Medido pelo caminho público: um
 * atendente entrando com o próprio e-mail e senha na API do Supabase trocou o
 * `system_prompt` da conta.
 *
 * A capacidade `editar_prompt` já existia e já era exigida pela RLS de
 * `prompt_versoes`: o HISTÓRICO estava protegido e o prompt vivo não.
 *
 * `membroPode` e não `exigirMembro` porque esta ação também serve o
 * super_admin vindo de /admin/tenants/[id], e `exigirMembro` manda super_admin
 * de volta para o painel dele.
 */
async function podeMexerNoPrompt(usuario: UsuarioAtual, tenantId: string): Promise<string | null> {
  if (usuario.papel === 'super_admin') return null;
  if (usuario.tenantId !== tenantId) return 'Sem permissão para este cliente.';
  if (!(await membroPode(usuario, 'editar_prompt'))) return ERRO_SEM_CAPACIDADE;
  return null;
}

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
  const recusa = await podeMexerNoPrompt(usuario, tenantId);
  if (recusa) return { erro: recusa };

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
  const recusa = await podeMexerNoPrompt(usuario, tenantId);
  if (recusa) return { erro: recusa };

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
