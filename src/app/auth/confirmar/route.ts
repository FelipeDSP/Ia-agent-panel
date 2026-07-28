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

  const tokenHash = searchParams.get('token_hash');
  const tipo = searchParams.get('type') as EmailOtpType | null;
  const proximo = searchParams.get('proximo');

  // Mesma protecao contra open redirect do login.
  const destino =
    proximo && proximo.startsWith('/') && !proximo.startsWith('//') ? proximo : '/';

  if (!tokenHash || !tipo) {
    return NextResponse.redirect(`${origin}/login?erro=link_invalido`);
  }

  const supabase = await criarClienteServidor();
  const { error } = await supabase.auth.verifyOtp({ type: tipo, token_hash: tokenHash });

  if (error) {
    return NextResponse.redirect(`${origin}/login?erro=link_expirado`);
  }

  return NextResponse.redirect(`${origin}${destino}`);
}
