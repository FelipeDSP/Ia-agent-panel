'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Recarrega a fila sozinha, de tempos em tempos.
 *
 * `router.refresh()` e não `location.reload()`: o Next re-renderiza no servidor
 * e troca só o que mudou, então a busca digitada, a rolagem e o foco ficam onde
 * estavam. Recarregar a página inteira a cada 45 s em quem está digitando um
 * nome seria pior do que não atualizar.
 *
 * Pausa quando a aba não está visível: ninguém precisa que o painel converse
 * com o servidor enquanto está no WhatsApp, e isso é consulta ao banco de um
 * cliente real a cada 45 s.
 */
export function Atualiza({ segundos }: { segundos: number }) {
  const router = useRouter();

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, Math.max(10, segundos) * 1000);
    return () => clearInterval(t);
  }, [router, segundos]);

  return null;
}
