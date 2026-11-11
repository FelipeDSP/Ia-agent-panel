'use client';

import { ArrowLeft, Eye } from 'lucide-react';
import { useFormStatus } from 'react-dom';

import { sairDaConta } from '@/lib/personificacao-acoes';

/**
 * A faixa que lembra a agência de que ela está DENTRO da conta de um cliente.
 *
 * É deliberadamente intrusiva: fixa no topo, em cor de alerta, empurrando a
 * página para baixo em vez de flutuar sobre ela. O modo de falha desta
 * funcionalidade inteira é esquecer que se está lá dentro e tomar uma decisão
 * achando que é na própria conta — e o custo disso cai no cliente, não em quem
 * errou. Um aviso discreto seria pior que nenhum, porque daria a sensação de
 * que existe proteção.
 *
 * O nome do cliente aparece POR EXTENSO, não um id: ninguém reconhece
 * `a1b2c3d4` como "Empório".
 */
function BotaoSair() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-full bg-amber-950/20 px-3 py-1 text-xs font-medium underline-offset-2 hover:underline disabled:opacity-60 dark:bg-amber-50/10"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      {pending ? 'Saindo…' : 'Sair da conta'}
    </button>
  );
}

export function FaixaPersonificacao({ nome }: { nome: string }) {
  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-500/40 bg-amber-400 px-4 py-2 text-sm text-amber-950 dark:bg-amber-500"
    >
      <span className="inline-flex items-center gap-1.5 font-medium">
        <Eye className="h-4 w-4" aria-hidden />
        Você está dentro da conta de <strong>{nome}</strong>
      </span>
      <span className="text-amber-950/80">O que você mudar aqui muda para o cliente.</span>
      <form action={sairDaConta}>
        <BotaoSair />
      </form>
    </div>
  );
}
