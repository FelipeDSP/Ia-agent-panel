'use server';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { validarEdicaoTenantAdmin } from '@/lib/tenants/schema';
import {
  TOOL_TRANSFERIR,
  validarTransferirCliente,
  type ConfigTransferir,
} from '@/lib/tools/transferir-humano';

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

/**
 * Cliente configura o COMPORTAMENTO da transferência para atendimento humano:
 * liga/desliga, horário de atendimento e para onde ser avisado no WhatsApp.
 *
 * Infra (workflow_id, descrição, sessão do WAHA) é da agência e NÃO é tocada
 * aqui — só atualizamos `ativo` e `config`, e o `config` é reconstruído
 * preservando a `sessao` que a agência gravou. A linha precisa já existir
 * (a agência habilita a tool antes); senão, orientamos a falar com a agência.
 *
 * tenantId vem do JWT (exigirTenantAdmin) e filtramos explícito por ele (regra
 * 1 e 6). RLS de tenant_tools ainda escopa por tenant como rede de segurança.
 */
export async function salvarTransferirHumano(
  _estado: EstadoConfig,
  fd: FormData,
): Promise<EstadoConfig> {
  const usuario = await exigirTenantAdmin();

  const validado = validarTransferirCliente(fd);
  if (!validado.ok) return { errosCampo: validado.erros };

  const supabase = await criarClienteServidor();

  const { data: linha, error: erroSel } = await supabase
    .from('tenant_tools')
    .select('config')
    .eq('tenant_id', usuario.tenantId)
    .eq('tool_nome', TOOL_TRANSFERIR)
    .maybeSingle();

  if (erroSel) return { erro: `Não foi possível carregar: ${erroSel.message}` };
  if (!linha) {
    return {
      erro: 'A transferência para humano ainda não foi habilitada pela agência para este cliente.',
    };
  }

  const atual = (linha.config ?? {}) as Partial<ConfigTransferir>;
  const sessao = atual.notificacao?.sessao;

  // Sem sessão configurada pela agência, não há para onde o WAHA enviar — força
  // canal 'nenhum' para não deixar um 'waha' pendurado que falharia calado.
  const canal = validado.valor.canal === 'waha' && sessao ? 'waha' : 'nenhum';

  const novaConfig: ConfigTransferir = {
    horario: validado.valor.horario,
    notificacao: {
      canal,
      ...(sessao ? { sessao } : {}),
      ...(validado.valor.destino ? { destino: validado.valor.destino } : {}),
    },
  };

  const { error } = await supabase
    .from('tenant_tools')
    .update({ ativo: validado.valor.ativo, config: novaConfig })
    .eq('tenant_id', usuario.tenantId)
    .eq('tool_nome', TOOL_TRANSFERIR);

  if (error) return { erro: `Não foi possível salvar: ${error.message}` };

  revalidatePath('/painel/configuracoes');
  return { sucesso: 'Configuração de transferência salva.' };
}
