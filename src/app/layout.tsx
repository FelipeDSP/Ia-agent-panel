import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Painel de Agentes',
  description: 'Gestão de agentes de IA por cliente',
};

/*
 * Aplica a escolha de tema ANTES do primeiro paint, lendo do localStorage. Sem
 * isso, quem escolheu "claro" num sistema escuro (ou vice-versa) veria um flash
 * do tema errado até o React hidratar. Roda como primeiro filho do <body>, então
 * o parser executa antes de renderizar o conteúdo. Sem valor salvo, não mexe no
 * atributo e o CSS cai na preferência do sistema.
 */
const SCRIPT_TEMA = `try{var t=localStorage.getItem('tema');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <script dangerouslySetInnerHTML={{ __html: SCRIPT_TEMA }} />
        {children}
      </body>
    </html>
  );
}
