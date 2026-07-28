'use client';

import { useFormStatus } from 'react-dom';

import { Button, type ButtonProps } from './button';

/**
 * Botão de submit que desabilita e troca o texto enquanto a Server Action roda.
 * Precisa estar dentro de um <form action={...}>.
 */
export function SubmitButton({
  children,
  pendingLabel = 'Salvando…',
  ...props
}: ButtonProps & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
