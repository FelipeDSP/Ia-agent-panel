'use client';

import { HelpCircle } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * O `?` ao lado de um título: a explicação existe, mas só quando pedida.
 *
 * Por que isto virou componente (06/10): a ficha do cliente tinha 408 palavras
 * de texto de ajuda IMPRESSAS na tela, e o painel do cliente outras 1.024. A
 * prosa não é decorativa — quase todo parágrafo foi escrito depois de um erro
 * real (o aviso do `inbox_id` existe porque caixa errada não dá erro: o agente
 * só para de responder, calado). Apagar seria perder o que custou caro.
 *
 * Então o texto não sai: ele sai do CAMINHO. Quem já sabe vê um título limpo;
 * quem não sabe clica. É o mesmo padrão que o Felipe pediu para o aprendizado
 * automático em 01/10, e que ali funcionou.
 *
 * Fecha com Escape e com clique fora — um popup que só fecha pelo próprio
 * botão é uma armadilha quando se abrem dois.
 */
export function Ajuda({ titulo, children }: { titulo: string; children: ReactNode }) {
  const [aberto, setAberto] = useState(false);
  const caixa = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!aberto) return;
    const porTecla = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false); };
    const porClique = (e: MouseEvent) => {
      if (caixa.current && !caixa.current.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener('keydown', porTecla);
    document.addEventListener('mousedown', porClique);
    return () => {
      document.removeEventListener('keydown', porTecla);
      document.removeEventListener('mousedown', porClique);
    };
  }, [aberto]);

  return (
    <span ref={caixa} className="relative inline-flex align-middle">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        aria-label={`Ajuda: ${titulo}`}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <HelpCircle className="h-4 w-4" />
      </button>
      {aberto ? (
        <span
          role="note"
          className="absolute left-0 top-6 z-30 w-[min(22rem,calc(100vw-3rem))] rounded-md border border-border bg-popover p-3 text-sm font-normal leading-relaxed text-muted-foreground shadow-lg [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_strong]:text-foreground"
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Título de card com o `?` do lado. Existe para o caso comum não precisar
 * repetir o `flex items-center gap-1.5` em cada tela — e para que o `?` fique
 * sempre no mesmo lugar, que é metade do valor de ter um.
 */
export function TituloComAjuda({ children, ajuda, titulo }: { children: ReactNode; ajuda: ReactNode; titulo: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {children}
      <Ajuda titulo={titulo}>{ajuda}</Ajuda>
    </span>
  );
}
