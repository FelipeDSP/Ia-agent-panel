'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { pedirRecuperacao, type EstadoFormulario } from '../acoes';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function BotaoEnviar() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? 'Enviando…' : 'Enviar link'}
    </Button>
  );
}

export default function PaginaRecuperarSenha() {
  const [estado, acao] = useActionState<EstadoFormulario, FormData>(pedirRecuperacao, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recuperar senha</CardTitle>
        <CardDescription>
          Enviamos um link para você definir uma senha nova.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={acao} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required autoFocus />
          </div>

          {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
          {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}

          <BotaoEnviar />

          <Link
            href="/login"
            className="text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Voltar para o login
          </Link>
        </form>
      </CardContent>
    </Card>
  );
}
