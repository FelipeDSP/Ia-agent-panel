'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { definirNovaSenha, type EstadoFormulario } from '../acoes';
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
      {pending ? 'Salvando…' : 'Salvar senha'}
    </Button>
  );
}

export default function PaginaNovaSenha() {
  const [estado, acao] = useActionState<EstadoFormulario, FormData>(definirNovaSenha, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Definir nova senha</CardTitle>
        <CardDescription>Mínimo de 8 caracteres.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={acao} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="senha">Nova senha</Label>
            <Input
              id="senha"
              name="senha"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmacao">Confirme a senha</Label>
            <Input
              id="confirmacao"
              name="confirmacao"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>

          {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}

          <BotaoEnviar />
        </form>
      </CardContent>
    </Card>
  );
}
