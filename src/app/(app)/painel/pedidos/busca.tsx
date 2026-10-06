'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Input } from '@/components/ui/input';

/**
 * Busca por número do pedido ou nome de quem vem buscar.
 *
 * Navega por URL em vez de filtrar no cliente: o resultado é link
 * compartilhável, sobrevive ao F5, e quem está no balcão com o cliente na
 * frente não perde a busca ao marcar um pedido (a página revalida e volta).
 */
export function Busca({ valor, aba }: { valor: string; aba: string }) {
  const router = useRouter();
  const [texto, setTexto] = useState(valor);

  const buscar = (q: string) => {
    const p = new URLSearchParams();
    if (aba !== 'fila') p.set('ver', aba);
    if (q.trim()) p.set('q', q.trim());
    router.push(`/painel/pedidos${p.toString() ? `?${p}` : ''}`);
  };

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); buscar(texto); }}
      className="flex items-center gap-2"
      role="search"
    >
      <div className="relative flex-1 sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="Número do pedido ou nome de quem busca"
          aria-label="Buscar pedido"
          className="pl-9"
        />
      </div>
      {valor ? (
        <button
          type="button"
          onClick={() => { setTexto(''); buscar(''); }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          limpar
        </button>
      ) : null}
    </form>
  );
}
