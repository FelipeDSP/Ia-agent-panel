import 'server-only';

import { notFound, redirect } from 'next/navigation';

import { criarClienteServidor } from './supabase/server';
import { lerPersonificacao } from './personificacao';
import { CHAVES_CAPACIDADES, podeTudo, type Capacidade } from './usuarios/capacidades';

export type Papel = 'super_admin' | 'tenant_admin' | 'tenant_agente';

export type UsuarioAtual = {
  id: string;
  email: string;
  nome: string;
  papel: Papel;
  /** NULL para super_admin: ele nao pertence a tenant nenhum. */
  tenantId: string | null;
  /**
   * Preenchido SO quando um super_admin esta dentro da conta de um cliente.
   * Quem le isto esta vendo a verdade por tras do papel efetivo: `papel` diz
   * `tenant_admin` para o painel funcionar, e este campo diz quem de fato esta
   * ali. Ver `src/lib/personificacao.ts`.
   */
  personificando?: { tenantId: string; nome: string } | undefined;
};

/**
 * Usuario logado, com papel e tenant vindos do app_metadata do JWT.
 *
 * Regra do CLAUDE.md, e o ponto que sustenta o multi-tenancy inteiro: papel e
 * tenant_id saem SEMPRE daqui. Nunca de body, query string, header ou de uma
 * leitura em usuarios_painel. Essa tabela e projecao do app_metadata, nao
 * fonte da verdade — se as duas divergirem, quem autoriza e o JWT, porque e
 * ele que as policies do Postgres leem.
 *
 * user_metadata seria o campo errado: o proprio usuario pode edita-lo.
 */
export async function obterUsuarioAtual(): Promise<UsuarioAtual | null> {
  const supabase = await criarClienteServidor();

  // getUser() revalida o token no servidor de auth. getSession() so decodifica
  // o cookie e aceitaria um forjado.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  const meta = user.app_metadata as Record<string, unknown>;
  const papel = meta['papel'];
  const tenantId = meta['tenant_id'];

  // Papel invalido e tratado como nao autenticado. Acontece se alguem for
  // criado por fora do fluxo previsto — melhor negar do que assumir um padrao.
  if (papel !== 'super_admin' && papel !== 'tenant_admin' && papel !== 'tenant_agente') return null;

  // tenant_admin sem tenant nao consegue ver nada mesmo: as policies comparam
  // com NULL e nao casam. Negar aqui torna a falha legivel.
  if ((papel === 'tenant_admin' || papel === 'tenant_agente') && typeof tenantId !== 'string') return null;

  // Tenant excluido (soft delete) ou pausado nao deve mais dar acesso ao admin
  // dele. O soft delete mantem a linha e o JWT continua valido, entao sem esta
  // checagem o admin de um cliente "excluido" seguiria logando e vendo os dados.
  // Fail-closed: se a linha nao vier (RLS esconde deletado) ou vier morta/inativa,
  // nega. super_admin nao tem tenant e pula. A checagem que vale fica junto do dado.
  if (papel === 'tenant_admin' || papel === 'tenant_agente') {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('deletado_em, ativo')
      .eq('id', tenantId as string)
      .maybeSingle();

    if (!tenant || tenant.deletado_em !== null || tenant.ativo === false) return null;
  }

  const nomeMeta = (user.user_metadata as Record<string, unknown>)['nome'];

  const base: UsuarioAtual = {
    id: user.id,
    email: user.email ?? '',
    nome: typeof nomeMeta === 'string' && nomeMeta ? nomeMeta : (user.email ?? ''),
    papel,
    tenantId: typeof tenantId === 'string' ? tenantId : null,
  };

  /*
   * PERSONIFICACAO: so depois de o JWT ter dito `super_admin`.
   *
   * A ordem importa e e a unica coisa que sustenta isto: o cookie nunca e lido
   * antes do papel. Para tenant_admin e tenant_agente ele e inerte, e mesmo que
   * fosse lido a RLS recusaria o tenant alheio — o JWT deles nao casa.
   *
   * O tenant personificado e CONFERIDO no banco: nao-existente, soft-deletado
   * ou inativo derruba a personificacao em vez de virar um filtro que nao casa
   * com nada (que apareceria como "o painel do cliente ficou vazio").
   */
  if (papel !== 'super_admin') return base;

  const alvo = await lerPersonificacao();
  if (!alvo) return base;

  const { data: cliente } = await supabase
    .from('tenants')
    .select('id, nome, deletado_em, ativo')
    .eq('id', alvo)
    .maybeSingle();

  if (!cliente || cliente.deletado_em !== null || cliente.ativo === false) return base;

  return {
    ...base,
    // O papel EFETIVO e o do dono da conta: e o que faz `exigirTenantAdmin` e
    // `exigirMembro` do painel inteiro funcionarem sem excecao espalhada.
    papel: 'tenant_admin',
    tenantId: cliente.id as string,
    personificando: { tenantId: cliente.id as string, nome: (cliente.nome as string) ?? '(sem nome)' },
  };
}

/**
 * A identidade REAL, atravessando a personificacao.
 *
 * Existe para duas coisas e so para elas: o botao de sair da conta (que precisa
 * saber que quem esta ali e super_admin, senao a agencia entra e nao volta) e
 * qualquer rastro que queira registrar quem de fato agiu.
 */
export async function obterUsuarioReal(): Promise<UsuarioAtual | null> {
  const u = await obterUsuarioAtual();
  if (!u) return null;
  if (!u.personificando) return u;
  return { ...u, papel: 'super_admin', tenantId: null, personificando: undefined };
}

/** Exige sessao valida. Redireciona para /login se nao houver. */
export async function exigirUsuario(): Promise<UsuarioAtual> {
  const usuario = await obterUsuarioAtual();
  if (!usuario) redirect('/login');
  return usuario;
}

/**
 * Exige super_admin.
 *
 * Repetida no Server Component mesmo com o middleware ja filtrando: middleware
 * nao e fronteira de seguranca. Ele nao roda em Server Action invocada
 * diretamente, e o matcher pode ser contornado. A checagem que vale e a que
 * fica junto do acesso ao dado.
 */
export async function exigirSuperAdmin(): Promise<UsuarioAtual> {
  const usuario = await exigirUsuario();
  if (usuario.papel !== 'super_admin') redirect('/painel');
  return usuario;
}

/**
 * Exige tenant_admin com tenant definido, devolvendo o tenantId ja estreitado
 * para string — evita `!` espalhado pelas paginas.
 */
export async function exigirTenantAdmin(): Promise<UsuarioAtual & { tenantId: string }> {
  const usuario = await exigirUsuario();
  // Para onde mandar quem nao e admin: super_admin vai ao painel dele; AGENTE
  // vai para a Visao geral. Mandar o agente a /admin/tenants faria laco — de
  // la ele seria devolvido para /painel, e de volta para ca.
  if (usuario.papel === 'tenant_agente') redirect('/painel');
  if (usuario.papel !== 'tenant_admin' || !usuario.tenantId) redirect('/admin/tenants');
  return { ...usuario, tenantId: usuario.tenantId };
}

/**
 * O que ESTE usuario pode, lido do banco.
 *
 * A fonte e `auth_capacidades()` (migracao 80), a MESMA funcao que a RLS
 * consulta. Nao ha uma copia da regra aqui: a tela pergunta ao banco o que o
 * banco vai responder quando ela escrever. Par derivado com uma fonte so.
 *
 * FALHA FECHA: erro na chamada devolve conjunto VAZIO. Para um agente isso
 * esconde tudo o que e condicional — sintoma que ele relata na hora; o
 * contrario mostraria um botao que a policy recusa. E a mesma escolha ja
 * escrita em `toolsContratadas`.
 *
 * O admin nao paga esta consulta: `podeTudo` responde sem ir ao banco.
 */
export async function capacidadesDoUsuario(usuario: UsuarioAtual): Promise<Set<string>> {
  if (podeTudo(usuario.papel)) return new Set(CHAVES_CAPACIDADES);
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('auth_capacidades');
  if (error || !Array.isArray(data)) return new Set();
  return new Set(data as string[]);
}

/**
 * Guard de pagina para MEMBRO da conta: admin entra sempre; agente entra se
 * tiver a capacidade.
 *
 * `notFound()` e nao redirect, pelo mesmo motivo de `exigirToolDaRota`: a tela
 * nao existe para esta pessoa, e um redirect com aviso revelaria que ela
 * existe para outras.
 *
 * ISTO NAO SUBSTITUI A RLS. E a camada de tela; quem nega de verdade e a
 * policy e, nas SECURITY DEFINER, a checagem por dentro. Sao as tres entradas
 * da nota de superficie de tool do CLAUDE.md — menu, rota e Server Action —
 * com a mesma verdade.
 */
export async function exigirMembro(
  capacidade?: Capacidade,
): Promise<UsuarioAtual & { tenantId: string }> {
  const usuario = await exigirUsuario();
  if (usuario.papel === 'super_admin') redirect('/admin/tenants');
  if (!usuario.tenantId) redirect('/login');
  if (capacidade && !podeTudo(usuario.papel)) {
    const caps = await capacidadesDoUsuario(usuario);
    if (!caps.has(capacidade)) notFound();
  }
  return { ...usuario, tenantId: usuario.tenantId };
}

/** Versao para Server Action: devolve `false` em vez de interromper a pagina. */
export async function membroPode(usuario: UsuarioAtual, capacidade: Capacidade): Promise<boolean> {
  if (podeTudo(usuario.papel)) return true;
  return (await capacidadesDoUsuario(usuario)).has(capacidade);
}

/** Mensagem unica de recusa por capacidade, para as Server Actions. */
export const ERRO_SEM_CAPACIDADE =
  'Voce nao tem permissao para isso. Fale com o administrador da conta.';
