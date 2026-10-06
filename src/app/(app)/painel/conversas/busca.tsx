'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Input } from '@/components/ui/input';

/**
 * Busca por nome, telefone ou número da conversa.
 *
 * Navega por URL, como a de Pedidos: o resultado é link compartilhável e
 * sobrevive ao F5. Mandar "olha a conversa da Maria" vira um link.
 */
export function BuscaConversas({ valor }: { valor: string }) {
  const router = useRouter();
  const [texto, setTexto] = useState(valor);

  const buscar = (q: string) =>
    router.push(`/painel/conversas${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);

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
          placeholder="Nome, telefone ou número da conversa"
          aria-label="Buscar conversa"
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
