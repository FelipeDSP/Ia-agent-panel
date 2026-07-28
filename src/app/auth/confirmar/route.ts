import { type EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

import { criarClienteServidor } from '@/lib/supabase/server';

/**
 * Recebe o link de recuperacao/convite e troca o token por sessao.
 *
 * O Supabase manda `token_hash` + `type`. A troca precisa acontecer no
 * servidor, gravando o cookie de sessao — por isso e Route Handler e nao
 * pagina.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  /*
   * Base dos redirects: o domínio público configurado, NÃO o host que o request
   * carrega. Atrás do proxy da Coolify o container se vê como `0.0.0.0:3000`, e
   * um redirect para esse host manda o navegador para um endereço inalcançável.
   * NEXT_PUBLIC_SITE_URL é a origem canônica; só caímos no origin do request
   * (dev local) quando ela não está definida.
   */
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? origin;

  const tokenHash = searchParams.get('token_hash');
  const tipo = searchParams.get('type') as EmailOtpType | null;
  const proximo = searchParams.get('proximo');

  // Mesma protecao contra open redirect do login.
  const destino =
    proximo && proximo.startsWith('/') && !proximo.startsWith('//') ? proximo : '/';

  if (!tokenHash || !tipo) {
    return NextResponse.redirect(`${base}/login?erro=link_invalido`);
  }

  const supabase = await criarClienteServidor();
  const { error } = await supabase.auth.verifyOtp({ type: tipo, token_hash: tokenHash });

  if (error) {
    return NextResponse.redirect(`${base}/login?erro=link_expirado`);
  }

  return NextResponse.redirect(`${base}${destino}`);
}
