'use server';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { validarEdicaoTenantAdmin } from '@/lib/tenants/schema';

export type EstadoConfig = {
  erro?: string;
  errosCampo?: Record<string, string>;
  sucesso?: string;
};

/**
 * O tenant_admin edita as próprias configurações: mensagens de sistema,
 * debounce e liga/desliga do agente. NÃO o prompt (ação à parte, versionada),
 * nem modelo/temperatura/tokens (bloqueados pelo trigger).
 *
 * O tenantId vem de exigirTenantAdmin (JWT), nunca do formulário — regra 1 do
 * CLAUDE.md. Ainda que o formulário mandasse outro id, ele é ignorado.
 */
export async function salvarConfigTenant(
  _estado: EstadoConfig,
  fd: FormData,
): Promise<EstadoConfig> {
  const usuario = await exigirTenantAdmin();

  const validado = validarEdicaoTenantAdmin(fd);
  if (!validado.ok) return { errosCampo: validado.erros };

  const supabase = await criarClienteServidor();
  const { error } = await supabase
    .from('tenants')
    .update({
      agente_ativo: validado.valor.agente_ativo,
      debounce_segundos: validado.valor.debounce_segundos,
      msg_midia_nao_suportada: validado.valor.msg_midia_nao_suportada,
      msg_fora_escopo: validado.valor.msg_fora_escopo,
    })
    .eq('id', usuario.tenantId);

  if (error) {
    if (error.code === '42501') {
      return { erro: 'Sem permissão para alterar estes campos.' };
    }
    return { erro: `Não foi possível salvar: ${error.message}` };
  }

  revalidatePath('/painel');
  revalidatePath('/painel/configuracoes');
  return { sucesso: 'Configurações salvas.' };
}
