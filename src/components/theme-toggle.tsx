'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Alterna o tema entre claro e escuro e persiste a escolha no localStorage. A
 * aplicação de fato acontece via `data-theme` no <html> (o script anti-flash no
 * layout raiz garante que a escolha valha já no primeiro paint).
 *
 * `tema` começa null (servidor e primeiro render do cliente batem, sem mismatch
 * de hidratação) e é resolvido no efeito a partir do que já está aplicado —
 * seja escolha explícita, seja a preferência do sistema.
 */
function resolverTema(): 'dark' | 'light' {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [tema, setTema] = useState<'dark' | 'light' | null>(null);

  useEffect(() => {
    setTema(resolverTema());
  }, []);

  function alternar() {
    const novo = (tema ?? resolverTema()) === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', novo);
    try {
      localStorage.setItem('tema', novo);
    } catch {
      // localStorage indisponível (modo restrito): a troca vale nesta sessão.
    }
    setTema(novo);
  }

  const escuro = tema === 'dark';

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={alternar}
      className="w-full justify-start gap-3"
      aria-label={escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
    >
      {/* Antes de montar (tema null) mostra o sol como placeholder estável. */}
      {escuro ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
      {tema === null ? 'Tema' : escuro ? 'Tema claro' : 'Tema escuro'}
    </Button>
  );
}
