'use server';

import { redirect } from 'next/navigation';

import { obterUsuarioReal } from './auth';
import { criarClienteServidor } from './supabase/server';
import { gravarPersonificacao, limparPersonificacao } from './personificacao';

/**
 * Entrar na conta de um cliente e sair dela.
 *
 * AS DUAS USAM `obterUsuarioReal`, NÃO `exigirSuperAdmin`. Dentro da conta o
 * papel efetivo é `tenant_admin`, então `exigirSuperAdmin` recusaria — e o
 * botão de sair, que é a única porta de volta, pararia de funcionar
 * justamente quando é necessário. Quem autoriza é o JWT por baixo, que não
 * mudou.
 */

export async function entrarNaConta(tenantId: string): Promise<void> {
  const real = await obterUsuarioReal();
  if (!real || real.papel !== 'super_admin') redirect('/painel');

  // O tenant é conferido ANTES de o cookie existir. Sem isto, um id errado
  // levaria a agência para um painel vazio, que parece defeito do painel.
  const supabase = await criarClienteServidor();
  const { data } = await supabase
    .from('tenants')
    .select('id, ativo, deletado_em')
    .eq('id', tenantId)
    .maybeSingle();

  if (!data || data.deletado_em !== null || data.ativo === false) {
    redirect('/admin/tenants');
  }

  await gravarPersonificacao(data.id as string);
  redirect('/painel');
}

export async function sairDaConta(): Promise<void> {
  const real = await obterUsuarioReal();
  // Limpa de qualquer jeito: um cookie órfão num usuário que não é super é
  // inerte, mas deixá-lo ali é sujeira que confunde quem for depurar.
  await limparPersonificacao();
  redirect(real?.papel === 'super_admin' ? '/admin/tenants' : '/painel');
}
