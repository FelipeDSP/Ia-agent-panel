'use client';

import {
  BarChart3,
  BookOpen,
  Building2,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Settings,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { sair } from '@/app/(auth)/acoes';
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

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="border-b border-border px-5 py-4">
        <p className="text-sm font-semibold">Painel de Agentes</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {papel === 'super_admin' ? 'Administração' : (nomeTenant ?? 'Cliente')}
        </p>
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
        <form action={sair}>
          <Button type="submit" variant="ghost" size="sm" className="w-full justify-start gap-3">
            <LogOut className="h-4 w-4" aria-hidden />
            Sair
          </Button>
        </form>
      </div>
    </aside>
  );
}
