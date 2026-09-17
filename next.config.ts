import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /*
   * Build autocontido para Docker/Coolify: .next/standalone traz um server.js
   * com so as dependencias usadas, dispensando node_modules na imagem final.
   * Nao afeta `next dev` nem deploy na Vercel.
   */
  output: 'standalone',
  /*
   * Existe um package-lock.json solto em C:\Users\estud. Sem isto o Next elege
   * aquele diretorio como raiz do workspace e o build traceia arquivos de fora
   * do projeto.
   */
  outputFileTracingRoot: import.meta.dirname,
  typescript: {
    // Build falha em erro de tipo. E o criterio de conclusao do CLAUDE.md.
    ignoreBuildErrors: false,
  },
  /*
   * Cabecalhos de seguranca (analise de 17/09/2026, achado 6). O painel nao
   * embute nada de terceiros nem e embutido por ninguem: `frame-ancestors
   * 'none'` fecha clickjacking; HSTS por um ano (Cloudflare/Coolify ja
   * servem so HTTPS). CSP deliberadamente SEM restringir script/style: o
   * Next injeta scripts inline com nonce que exigiriam middleware proprio —
   * fica para uma rodada dedicada, com medicao.
   */
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
