'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { exigirSuperAdmin } from '@/lib/auth';
import { validarCredencialChatwoot } from '@/lib/chatwoot';
import { criarClienteAdmin } from '@/lib/supabase/admin';
import { criarClienteServidor } from '@/lib/supabase/server';
import { validarConfigTenantSuper, validarCriacaoTenant } from '@/lib/tenants/schema';
import { criarUsuario, ehEmailDuplicado } from '@/lib/supabase/admin-usuarios';
import {
  HORARIO_PADRAO,
  TOOL_TRANSFERIR,
  validarTransferirAgencia,
  type ConfigTransferir,
} from '@/lib/tools/transferir-humano';

export type EstadoAcao = {
  erro?: string;
  errosCampo?: Record<string, string>;
  sucesso?: string;
  /** Link de convite a mostrar quando não há SMTP para enviá-lo. */
  linkConvite?: string;
};

/**
 * Cria um tenant. Só super admin.
 *
 * O INSERT passa pelo server client (RLS): a policy p_tenants_insert exige
 * auth_is_super_admin(). Não uso o admin client aqui — criar tenant é uma
 * operação que o próprio super admin tem permissão de fazer, então RLS basta e
 * a rede de segurança do banco continua ativa.
 */
export async function criarTenant(
  _estado: EstadoAcao,
  fd: FormData,
): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const validado = validarCriacaoTenant(fd);
  if (!validado.ok) return { errosCampo: validado.erros };

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase
    .from('tenants')
    .insert({
      nome: validado.valor.nome,
      slug: validado.valor.slug,
      system_prompt: validado.valor.system_prompt,
      modelo: validado.valor.modelo,
      temperatura: validado.valor.temperatura,
      debounce_segundos: validado.valor.debounce_segundos,
    })
    .select('id, slug')
    .single();

  if (error) {
    // 23505 = violação de unique (slug já existe).
    if (error.code === '23505') {
      return { errosCampo: { slug: 'Já existe um cliente com esse slug.' } };
    }
    return { erro: `Não foi possível criar o cliente: ${error.message}` };
  }

  revalidatePath('/admin/tenants');
  return { sucesso: `Cliente "${validado.valor.slug}" criado.` };
}

/**
 * Convida o admin de um tenant.
 *
 * inviteUserByEmail NÃO serve: não aceita app_metadata, então o tenant_id não
 * chegaria ao JWT e o trigger não vincularia (mesma limitação da Fase 2). O
 * caminho é createUser com app_metadata + link de recuperação.
 *
 * Sem SMTP configurado, o link volta na resposta e é mostrado ao super admin
 * para envio manual. Roda com o admin client (service_role), server-only.
 */
export async function convidarAdminTenant(
  _estado: EstadoAcao,
  fd: FormData,
): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tenantId = String(fd.get('tenant_id') ?? '');
  const email = String(fd.get('email') ?? '').trim().toLowerCase();
  const nome = String(fd.get('nome') ?? '').trim() || email;

  if (!tenantId) return { erro: 'Tenant não informado.' };
  if (!email.includes('@')) return { errosCampo: { email: 'Email inválido.' } };

  const admin = criarClienteAdmin();

  // Confere que o tenant existe e está vivo, sob o olhar do super admin (RLS).
  const supabase = await criarClienteServidor();
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, nome')
    .eq('id', tenantId)
    .is('deletado_em', null)
    .maybeSingle();

  if (!tenant) return { erro: 'Cliente não encontrado.' };

  // createUser com app_metadata: o trigger da migração 12 cria a linha em
  // usuarios_painel vinculada ao tenant. criarUsuario tem retry no erro ES256.
  const { data, error } = await criarUsuario(admin, {
    email,
    email_confirm: true,
    app_metadata: { papel: 'tenant_admin', tenant_id: tenantId },
    user_metadata: { nome },
  });

  if (error && ehEmailDuplicado(error)) {
    return {
      errosCampo: {
        email:
          'Já existe uma conta com esse email. Um usuário pertence a um único cliente.',
      },
    };
  }
  if (error) return { erro: `Falha ao criar o convite: ${error.message}` };

  // Leitura por id em usuarios_painel é imediata (o trigger escreveu de forma
  // síncrona). NÃO uso listUsers aqui, que é eventualmente consistente.
  const { data: vinculo } = await supabase
    .from('usuarios_painel')
    .select('tenant_id, papel')
    .eq('id', data.user.id)
    .maybeSingle();

  if (vinculo?.tenant_id !== tenantId || vinculo?.papel !== 'tenant_admin') {
    return {
      erro: 'Usuário criado, mas o vínculo com o cliente não foi registrado. Verifique a migração 12.',
    };
  }

  // Link para o convidado definir a senha.
  const origem = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const { data: linkData, error: erroLink } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email,
  });

  if (erroLink || !linkData) {
    return {
      sucesso: `Convite criado para ${email}, mas não foi possível gerar o link. Use "reenviar convite".`,
    };
  }

  /*
   * Montamos o link para o NOSSO handler /auth/confirmar (fluxo token_hash do
   * @supabase/ssr), não devolvemos o `action_link` do GoTrue. O action_link é o
   * endpoint /verify, que entrega o token no fragmento `#access_token=...` — e o
   * fragmento nunca chega ao servidor, então o handler veria token_hash vazio e
   * cairia em link_invalido. `hashed_token` é justamente o valor que o
   * verifyOtp espera como token_hash.
   */
  const linkConvite =
    `${origem}/auth/confirmar` +
    `?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}` +
    `&type=recovery&proximo=${encodeURIComponent('/nova-senha')}`;

  revalidatePath(`/admin/tenants/${tenantId}`);
  return {
    sucesso: `Convite criado para ${email}.`,
    linkConvite,
  };
}

/**
 * Confere que o usuário alvo é tenant_admin DESTE cliente antes de qualquer
 * ação de gestão. A verificação é contra o banco (não contra o request), então
 * o super admin nunca consegue mexer, por id forjado, num super_admin ou num
 * admin de outro tenant. Devolve a linha ou null.
 */
async function carregarAdminDoTenant(
  supabase: Awaited<ReturnType<typeof criarClienteServidor>>,
  tenantId: string,
  userId: string,
) {
  const { data } = await supabase
    .from('usuarios_painel')
    .select('id, email, nome, papel, tenant_id')
    .eq('id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!data || data.papel !== 'tenant_admin') return null;
  return data;
}

/**
 * Remove um admin de um cliente. Só super admin.
 *
 * Não há FK de usuarios_painel para auth.users e o login não olha a coluna
 * `ativo` — a autorização vem do JWT. Então revogar acesso de verdade é apagar
 * no Auth (mata a sessão e impede login) E apagar a linha da projeção. Uma não
 * cascateia na outra. A remoção da linha passa pelo RLS (p_usuarios_delete =
 * super_admin) e leva filtro explícito de tenant além do id.
 */
export async function removerAdmin(_estado: EstadoAcao, fd: FormData): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tenantId = String(fd.get('tenant_id') ?? '');
  const userId = String(fd.get('user_id') ?? '');
  if (!tenantId || !userId) return { erro: 'Dados incompletos.' };

  const supabase = await criarClienteServidor();
  const alvo = await carregarAdminDoTenant(supabase, tenantId, userId);
  if (!alvo) return { erro: 'Admin não encontrado neste cliente.' };

  const admin = criarClienteAdmin();
  const { error: erroAuth } = await admin.auth.admin.deleteUser(userId);
  if (erroAuth) return { erro: `Não foi possível revogar o acesso: ${erroAuth.message}` };

  const { error: erroLinha } = await supabase
    .from('usuarios_painel')
    .delete()
    .eq('id', userId)
    .eq('tenant_id', tenantId);

  if (erroLinha) {
    // Acesso já foi revogado no Auth; a linha órfã é inofensiva (login é por JWT),
    // mas avisa para não parecer sucesso limpo.
    return {
      sucesso: `Acesso de ${alvo.email} revogado, mas a linha na tabela não saiu: ${erroLinha.message}`,
    };
  }

  revalidatePath(`/admin/tenants/${tenantId}`);
  return { sucesso: `Admin ${alvo.email} removido.` };
}

/** Edita o nome de exibição de um admin. Só super admin. */
export async function editarNomeAdmin(_estado: EstadoAcao, fd: FormData): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tenantId = String(fd.get('tenant_id') ?? '');
  const userId = String(fd.get('user_id') ?? '');
  const nome = String(fd.get('nome') ?? '').trim();
  if (!tenantId || !userId) return { erro: 'Dados incompletos.' };
  if (!nome) return { errosCampo: { nome: 'Informe o nome.' } };

  const supabase = await criarClienteServidor();
  const alvo = await carregarAdminDoTenant(supabase, tenantId, userId);
  if (!alvo) return { erro: 'Admin não encontrado neste cliente.' };

  // Fonte da verdade do nome é o user_metadata no Auth; a projeção espelha.
  const admin = criarClienteAdmin();
  const { error: erroAuth } = await admin.auth.admin.updateUserById(userId, {
    user_metadata: { nome },
  });
  if (erroAuth) return { erro: `Não foi possível atualizar: ${erroAuth.message}` };

  const { error: erroLinha } = await supabase
    .from('usuarios_painel')
    .update({ nome })
    .eq('id', userId)
    .eq('tenant_id', tenantId);
  if (erroLinha) {
    return {
      sucesso: `Nome alterado no acesso, mas a projeção não sincronizou: ${erroLinha.message}`,
    };
  }

  revalidatePath(`/admin/tenants/${tenantId}`);
  return { sucesso: 'Nome atualizado.' };
}

/**
 * Gera um novo link para o admin (re)definir a senha. Só super admin.
 *
 * Útil quando o convidado perdeu o link, nunca definiu a senha, ou esqueceu.
 * Mesmo formato de link corrigido do convite: aponta para /auth/confirmar com
 * token_hash (fluxo do @supabase/ssr), não o action_link do GoTrue.
 */
export async function reenviarAcessoAdmin(_estado: EstadoAcao, fd: FormData): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tenantId = String(fd.get('tenant_id') ?? '');
  const userId = String(fd.get('user_id') ?? '');
  if (!tenantId || !userId) return { erro: 'Dados incompletos.' };

  const supabase = await criarClienteServidor();
  const alvo = await carregarAdminDoTenant(supabase, tenantId, userId);
  if (!alvo) return { erro: 'Admin não encontrado neste cliente.' };

  const admin = criarClienteAdmin();
  const { data: linkData, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: alvo.email,
  });
  if (error || !linkData) {
    return { erro: `Não foi possível gerar o link: ${error?.message ?? 'desconhecido'}` };
  }

  const origem = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const linkConvite =
    `${origem}/auth/confirmar` +
    `?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}` +
    `&type=recovery&proximo=${encodeURIComponent('/nova-senha')}`;

  return { sucesso: `Novo link de acesso gerado para ${alvo.email}.`, linkConvite };
}

/**
 * Conecta o tenant ao Chatwoot. Valida o token com chamada real antes de
 * salvar — restrição obrigatória da Fase 3. Só super admin.
 */
export async function conectarChatwoot(
  _estado: EstadoAcao,
  fd: FormData,
): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tenantId = String(fd.get('tenant_id') ?? '');
  const accountIdBruto = String(fd.get('chatwoot_account_id') ?? '').trim();
  let token = String(fd.get('chatwoot_token') ?? '').trim();
  const url = String(fd.get('chatwoot_url') ?? '').trim() || 'https://app.chatyou.chat';

  if (!tenantId) return { erro: 'Tenant não informado.' };

  const accountId = Number(accountIdBruto);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return { errosCampo: { chatwoot_account_id: 'account_id deve ser um número.' } };
  }

  const supabase = await criarClienteServidor();

  // Token em branco = "revalidar/ajustar sem redigitar": reaproveita o que já
  // está salvo — é o que o placeholder do formulário promete. Só exige digitar
  // quando ainda não há token guardado (primeira conexão).
  if (!token) {
    const { data: atual } = await supabase
      .from('tenants')
      .select('chatwoot_token')
      .eq('id', tenantId)
      .maybeSingle();
    token = atual?.chatwoot_token ?? '';
    if (!token) return { errosCampo: { chatwoot_token: 'Informe o token.' } };
  }

  // A validação vem ANTES do save. Sem 200 aqui, nada é gravado.
  const validacao = await validarCredencialChatwoot({ url, accountId, token });
  if (!validacao.ok) {
    return { erro: validacao.motivo };
  }

  const { error } = await supabase
    .from('tenants')
    .update({ chatwoot_account_id: accountId, chatwoot_token: token, chatwoot_url: url })
    .eq('id', tenantId);

  if (error) {
    if (error.code === '23505') {
      return {
        errosCampo: { chatwoot_account_id: 'Essa conta do Chatwoot já está ligada a outro cliente.' },
      };
    }
    return { erro: `Não foi possível salvar: ${error.message}` };
  }

  revalidatePath(`/admin/tenants/${tenantId}`);
  return {
    sucesso: validacao.nomeConta
      ? `Conectado à conta "${validacao.nomeConta}" do Chatwoot.`
      : 'Chatwoot conectado e token validado.',
  };
}

/** Suspende ou reativa o tenant. Só super admin. `ativo=false` para o agente. */
export async function alternarSuspensaoTenant(
  _estado: EstadoAcao,
  fd: FormData,
): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tenantId = String(fd.get('tenant_id') ?? '');
  const suspender = fd.get('suspender') === 'true';
  if (!tenantId) return { erro: 'Tenant não informado.' };

  const supabase = await criarClienteServidor();
  const { error } = await supabase
    .from('tenants')
    .update({ ativo: !suspender })
    .eq('id', tenantId);

  if (error) return { erro: `Não foi possível alterar: ${error.message}` };

  revalidatePath('/admin/tenants');
  revalidatePath(`/admin/tenants/${tenantId}`);
  return { sucesso: suspender ? 'Cliente suspenso.' : 'Cliente reativado.' };
}

/**
 * Exclui um cliente. Só super admin.
 *
 * Soft delete, nunca DELETE físico: grava `deletado_em` (regra do CLAUDE.md —
 * o n8n lê o mesmo banco, e a exclusão precisa ser recuperável e auditável). A
 * listagem e a tela de detalhe já filtram `deletado_em IS NULL`, então o cliente
 * some da interface, mas o dado fica. Restauração é feita por SQL sob demanda
 * (zerar `deletado_em`).
 *
 * Também põe `ativo=false`: cliente excluído não pode ter agente respondendo.
 *
 * Confirmação: o super admin precisa digitar o nome exato do cliente. A checagem
 * é contra o nome vindo do banco, não contra um valor do request — o formulário
 * não decide o que é o nome certo.
 */
export async function excluirTenant(
  _estado: EstadoAcao,
  fd: FormData,
): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tenantId = String(fd.get('tenant_id') ?? '');
  const confirmacao = String(fd.get('confirmacao') ?? '').trim();
  if (!tenantId) return { erro: 'Tenant não informado.' };

  const supabase = await criarClienteServidor();

  // Nome vem do banco (fonte da verdade da confirmação), e só entre os vivos.
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, nome')
    .eq('id', tenantId)
    .is('deletado_em', null)
    .maybeSingle();

  if (!tenant) return { erro: 'Cliente não encontrado ou já excluído.' };

  if (confirmacao !== tenant.nome.trim()) {
    return {
      errosCampo: {
        confirmacao: 'Digite o nome do cliente exatamente como aparece para confirmar.',
      },
    };
  }

  // Solta o chatwoot_account_id na exclusão: ele é UNIQUE e, se ficasse preso ao
  // tenant morto, aquela conta do Chatwoot não poderia ser religada a nenhum outro
  // cliente. chatwoot_url é NOT NULL, então não pode ir a null — só zeramos o que
  // trava a religação (account_id) e a credencial (token).
  const { error } = await supabase
    .from('tenants')
    .update({
      deletado_em: new Date().toISOString(),
      ativo: false,
      chatwoot_account_id: null,
      chatwoot_token: null,
    })
    .eq('id', tenantId)
    .is('deletado_em', null); // idempotente: não re-exclui

  if (error) return { erro: `Não foi possível excluir: ${error.message}` };

  revalidatePath('/admin/tenants');
  // A tela de detalhe filtra deletado_em IS NULL e daria 404; volta para a lista.
  redirect('/admin/tenants');
}

/**
 * Edição completa do tenant pelo super admin (modelo, temperatura, etc.).
 * O prompt é tratado à parte (versionamento), aqui vão os campos de config.
 */
export async function editarTenantSuper(
  _estado: EstadoAcao,
  fd: FormData,
): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tenantId = String(fd.get('tenant_id') ?? '');
  if (!tenantId) return { erro: 'Tenant não informado.' };

  const validado = validarConfigTenantSuper(fd);
  if (!validado.ok) return { errosCampo: validado.erros };

  const supabase = await criarClienteServidor();
  const { error } = await supabase
    .from('tenants')
    .update({
      nome: validado.valor.nome,
      modelo: validado.valor.modelo,
      temperatura: validado.valor.temperatura,
      debounce_segundos: validado.valor.debounce_segundos,
    })
    .eq('id', tenantId);

  if (error) return { erro: `Não foi possível salvar: ${error.message}` };

  revalidatePath(`/admin/tenants/${tenantId}`);
  return { sucesso: 'Configuração atualizada.' };
}

/**
 * Agência habilita/configura a INFRA da tool de transferência para humano:
 * workflow_id (o sub-workflow no n8n), descrição (o texto que ensina a IA quando
 * transferir) e a sessão do WAHA (por onde o aviso sai).
 *
 * Faz upsert em tenant_tools por (tenant_id, tool_nome). Preserva o que é do
 * cliente — horário, destino da notificação, canal e o próprio `ativo`: em
 * update, `ativo` não é tocado; ao criar a linha pela primeira vez ela nasce
 * DESLIGADA, para o cliente ligar depois de definir horário/destino. Só super
 * admin; o tenant vem do form (rota de agência), validado pelo gate no servidor.
 */
export async function salvarTransferirHumanoAgencia(
  _estado: EstadoAcao,
  fd: FormData,
): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tenantId = String(fd.get('tenant_id') ?? '');
  if (!tenantId) return { erro: 'Tenant não informado.' };

  const validado = validarTransferirAgencia(fd);
  if (!validado.ok) return { errosCampo: validado.erros };

  const supabase = await criarClienteServidor();

  const { data: linha, error: erroSel } = await supabase
    .from('tenant_tools')
    .select('ativo, config, workflow_id')
    .eq('tenant_id', tenantId)
    .eq('tool_nome', TOOL_TRANSFERIR)
    .maybeSingle();

  if (erroSel) return { erro: `Não foi possível carregar: ${erroSel.message}` };

  const atual = (linha?.config ?? {}) as Partial<ConfigTransferir>;
  // Sem sessão WAHA não há por onde o aviso sair. Se a agência limpar a sessão,
  // o canal cai para 'nenhum' — senão ficaria canal='waha' pendurado, o n8n
  // tentaria notificar sem sessão e falharia calado, e o cliente nem veria o
  // controle para corrigir (a tela dele esconde quando não há sessão). Espelha
  // o mesmo guard que o lado do cliente já aplica.
  const canal: 'waha' | 'nenhum' = validado.valor.sessao
    ? (atual.notificacao?.canal ?? 'nenhum')
    : 'nenhum';
  const config: ConfigTransferir = {
    horario: atual.horario ?? HORARIO_PADRAO,
    notificacao: {
      canal,
      ...(validado.valor.sessao ? { sessao: validado.valor.sessao } : {}),
      ...(atual.notificacao?.destino ? { destino: atual.notificacao.destino } : {}),
    },
  };

  const { error } = await supabase.from('tenant_tools').upsert(
    {
      tenant_id: tenantId,
      tool_nome: TOOL_TRANSFERIR,
      // workflow_id não é editável pelo painel (metadado, não liga nada).
      // Preserva o que estiver no banco; em linha nova fica null.
      workflow_id: linha?.workflow_id ?? null,
      descricao: validado.valor.descricao,
      config,
      ativo: linha ? linha.ativo : false,
    },
    { onConflict: 'tenant_id,tool_nome' },
  );

  if (error) return { erro: `Não foi possível salvar: ${error.message}` };

  revalidatePath(`/admin/tenants/${tenantId}`);
  return {
    sucesso: linha
      ? 'Tool de transferência atualizada.'
      : 'Tool de transferência habilitada (desligada — o cliente ativa no painel dele).',
  };
}
