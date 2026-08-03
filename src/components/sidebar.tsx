'use client';

import {
  BarChart3,
  BookOpen,
  Building2,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  Settings,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { sair } from '@/app/(auth)/acoes';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import type { Papel } from '@/lib/auth';
import { cn } from '@/lib/utils';

type ItemMenu = {
  href: string;
  rotulo: string;
  Icone: typeof Building2;
  /** Sem destino ainda: aparece desabilitado em vez de dar 404. */
  futuro?: boolean;
};

const MENU: Record<Papel, ItemMenu[]> = {
  super_admin: [
    { href: '/admin/tenants', rotulo: 'Clientes', Icone: Building2 },
    { href: '/admin/consumo', rotulo: 'Consumo', Icone: BarChart3 },
  ],
  tenant_admin: [
    { href: '/painel', rotulo: 'Visão geral', Icone: LayoutDashboard },
    { href: '/painel/conhecimento', rotulo: 'Base de conhecimento', Icone: BookOpen },
    { href: '/painel/conversas', rotulo: 'Conversas', Icone: MessagesSquare },
    { href: '/painel/consumo', rotulo: 'Uso', Icone: BarChart3 },
    { href: '/painel/configuracoes', rotulo: 'Configurações', Icone: Settings },
  ],
};

export function Sidebar({
  papel,
  nome,
  email,
  nomeTenant,
}: {
  papel: Papel;
  nome: string;
  email: string;
  nomeTenant: string | null;
}) {
  const caminho = usePathname();
  const itens = MENU[papel];
  // Drawer no mobile. Fecha sozinho ao trocar de rota (a navegação client
  // muda `caminho`), evitando ter que fechar na mão a cada clique.
  const [aberto, setAberto] = useState(false);
  useEffect(() => {
    setAberto(false);
  }, [caminho]);

  return (
    <>
      {/* Barra superior só no mobile: dá o botão de abrir o menu. */}
      <div className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-sidebar px-4 md:hidden">
        <button
          type="button"
          onClick={() => setAberto(true)}
          aria-label="Abrir menu"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
        <span className="text-sm font-semibold">Painel de Agentes</span>
      </div>

      {/* Fundo escuro atrás do drawer aberto (mobile). */}
      {aberto ? (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          aria-hidden
          onClick={() => setAberto(false)}
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-border bg-sidebar transition-transform duration-200',
          'md:static md:z-auto md:translate-x-0',
          aberto ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Painel de Agentes</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {papel === 'super_admin' ? 'Administração' : (nomeTenant ?? 'Cliente')}
            </p>
          </div>
          {/* Fechar o drawer (só mobile). */}
          <button
            type="button"
            onClick={() => setAberto(false)}
            aria-label="Fechar menu"
            className="-mr-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 p-3">
        {itens.map(({ href, rotulo, Icone, futuro }) => {
          const ativo = caminho === href || caminho.startsWith(`${href}/`);

          if (futuro) {
            return (
              <span
                key={href}
                aria-disabled
                title="Disponível em uma próxima fase"
                className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/50"
              >
                <Icone className="h-4 w-4" aria-hidden />
                {rotulo}
              </span>
            );
          }

          return (
            <Link
              key={href}
              href={href}
              aria-current={ativo ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                ativo
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icone className="h-4 w-4" aria-hidden />
              {rotulo}
            </Link>
          );
        })}
      </nav>

      {/*
        Padding extra à esquerda: em `next dev` o indicador do Next fica no
        canto inferior esquerdo, sobre esta área. Em produção não há indicador,
        e o respiro é inofensivo.
      */}
      <div className="border-t border-border p-3">
        <div className="px-2 pb-2">
          <p className="truncate text-sm font-medium">{nome}</p>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
        </div>
        <ThemeToggle />
        <form action={sair}>
          <Button type="submit" variant="ghost" size="sm" className="w-full justify-start gap-3">
            <LogOut className="h-4 w-4" aria-hidden />
            Sair
          </Button>
        </form>
      </div>
      </aside>
    </>
  );
}
