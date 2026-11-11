import 'server-only';

import { cookies } from 'next/headers';

/**
 * ENTRAR NA CONTA DE UM CLIENTE ("personificar").
 *
 * A agência precisa arrumar coisas PARA o cliente — prompt, horário, catálogo,
 * base. Até aqui isso era feito duplicando telas dentro de `/admin`: uma cópia
 * do editor de prompt que envelhece separada da original, e que só cobre o que
 * alguém lembrou de duplicar. Entrar na conta cobre tudo, para sempre, sem
 * segunda tela para manter.
 *
 * ========================= POR QUE ISTO É SEGURO =========================
 *
 * O cookie NÃO CONCEDE NADA. Ele ESTREITA.
 *
 * Toda policy de escrita deste banco tem a forma
 * `auth_is_super_admin() OR (tenant_id = auth_tenant_id())`, então o JWT de um
 * super_admin já alcança todos os clientes — é assim desde o começo e é o que
 * faz a tela da agência funcionar. O que este cookie faz é dizer ao PAINEL
 * qual tenant usar nos filtros explícitos (regra 6 do CLAUDE.md).
 *
 * Consequências, e vale escrevê-las porque é fácil ler isto ao contrário:
 *
 *  - para quem NÃO é super_admin o cookie é inerte. `obterUsuarioAtual` só o
 *    lê depois de confirmar o papel no JWT, e, se alguém forjar o cookie, a
 *    RLS recusa do mesmo jeito: o JWT dele não casa com o tenant alheio;
 *  - não há JWT novo, nem sessão emitida em nome do cliente. O banco continua
 *    vendo a agência, que é a verdade: quem editou foi a agência, e o rastro
 *    tem de dizer isso. Entrar "como o cliente" de verdade — logando na conta
 *    dele — apagaria essa distinção;
 *  - nada aqui é migração. RLS, triggers e grants ficam exatamente como estão.
 *
 * O PAPEL EFETIVO VIRA `tenant_admin` enquanto dura. Não é maquiagem: é o que
 * faz as ~40 chamadas de `exigirTenantAdmin`/`exigirMembro` do painel
 * funcionarem sem exceção espalhada por elas. A identidade real continua
 * disponível em `obterUsuarioReal()`, e é ela que o botão de sair usa — senão
 * a agência entraria e não teria como voltar.
 */

/** O nome é explícito de propósito: quem abrir o DevTools entende o que é. */
export const COOKIE_PERSONIFICACAO = 'personificando_tenant';

/**
 * Sessão do navegador, não persistente: fechar o navegador desfaz. Entrar na
 * conta de um cliente é um ato pontual ("vou arrumar o prompt do Evandro"),
 * não um estado em que se vive — e a agência esquecer que está lá dentro é o
 * modo de falha principal desta funcionalidade.
 */
export async function lerPersonificacao(): Promise<string | null> {
  const c = await cookies();
  const v = c.get(COOKIE_PERSONIFICACAO)?.value?.trim();
  if (!v) return null;
  // Só UUID entra. Um valor malformado vira "nenhuma personificação" em vez de
  // virar filtro de query — e filtro malformado é como se descobre injeção.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}

export async function gravarPersonificacao(tenantId: string): Promise<void> {
  const c = await cookies();
  c.set(COOKIE_PERSONIFICACAO, tenantId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

export async function limparPersonificacao(): Promise<void> {
  const c = await cookies();
  c.delete(COOKIE_PERSONIFICACAO);
}
