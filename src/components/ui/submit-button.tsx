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
  disabled,
  ...props
}: ButtonProps & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  // Desabilita enquanto envia OU quando o chamador pediu (ex.: confirmação
  // ainda não satisfeita). Sem isto, um `disabled` externo apagaria o `pending`.
  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
