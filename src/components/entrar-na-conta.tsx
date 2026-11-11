'use client';

import { LogIn } from 'lucide-react';
import { useFormStatus } from 'react-dom';

import { Button } from '@/components/ui/button';
import { entrarNaConta } from '@/lib/personificacao-acoes';

/**
 * O botão que leva a agência para dentro da conta do cliente.
 *
 * `bind` em vez de um `<input type="hidden">` com o id: o id não precisa
 * trafegar pelo formulário, e o que não trafega não tem como ser trocado no
 * caminho. A ação confere o papel no JWT de qualquer jeito — isto é só não
 * oferecer a oportunidade.
 */
function Botao({ rotulo }: { rotulo: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" className="gap-1.5" disabled={pending}>
      <LogIn className="h-3.5 w-3.5" aria-hidden />
      {pending ? 'Entrando…' : rotulo}
    </Button>
  );
}

export function EntrarNaConta({ tenantId, rotulo = 'Entrar' }: { tenantId: string; rotulo?: string }) {
  return (
    <form action={entrarNaConta.bind(null, tenantId)}>
      <Botao rotulo={rotulo} />
    </form>
  );
}
