'use server';

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { validarEdicaoTenantAdmin } from '@/lib/tenants/schema';
import { clientePodeDesligar } from '@/lib/tools/registro';
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

export type ResultadoModulo = { ok: true } | { ok: false; erro: string };

/**
 * Cliente liga/desliga um módulo contratado ("Meus módulos").
 *
 * SÓ CONTRATÁVEL. Padrão e configurável não têm switch na tela, e a checagem
 * está aqui porque esconder o botão não é o mesmo que não poder: sem este guard
 * uma chamada direta ainda desligaria `busca_conhecimento`, e o cliente ficaria
 * com o agente respondendo sem base de conhecimento e sem caminho de volta —
 * a tela dele não mostra mais o módulo. É a mesma classe do `tool_ativa` que
 * ninguém checava e do `config_tool` que ignorava `contratado`.
 *
 * Toca SOMENTE `ativo`. `contratado` é decisão comercial da agência e o trigger
 * tenant_tools_guard_colunas barra quem não é super_admin — mandar as duas
 * colunas juntas faria o guard reprovar o update inteiro, inclusive a parte
 * legítima.
 *
 * tenantId vem de exigirTenantAdmin (JWT), nunca do argumento — regra 1 do
 * CLAUDE.md. O filtro explícito por tenant_id é a primeira camada; a RLS de
 * tenant_tools é a segunda (regra 6). Um cliente do tenant A chamando esta ação
 * direto, com o tool_nome de um módulo do tenant B, atinge zero linhas: o filtro
 * é montado com o tenant DELE.
 */
export async function alternarModulo(
  toolNome: string,
  ativo: boolean,
): Promise<ResultadoModulo> {
  const usuario = await exigirTenantAdmin();

  // Forma do identificador. Barra string arbitrária vinda do cliente antes de
  // ela virar filtro de query. NÃO exige estar no registry: tool criada no
  // catálogo e vendida antes de alguém escrever o rótulo cai em `contratavel`,
  // e recusar aqui deixaria um switch na tela do cliente que sempre falha —
  // que era o comportamento anterior.
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(toolNome)) {
    return { ok: false, erro: 'Módulo desconhecido.' };
  }

  // O guard de capacidade. Vem ANTES de qualquer ida ao banco: negar é mais
  // barato que consultar para depois negar.
  if (!clientePodeDesligar(toolNome)) {
    return {
      ok: false,
      erro: 'Este módulo é padrão do produto e não pode ser desligado.',
    };
  }

  const supabase = await criarClienteServidor();

  // Exige linha contratada. Sem esta checagem, uma chamada direta ligaria um
  // módulo que a agência não vendeu: o guard permite `ativo`, e o sub-workflow
  // do n8n consulta `tool_ativa` — não `contratado` — para decidir se responde.
  const { data: linha, error: erroSel } = await supabase
    .from('tenant_tools')
    .select('contratado')
    .eq('tenant_id', usuario.tenantId)
    .eq('tool_nome', toolNome)
    .maybeSingle();

  if (erroSel) return { ok: false, erro: `Não foi possível carregar: ${erroSel.message}` };
  if (!linha || !linha.contratado) {
    return { ok: false, erro: 'Este módulo não está incluído no seu plano. Fale com a agência.' };
  }

  const { error } = await supabase
    .from('tenant_tools')
    .update({ ativo })
    .eq('tenant_id', usuario.tenantId)
    .eq('tool_nome', toolNome);

  if (error) {
    if (error.code === '42501') {
      return { ok: false, erro: 'Sem permissão para alterar este módulo.' };
    }
    return { ok: false, erro: `Não foi possível salvar: ${error.message}` };
  }

  revalidatePath('/painel/configuracoes');
  return { ok: true };
}

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
 * horário de atendimento e para onde ser avisado no WhatsApp.
 *
 * NÃO grava `ativo`: ligar/desligar é do switch em "Meus módulos"
 * (alternarModulo), fonte única. Enquanto os dois existiam, este formulário
 * enviava o `ativo` que fotografou ao montar (checkbox uncontrolled), então
 * salvar o horário depois de mexer no switch revertia o switch em silêncio.
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
    .update({ config: novaConfig })
    .eq('tenant_id', usuario.tenantId)
    .eq('tool_nome', TOOL_TRANSFERIR);

  if (error) return { erro: `Não foi possível salvar: ${error.message}` };

  revalidatePath('/painel/configuracoes');
  return { sucesso: 'Configuração de transferência salva.' };
}
