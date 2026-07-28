'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { exigirSuperAdmin } from '@/lib/auth';
import { validarCredencialChatwoot } from '@/lib/chatwoot';
import { criarClienteAdmin } from '@/lib/supabase/admin';
import { criarClienteServidor } from '@/lib/supabase/server';
import { validarCriacaoTenant } from '@/lib/tenants/schema';
import { criarUsuario, ehEmailDuplicado } from '@/lib/supabase/admin-usuarios';

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
  const token = String(fd.get('chatwoot_token') ?? '').trim();
  const url = String(fd.get('chatwoot_url') ?? '').trim() || 'https://app.chatyou.chat';

  if (!tenantId) return { erro: 'Tenant não informado.' };

  const accountId = Number(accountIdBruto);
  if (!Number.isInteger(accountId) || accountId < 1) {
    return { errosCampo: { chatwoot_account_id: 'account_id deve ser um número.' } };
  }
  if (!token) return { errosCampo: { chatwoot_token: 'Informe o token.' } };

  // A validação vem ANTES do save. Sem 200 aqui, nada é gravado.
  const validacao = await validarCredencialChatwoot({ url, accountId, token });
  if (!validacao.ok) {
    return { erro: validacao.motivo };
  }

  const supabase = await criarClienteServidor();
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

  const { error } = await supabase
    .from('tenants')
    .update({ deletado_em: new Date().toISOString(), ativo: false })
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

  const validado = validarCriacaoTenant(fd); // mesmos campos de config
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
