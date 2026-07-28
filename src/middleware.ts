import type { NextRequest } from 'next/server';

import { atualizarSessao } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return atualizarSessao(request);
}

export const config = {
  matcher: [
    /*
     * Tudo, menos estaticos e imagens. O middleware precisa rodar nas rotas
     * publicas tambem: e ele que faz o refresh do token, e nao so o bloqueio.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
