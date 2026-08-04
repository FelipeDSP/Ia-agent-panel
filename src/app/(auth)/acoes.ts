'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { obterUsuarioAtual } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

export type EstadoFormulario = {
  erro?: string;
  sucesso?: string;
};

/**
 * Destino pos-login pelo papel. Nao aceita destino arbitrario da query string
 * sem validar: `proximo` vem do browser e um valor como
 * `https://sitedeoutro/` viraria open redirect.
 *
 * So aceita caminho interno. Rejeita nao so `//host` (protocol-relative) como
 * `/\host`: o browser normaliza `\` para `/` antes de resolver a URL, entao
 * `/\evil.com` viraria `//evil.com` -> host externo. A regex barra qualquer
 * segundo caractere `/` ou `\`.
 */
function destinoSeguro(proximo: string | null, papel: string): string {
  if (proximo && proximo.startsWith('/') && !/^\/[/\\]/.test(proximo)) {
    return proximo;
  }
  return papel === 'super_admin' ? '/admin/tenants' : '/painel';
}

export async function entrar(
  _estado: EstadoFormulario,
  dados: FormData,
): Promise<EstadoFormulario> {
  const email = String(dados.get('email') ?? '').trim();
  const senha = String(dados.get('senha') ?? '');
  const proximo = dados.get('proximo') ? String(dados.get('proximo')) : null;

  if (!email || !senha) {
    return { erro: 'Informe email e senha.' };
  }

  const supabase = await criarClienteServidor();
  const { error } = await supabase.auth.signInWithPassword({ email, password: senha });

  if (error) {
    /*
     * Mensagem generica de proposito. Distinguir "email nao existe" de "senha
     * errada" entrega ao atacante quais emails tem conta no painel.
     */
    return { erro: 'Email ou senha incorretos.' };
  }

  const usuario = await obterUsuarioAtual();

  if (!usuario) {
    // Autenticou no GoTrue mas o app_metadata nao tem papel valido. Encerra a
    // sessao: entrar sem papel deixaria o usuario num limbo sem permissao.
    await supabase.auth.signOut();
    return {
      erro: 'Conta sem papel definido. Fale com o administrador.',
    };
  }

  revalidatePath('/', 'layout');
  redirect(destinoSeguro(proximo, usuario.papel));
}

export async function sair(): Promise<void> {
  const supabase = await criarClienteServidor();
  await supabase.auth.signOut();
  revalidatePath('/', 'layout');
  redirect('/login');
}

export async function pedirRecuperacao(
  _estado: EstadoFormulario,
  dados: FormData,
): Promise<EstadoFormulario> {
  const email = String(dados.get('email') ?? '').trim();

  if (!email) return { erro: 'Informe o email.' };

  const supabase = await criarClienteServidor();
  const origem = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origem}/auth/confirmar?proximo=/nova-senha`,
  });

  /*
   * Resposta identica exista ou nao o email — senao a tela vira um oraculo
   * para descobrir quem tem conta. O erro real, se houver, fica no log do
   * Supabase.
   */
  return {
    sucesso: 'Se houver conta com esse email, o link de recuperação foi enviado.',
  };
}

export async function definirNovaSenha(
  _estado: EstadoFormulario,
  dados: FormData,
): Promise<EstadoFormulario> {
  const senha = String(dados.get('senha') ?? '');
  const confirmacao = String(dados.get('confirmacao') ?? '');

  if (senha.length < 8) {
    return { erro: 'A senha precisa ter ao menos 8 caracteres.' };
  }
  if (senha !== confirmacao) {
    return { erro: 'As senhas não conferem.' };
  }

  const supabase = await criarClienteServidor();

  // Exige sessao ativa — a do link de recuperacao, trocada em /auth/confirmar.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { erro: 'Link expirado. Peça a recuperação de novo.' };
  }

  const { error } = await supabase.auth.updateUser({ password: senha });

  if (error) {
    return { erro: 'Não foi possível alterar a senha. Tente de novo.' };
  }

  revalidatePath('/', 'layout');
  redirect('/');
}
