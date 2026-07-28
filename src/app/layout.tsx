import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Painel de Agentes',
  description: 'Gestão de agentes de IA por cliente',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
