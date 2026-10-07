'use client';

import { HelpCircle } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

/**
 * O `?` ao lado de um título: a explicação existe, mas só quando pedida.
 *
 * Por que isto virou componente (06/10): a ficha do cliente tinha 408 palavras
 * de ajuda IMPRESSAS na tela, e o painel do cliente outras 1.024. A prosa não é
 * decorativa — quase todo parágrafo foi escrito depois de um erro real (o aviso
 * do `inbox_id` existe porque caixa errada não dá erro: o agente só para de
 * responder, calado). Apagar seria perder o que custou caro. Então o texto não
 * sai: ele sai do CAMINHO.
 *
 * ELE EMPURRA, NÃO COBRE — e esta é a segunda correção do mesmo componente no
 * mesmo dia. A primeira versão era um popover `absolute`, e ele nasceu
 * transparente (`bg-popover`, token que este tema não declara: classe de token
 * inexistente não falha, só não pinta). Com o fundo consertado, o Felipe olhou
 * de novo: "tem muito texto sobrepondo um o outro". Estava certo — mesmo opaco,
 * uma caixa flutuante pousa sobre o conteúdo e o texto de baixo aparece em
 * volta dela.
 *
 * Caixa flutuante tem três problemas que não se resolvem com cor: cobre o que
 * está atrás, pode sair do card, e some do fluxo de leitura. Em flow ela empurra
 * o resto para baixo, e aí NÃO EXISTE sobreposição possível — não é um ajuste
 * de z-index ou de fundo, é a classe inteira de defeito indo embora.
 *
 * `basis-full` é o que o põe numa linha só: os títulos que o hospedam são
 * `flex`, e sem isso ele viraria mais um item ao lado do texto. `flex-wrap`
 * no título é o par disso — `teste:ajuda-empurra` mede os dois juntos, porque
 * um sem o outro quebra o layout em silêncio.
 */
export function Ajuda({ titulo, children }: { titulo: string; children: ReactNode }) {
  const [aberto, setAberto] = useState(false);
  const id = useId();

  return (
    <>
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        aria-controls={id}
        aria-label={`Ajuda: ${titulo}`}
        className="inline-flex shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      >
        <HelpCircle className="h-4 w-4" />
      </button>
      {aberto ? (
        <div
          id={id}
          role="note"
          className="mt-2 basis-full rounded-md border border-border bg-muted/40 p-3 text-sm font-normal leading-relaxed text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_strong]:text-foreground"
        >
          {children}
        </div>
      ) : null}
    </>
  );
}
