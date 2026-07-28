'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { entrar, type EstadoFormulario } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function BotaoEnviar() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? 'Entrando…' : 'Entrar'}
    </Button>
  );
}

export function FormularioLogin({ proximo }: { proximo: string | null }) {
  const [estado, acao] = useActionState<EstadoFormulario, FormData>(entrar, {});

  return (
    <form action={acao} className="flex flex-col gap-4">
      {proximo ? <input type="hidden" name="proximo" value={proximo} /> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="senha">Senha</Label>
        <Input
          id="senha"
          name="senha"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}

      <BotaoEnviar />

      <Link
        href="/recuperar-senha"
        className="text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        Esqueci minha senha
      </Link>
    </form>
  );
}
