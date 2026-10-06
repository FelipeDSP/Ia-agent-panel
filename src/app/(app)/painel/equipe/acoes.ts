'use server';

/**
 * A equipe da conta, gerida pelo ADMIN DO CLIENTE.
 *
 * Até 06/10/2026 só a agência criava usuário: a policy de INSERT em
 * `usuarios_painel` era `auth_is_super_admin()` e a Server Action começava com
 * `exigirSuperAdmin()`. A 80 abriu para o admin do tenant, e a 81 pôs o teto
 * (`tenants.max_agentes`, que só a agência mexe).
 *
 * AS TRÊS PORTAS, de novo, porque é a regra de superfície do CLAUDE.md:
 *   1. o menu esconde "Equipe" de quem não é admin;
 *   2. a rota recusa (`exigirTenantAdmin` no layout);
 *   3. estas ações recusam por conta própria — Server Action é entrada
 *      própria, não passa por página nenhuma.
 * E abaixo das três está a RLS, que é quem nega de verdade.
 *
 * `tenant_id` vem SEMPRE do JWT (`exigirTenantAdmin`), nunca do formulário —
 * regra 1 do CLAUDE.md.
 */

import { revalidatePath } from 'next/cache';

import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteAdmin } from '@/lib/supabase/admin';
import { criarUsuario, ehEmailDuplicado } from '@/lib/supabase/admin-usuarios';
import { criarClienteServidor } from '@/lib/supabase/server';
import { CHAVES_CAPACIDADES } from '@/lib/usuarios/capacidades';

export type EstadoEquipe = {
  erro?: string;
  sucesso?: string;
  errosCampo?: Record<string, string>;
  linkConvite?: string;
};

/** Cria ou renomeia uma função, com as capacidades marcadas. */
export async function salvarFuncao(_estado: EstadoEquipe, fd: FormData): Promise<EstadoEquipe> {
  const usuario = await exigirTenantAdmin();

  const id = String(fd.get('funcao_id') ?? '').trim() || null;
  const nome = String(fd.get('nome') ?? '').trim();
  if (!nome) return { errosCampo: { nome: 'Dê um nome à função (ex.: Vendedor).' } };
  if (nome.length > 40) return { errosCampo: { nome: 'No máximo 40 caracteres.' } };

  // Só capacidade conhecida entra. O CHECK do banco recusa o resto de qualquer
  // forma (migração 80) — isto é para a mensagem ser legível em vez de 23514.
  const marcadas = fd.getAll('capacidades').map(String).filter((c) => CHAVES_CAPACIDADES.includes(c));

  const supabase = await criarClienteServidor();
  if (id) {
    const { error } = await supabase
      .from('tenant_funcoes')
      .update({ nome, capacidades: marcadas })
      .eq('id', id)
      .eq('tenant_id', usuario.tenantId); // RLS é a rede; o filtro é a 1ª linha (regra 6)
    if (error) return { erro: traduzir(error.message) };
  } else {
    const { error } = await supabase
      .from('tenant_funcoes')
      .insert({ tenant_id: usuario.tenantId, nome, capacidades: marcadas });
    if (error) return { erro: traduzir(error.message) };
  }

  revalidatePath('/painel/equipe');
  return { sucesso: id ? `Função "${nome}" atualizada.` : `Função "${nome}" criada.` };
}

/**
 * Apaga uma função. Quem a tinha fica SEM capacidade nenhuma, não é removido
 * da conta: `funcao_id` vira null pelo `on delete set null` da 80. Perder a
 * função é perder o que podia fazer — não é perder o acesso, que é decisão
 * separada e tem botão próprio.
 */
export async function excluirFuncao(_estado: EstadoEquipe, fd: FormData): Promise<EstadoEquipe> {
  const usuario = await exigirTenantAdmin();
  const id = String(fd.get('funcao_id') ?? '');
  if (!id) return { erro: 'Função não informada.' };

  const supabase = await criarClienteServidor();
  const { count } = await supabase
    .from('usuarios_painel')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', usuario.tenantId)
    .eq('funcao_id', id);

  const { error } = await supabase
    .from('tenant_funcoes')
    .delete()
    .eq('id', id)
    .eq('tenant_id', usuario.tenantId);
  if (error) return { erro: traduzir(error.message) };

  revalidatePath('/painel/equipe');
  return {
    sucesso: count
      ? `Função apagada. ${count} pessoa(s) ficaram sem permissões — dê outra função a elas.`
      : 'Função apagada.',
  };
}

/** Convida alguém para a equipe, já com uma função. */
export async function convidarAgente(_estado: EstadoEquipe, fd: FormData): Promise<EstadoEquipe> {
  const usuario = await exigirTenantAdmin();

  const email = String(fd.get('email') ?? '').trim().toLowerCase();
  const nome = String(fd.get('nome') ?? '').trim() || email;
  const funcaoId = String(fd.get('funcao_id') ?? '').trim() || null;
  if (!email.includes('@')) return { errosCampo: { email: 'Email inválido.' } };

  const supabase = await criarClienteServidor();
  if (funcaoId) {
    // A função tem de ser DESTE tenant. O trigger da 80 também recusa — aqui é
    // para a pessoa ler um motivo em vez de um 42501.
    const { data } = await supabase
      .from('tenant_funcoes')
      .select('id')
      .eq('id', funcaoId)
      .eq('tenant_id', usuario.tenantId)
      .maybeSingle();
    if (!data) return { errosCampo: { funcao_id: 'Função não encontrada nesta conta.' } };
  }

  const admin = criarClienteAdmin();
  const { data, error } = await criarUsuario(admin, {
    email,
    email_confirm: true,
    app_metadata: { papel: 'tenant_agente', tenant_id: usuario.tenantId },
    user_metadata: { nome },
  });

  // O teto é do BANCO (trigger da 81). Esta tradução existe porque a mensagem
  // crua sobe do Postgres pelo GoTrue e é ilegível para quem está na tela.
  if (error && /Limite de agentes/i.test(error.message)) {
    return { erro: 'Todos os acessos contratados estão em uso. Fale com a agência para liberar mais.' };
  }
  if (error && ehEmailDuplicado(error)) {
    return { errosCampo: { email: 'Já existe uma conta com esse email. Cada pessoa pertence a um cliente só.' } };
  }
  if (error) return { erro: `Não foi possível convidar: ${error.message}` };

  if (funcaoId) {
    // Erro aqui não desfaz o convite — a pessoa existe e entra, só sem função.
    // Dizer isso é melhor do que um "convite criado" que esconde metade.
    const { error: erroFuncao } = await supabase
      .from('usuarios_painel')
      .update({ funcao_id: funcaoId })
      .eq('id', data.user.id)
      .eq('tenant_id', usuario.tenantId);
    if (erroFuncao) {
      revalidatePath('/painel/equipe');
      return { erro: `Convite criado para ${email}, mas a função não foi aplicada: ${traduzir(erroFuncao.message)}` };
    }
  }

  const { data: link } = await admin.auth.admin.generateLink({ type: 'recovery', email });
  const origem = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const linkConvite = link?.properties?.hashed_token
    ? `${origem}/auth/confirmar?token_hash=${encodeURIComponent(link.properties.hashed_token)}` +
      `&type=recovery&proximo=${encodeURIComponent('/nova-senha')}`
    : undefined;

  revalidatePath('/painel/equipe');
  return { sucesso: `Convite criado para ${email}.`, linkConvite };
}

/** Troca a função de alguém da equipe. */
export async function definirFuncaoDoAgente(_estado: EstadoEquipe, fd: FormData): Promise<EstadoEquipe> {
  const usuario = await exigirTenantAdmin();
  const userId = String(fd.get('user_id') ?? '');
  const funcaoId = String(fd.get('funcao_id') ?? '').trim() || null;
  if (!userId) return { erro: 'Pessoa não informada.' };
  if (userId === usuario.id) return { erro: 'Você não muda a própria função.' };

  const supabase = await criarClienteServidor();
  const { error } = await supabase
    .from('usuarios_painel')
    .update({ funcao_id: funcaoId })
    .eq('id', userId)
    .eq('tenant_id', usuario.tenantId)
    .eq('papel', 'tenant_agente');
  if (error) return { erro: traduzir(error.message) };

  revalidatePath('/painel/equipe');
  return { sucesso: 'Função atualizada. Vale na próxima ação da pessoa.' };
}

/** Tira o acesso de alguém da equipe. */
export async function removerAgente(_estado: EstadoEquipe, fd: FormData): Promise<EstadoEquipe> {
  const usuario = await exigirTenantAdmin();
  const userId = String(fd.get('user_id') ?? '');
  if (!userId) return { erro: 'Pessoa não informada.' };
  if (userId === usuario.id) return { erro: 'Você não remove a si mesmo.' };

  const supabase = await criarClienteServidor();
  // Confere contra o BANCO que o alvo é agente DESTA conta: id forjado não
  // alcança o admin nem gente de outro tenant.
  const { data: alvo } = await supabase
    .from('usuarios_painel')
    .select('id, email, papel')
    .eq('id', userId)
    .eq('tenant_id', usuario.tenantId)
    .maybeSingle();
  if (!alvo || alvo.papel !== 'tenant_agente') return { erro: 'Pessoa não encontrada na sua equipe.' };

  // Revogar de verdade é apagar no Auth (mata a sessão e impede login) E tirar
  // a linha. Uma não cascateia na outra — mesma nota de `removerAdmin`.
  const admin = criarClienteAdmin();
  const { error: erroAuth } = await admin.auth.admin.deleteUser(userId);
  if (erroAuth) return { erro: `Não foi possível revogar o acesso: ${erroAuth.message}` };

  const { error: erroLinha } = await supabase
    .from('usuarios_painel')
    .delete()
    .eq('id', userId)
    .eq('tenant_id', usuario.tenantId);

  revalidatePath('/painel/equipe');
  if (erroLinha) {
    // O acesso JÁ foi revogado no Auth (a sessão morreu e o login não entra
    // mais); a linha órfã não autoriza nada sozinha. Mas avisar é melhor do
    // que devolver um sucesso limpo que não foi limpo.
    return { sucesso: `Acesso de ${alvo.email} revogado, mas a linha não saiu da lista: ${erroLinha.message}` };
  }
  return { sucesso: `${alvo.email} não tem mais acesso.` };
}

/** Gera um link para a pessoa (re)definir a senha. Ninguém digita senha por ninguém. */
export async function reenviarAcessoAgente(_estado: EstadoEquipe, fd: FormData): Promise<EstadoEquipe> {
  const usuario = await exigirTenantAdmin();
  const userId = String(fd.get('user_id') ?? '');
  if (!userId) return { erro: 'Pessoa não informada.' };

  const supabase = await criarClienteServidor();
  const { data: alvo } = await supabase
    .from('usuarios_painel')
    .select('id, email, papel')
    .eq('id', userId)
    .eq('tenant_id', usuario.tenantId)
    .maybeSingle();
  if (!alvo || alvo.papel !== 'tenant_agente') return { erro: 'Pessoa não encontrada na sua equipe.' };

  const admin = criarClienteAdmin();
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'recovery', email: alvo.email });
  if (error || !link?.properties?.hashed_token) {
    return { erro: `Não foi possível gerar o link: ${error?.message ?? 'desconhecido'}` };
  }
  const origem = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  return {
    sucesso: `Link de acesso gerado para ${alvo.email}.`,
    linkConvite:
      `${origem}/auth/confirmar?token_hash=${encodeURIComponent(link.properties.hashed_token)}` +
      `&type=recovery&proximo=${encodeURIComponent('/nova-senha')}`,
  };
}

/** Erros do Postgres que a pessoa na tela não tem como entender crus. */
function traduzir(msg: string): string {
  if (/uq_tenant_funcoes_nome/.test(msg)) return 'Já existe uma função com esse nome.';
  if (/ck_tenant_funcoes_capacidades/.test(msg)) return 'Permissão desconhecida — recarregue a página.';
  if (/ck_tenant_funcoes_nome/.test(msg)) return 'Dê um nome à função.';
  if (/nao pertence ao tenant/.test(msg)) return 'Essa função não é desta conta.';
  return msg;
}
