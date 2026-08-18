'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { exigirSuperAdmin } from '@/lib/auth';
import { validarCredencialChatwoot } from '@/lib/chatwoot';
import { criarClienteAdmin } from '@/lib/supabase/admin';
import { criarClienteServidor } from '@/lib/supabase/server';
import { validarConfigTenantSuper, validarCriacaoTenant } from '@/lib/tenants/schema';
import { criarUsuario, ehEmailDuplicado } from '@/lib/supabase/admin-usuarios';
import { TOOLS_BASELINE } from '@/lib/tools/registro';
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

  // Baseline do produto: as três tools entram contratadas e LIGADAS, sem clique.
  // Antes eram três contratações manuais por cliente novo, e esquecer
  // `busca_conhecimento` deixava o agente respondendo sem base de conhecimento —
  // falha cara e silenciosa. `config` vazio: o default do horário mora no
  // sub-workflow, e a agência preenche a sessão do WAHA quando houver.
  const { error: erroTools } = await supabase.from('tenant_tools').insert(
    TOOLS_BASELINE.map((tool_nome) => ({
      tenant_id: data.id,
      tool_nome,
      contratado: true,
      ativo: true,
      config: {},
    })),
  );

  revalidatePath('/admin/tenants');

  // O tenant existe mesmo se o provisionamento falhar — não dá para desfazer a
  // criação aqui sem transação. Falha visível é melhor que cliente novo com
  // agente mudo e ninguém sabendo por quê.
  if (erroTools) {
    return {
      sucesso:
        `Cliente "${validado.valor.slug}" criado, mas os módulos padrão NÃO foram ` +
        `provisionados (${erroTools.message}). Contrate-os na aba Módulos do cliente.`,
    };
  }

  return {
    sucesso: `Cliente "${validado.valor.slug}" criado com os módulos padrão ligados.`,
  };
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
  // Token de Agent Bot: não passa pela validação da API de conta (dá 401 mesmo
  // válido). Marcado aqui, a validação aceita o 401 em vez de reprovar.
  const ehBot = fd.get('token_bot') === 'on' || fd.get('token_bot') === 'true';

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
    // Credencial vive em tenant_credenciais (segregada de tenants para o token
    // nao vazar ao tenant_admin via RLS de linha — ver migracao 21a).
    const { data: atual } = await supabase
      .from('tenant_credenciais')
      .select('chatwoot_token')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    token = atual?.chatwoot_token ?? '';
    if (!token) return { errosCampo: { chatwoot_token: 'Informe o token.' } };
  }

  // A validação vem ANTES do save. Sem 200 aqui, nada é gravado (salvo token de
  // bot, que a validação aceita sem confirmar — ver validarCredencialChatwoot).
  const validacao = await validarCredencialChatwoot({ url, accountId, token, ehBot });
  if (!validacao.ok) {
    return { erro: validacao.motivo };
  }

  // account_id/url (nao-sensiveis) ficam em tenants; o token vai para a tabela
  // segregada (migracao 21a). Grava a conta primeiro para o UNIQUE de account_id
  // reprovar antes de tocar na credencial.
  const { error } = await supabase
    .from('tenants')
    .update({ chatwoot_account_id: accountId, chatwoot_url: url })
    .eq('id', tenantId);

  if (error) {
    if (error.code === '23505') {
      return {
        errosCampo: { chatwoot_account_id: 'Essa conta do Chatwoot já está ligada a outro cliente.' },
      };
    }
    return { erro: `Não foi possível salvar: ${error.message}` };
  }

  const { error: erroToken } = await supabase
    .from('tenant_credenciais')
    .upsert({
      tenant_id: tenantId,
      chatwoot_token: token,
      atualizado_em: new Date().toISOString(),
    });

  if (erroToken) {
    return { erro: `Conta salva, mas o token não foi gravado: ${erroToken.message}` };
  }

  revalidatePath(`/admin/tenants/${tenantId}`);
  if (!validacao.validado) {
    return {
      sucesso:
        'Chatwoot conectado. Token de Agent Bot salvo sem validação automática ' +
        '(a API de conta não valida token de bot) — confirme enviando uma mensagem de teste.',
    };
  }
  return {
    sucesso: validacao.nomeConta
      ? `Conectado à conta "${validacao.nomeConta}" do Chatwoot.`
      : 'Chatwoot conectado e token validado.',
  };
}

/**
 * Desconecta o Chatwoot: libera a conta para outro tenant.
 *
 * POR QUE EXISTE. O painel conectava e não desconectava. Mover a conta 1 do
 * `restaurante-teste` para o `emporio` exigiu SQL na mão. Trocar conta entre
 * tenants é operação normal em teste, e com clientes entrando vai se repetir.
 *
 * O QUE SAI E O QUE FICA — as três decisões, e nenhuma é acidente:
 *
 *  - **zera `chatwoot_account_id`**, e é só isso que o `UNIQUE` da coluna
 *    precisa para a conta ficar livre;
 *  - **`chatwoot_url` FICA.** É a instância (`app.chatyou.chat`), não a conta.
 *    Trocar de conta não muda de instância, e apagar obrigaria a redigitar;
 *  - **o token FICA em `tenant_credenciais`.** Reconectar o mesmo tenant não
 *    exige gerar token novo no Chatwoot. Foi o que se fez no SQL de ontem e
 *    funcionou; o `restaurante-teste` está exatamente nesse estado.
 *
 * O guard `trg_tenants_guard_colunas` dispara neste UPDATE porque
 * `chatwoot_account_id` é coluna de agência. Roda com a sessão do usuário, e
 * `exigirSuperAdmin` garante o papel — é o mesmo caminho que `conectarChatwoot`
 * já usa para gravar a MESMA coluna, então o contexto que o guard exige já está
 * provado em produção.
 */
export async function desconectarChatwoot(
  _estado: EstadoAcao,
  fd: FormData,
): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tenantId = String(fd.get('tenant_id') ?? '');
  if (!tenantId) return { erro: 'Tenant não informado.' };

  const supabase = await criarClienteServidor();

  // Lê antes para (a) dizer QUAL conta foi liberada e (b) não devolver
  // "desconectado" para quem já estava — sucesso que não mudou nada ensina a
  // confiar na mensagem errada.
  const { data: antes, error: erroLeitura } = await supabase
    .from('tenants')
    .select('chatwoot_account_id')
    .eq('id', tenantId)
    .maybeSingle();

  if (erroLeitura) return { erro: `Não foi possível ler o cliente: ${erroLeitura.message}` };
  if (!antes) return { erro: 'Cliente não encontrado.' };
  if (antes.chatwoot_account_id == null) {
    return { erro: 'Este cliente já está sem conta do Chatwoot conectada.' };
  }

  const { error } = await supabase
    .from('tenants')
    .update({ chatwoot_account_id: null })
    .eq('id', tenantId);

  if (error) return { erro: `Não foi possível desconectar: ${error.message}` };

  revalidatePath(`/admin/tenants/${tenantId}`);
  return {
    sucesso:
      `Conta ${antes.chatwoot_account_id} do Chatwoot liberada — já pode ser ligada a outro ` +
      'cliente. O token continua guardado, então reconectar este aqui não exige gerar outro.',
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
    })
    .eq('id', tenantId)
    .is('deletado_em', null); // idempotente: não re-exclui

  if (error) return { erro: `Não foi possível excluir: ${error.message}` };

  // A credencial vive em tabela separada (migracao 21a): limpa junto.
  await supabase.from('tenant_credenciais').delete().eq('tenant_id', tenantId);

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

/**
 * Contrata / descontrata um módulo (tool) para um tenant — a decisão comercial
 * da §4.2. Só super admin (a §4.1 impede o cliente de fazer isto pela API).
 *
 * Contratar cria a linha em tenant_tools com contratado=true e JÁ LIGADA
 * (ativo=true). As três tools do produto são baseline: o cliente desliga o que
 * não quiser no switch de "Meus módulos" (opt-out), em vez de precisar ligar uma
 * a uma. Enquanto isto inseria ativo=false, todo módulo contratado por aqui
 * nascia preso em desligado — o card do cliente nem tinha switch, e só
 * transferir_humano escapava porque o formulário dele gravava `ativo`.
 *
 * Se a linha já existe (ex.: a infra de transferir_humano já a criou), só
 * alterna `contratado`, preservando config e ativo — recontratar não repõe o
 * que o cliente desligou de propósito. Descontratar mantém a linha (config
 * intacto), então recontratar restaura o que o cliente tinha.
 *
 * tenant_id e tool_nome vêm do form da rota de agência; o gate no servidor
 * (exigirSuperAdmin) e a policy p_tools_insert (só super) são as garantias. O
 * FK tenant_tools.tool_nome -> catalogo_tools recusa tool fora do catálogo.
 */
export async function definirContratacao(
  _estado: EstadoAcao,
  fd: FormData,
): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tenantId = String(fd.get('tenant_id') ?? '');
  const toolNome = String(fd.get('tool_nome') ?? '');
  const contratar = fd.get('contratar') === 'true';
  if (!tenantId || !toolNome) return { erro: 'Dados incompletos.' };

  const supabase = await criarClienteServidor();

  const { data: existente, error: erroSel } = await supabase
    .from('tenant_tools')
    .select('id, ativo')
    .eq('tenant_id', tenantId)
    .eq('tool_nome', toolNome)
    .maybeSingle();
  if (erroSel) return { erro: `Não foi possível carregar: ${erroSel.message}` };

  if (existente) {
    const { error } = await supabase
      .from('tenant_tools')
      .update({ contratado: contratar })
      .eq('tenant_id', tenantId)
      .eq('tool_nome', toolNome);
    if (error) return { erro: `Não foi possível atualizar: ${error.message}` };
  } else {
    // Descontratar algo que nem existe: nada a fazer.
    if (!contratar) return { sucesso: 'Módulo já não estava contratado.' };
    const { error } = await supabase.from('tenant_tools').insert({
      tenant_id: tenantId,
      tool_nome: toolNome,
      contratado: true,
      ativo: true,
      config: {},
    });
    if (error) return { erro: `Não foi possível contratar: ${error.message}` };
  }

  revalidatePath(`/admin/tenants/${tenantId}`);
  return {
    sucesso: contratar
      ? 'Módulo contratado e ligado. O cliente ajusta ou desliga no painel dele.'
      : 'Módulo descontratado. A configuração fica guardada caso recontrate.',
  };
}

// --- Catálogo global de tools (§4.3 / §5.2) ---------------------------------

// tool_nome é chave estável usada pelo n8n e pela FK de tenant_tools: slug
// minúsculo, sem espaço. Imutável depois de criado (é a PK).
const RE_TOOL_NOME = /^[a-z][a-z0-9_]{1,60}$/;

/** Valida e normaliza o schema_config (JSON de objeto). Vazio => {}. */
function parseSchemaConfig(bruto: string): { ok: true; valor: Record<string, unknown> } | { ok: false; erro: string } {
  const t = bruto.trim();
  if (!t) return { ok: true, valor: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { ok: false, erro: 'schema_config precisa ser JSON válido.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, erro: 'schema_config precisa ser um objeto JSON.' };
  }
  return { ok: true, valor: parsed as Record<string, unknown> };
}

/**
 * Cria uma tool no catálogo global. Só super admin (policy p_catalogo_all).
 * Provisionar uma capacidade nova para o produto = uma linha aqui + um
 * sub-workflow no n8n; depois é só contratar por cliente.
 */
export async function criarToolCatalogo(
  _estado: EstadoAcao,
  fd: FormData,
): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tool_nome = String(fd.get('tool_nome') ?? '').trim();
  const nome_exibicao = String(fd.get('nome_exibicao') ?? '').trim();
  const descricao_padrao = String(fd.get('descricao_padrao') ?? '').trim();
  const workflow_id_padrao = String(fd.get('workflow_id_padrao') ?? '').trim();
  const schema = parseSchemaConfig(String(fd.get('schema_config') ?? ''));

  const errosCampo: Record<string, string> = {};
  if (!RE_TOOL_NOME.test(tool_nome)) {
    errosCampo['tool_nome'] = 'Use minúsculas, números e _ (ex.: agendar_horario). Começa com letra.';
  }
  if (!nome_exibicao) errosCampo['nome_exibicao'] = 'Dê um nome de exibição.';
  if (!schema.ok) errosCampo['schema_config'] = schema.erro;
  if (Object.keys(errosCampo).length > 0) return { errosCampo };

  const supabase = await criarClienteServidor();
  const { error } = await supabase.from('catalogo_tools').insert({
    tool_nome,
    nome_exibicao,
    descricao_padrao: descricao_padrao || null,
    workflow_id_padrao: workflow_id_padrao || null,
    schema_config: (schema as { valor: Record<string, unknown> }).valor,
    ativo: fd.get('ativo') === 'on' || fd.get('ativo') === 'true',
  });

  if (error) {
    if (error.code === '23505') return { errosCampo: { tool_nome: 'Já existe uma tool com esse nome.' } };
    return { erro: `Não foi possível criar: ${error.message}` };
  }

  revalidatePath('/admin/catalogo');
  return { sucesso: `Tool "${tool_nome}" criada no catálogo.` };
}

/**
 * Edita uma tool do catálogo (tudo menos o tool_nome, que é a PK/chave do n8n).
 * Só super admin.
 */
export async function editarToolCatalogo(
  _estado: EstadoAcao,
  fd: FormData,
): Promise<EstadoAcao> {
  await exigirSuperAdmin();

  const tool_nome = String(fd.get('tool_nome') ?? '').trim();
  if (!tool_nome) return { erro: 'Tool não informada.' };

  const nome_exibicao = String(fd.get('nome_exibicao') ?? '').trim();
  const descricao_padrao = String(fd.get('descricao_padrao') ?? '').trim();
  const workflow_id_padrao = String(fd.get('workflow_id_padrao') ?? '').trim();
  const schema = parseSchemaConfig(String(fd.get('schema_config') ?? ''));

  const errosCampo: Record<string, string> = {};
  if (!nome_exibicao) errosCampo['nome_exibicao'] = 'Dê um nome de exibição.';
  if (!schema.ok) errosCampo['schema_config'] = schema.erro;
  if (Object.keys(errosCampo).length > 0) return { errosCampo };

  const supabase = await criarClienteServidor();
  const { error } = await supabase
    .from('catalogo_tools')
    .update({
      nome_exibicao,
      descricao_padrao: descricao_padrao || null,
      workflow_id_padrao: workflow_id_padrao || null,
      schema_config: (schema as { valor: Record<string, unknown> }).valor,
      ativo: fd.get('ativo') === 'on' || fd.get('ativo') === 'true',
    })
    .eq('tool_nome', tool_nome);

  if (error) return { erro: `Não foi possível salvar: ${error.message}` };

  revalidatePath('/admin/catalogo');
  return { sucesso: 'Tool atualizada.' };
}
