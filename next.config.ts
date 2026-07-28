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
};

export default nextConfig;
