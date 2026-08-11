'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Switch acessível para ligar/desligar. `button` com role="switch" em vez de
 * checkbox estilizado: o estado é controlado pelo servidor (a ação grava e o
 * revalidate devolve o valor novo), então não há input a submeter — o que um
 * checkbox dentro de form traria de graça aqui só atrapalharia.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  ...props
}: {
  checked: boolean;
  onCheckedChange: (proximo: boolean) => void;
  disabled?: boolean;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type'>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'pointer-events-none block h-5 w-5 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}
