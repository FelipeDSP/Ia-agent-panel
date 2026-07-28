import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config';

/** Prefixos que exigem sessao. Tudo fora daqui e publico. */
const ROTAS_PROTEGIDAS = ['/painel', '/admin'];

/** Rotas de autenticacao: quem ja esta logado nao deveria ver. */
const ROTAS_AUTENTICACAO = ['/login', '/recuperar-senha'];

export async function atualizarSessao(request: NextRequest) {
  let resposta = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesParaDefinir) {
        for (const { name, value } of cookiesParaDefinir) {
          request.cookies.set(name, value);
        }
        resposta = NextResponse.next({ request });
        for (const { name, value, options } of cookiesParaDefinir) {
          resposta.cookies.set(name, value, options);
        }
      },
    },
  });

  /*
   * getUser() e nao getSession(): getSession() apenas decodifica o cookie, sem
   * validar. Um cookie forjado passaria. getUser() bate no servidor de auth e
   * revalida o token — e, de quebra, e o que dispara o refresh da sessao.
   *
   * Nao inserir codigo entre createServerClient e getUser: qualquer coisa que
   * cause retorno antecipado deixa a sessao sem refresh e o usuario e
   * deslogado aleatoriamente quando o token expira.
   */
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const caminho = request.nextUrl.pathname;
  const protegida = ROTAS_PROTEGIDAS.some(
    (p) => caminho === p || caminho.startsWith(`${p}/`),
  );
  const deAutenticacao = ROTAS_AUTENTICACAO.some(
    (p) => caminho === p || caminho.startsWith(`${p}/`),
  );

  if (!user && protegida) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Preserva o destino para voltar depois do login.
    url.searchParams.set('proximo', caminho);
    return NextResponse.redirect(url);
  }

  if (user && deAutenticacao) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  /*
   * Devolver EXATAMENTE este objeto. Criar um NextResponse novo aqui descarta
   * os cookies de refresh que o supabase acabou de gravar, e a sessao morre
   * silenciosamente na proxima navegacao.
   */
  return resposta;
}
