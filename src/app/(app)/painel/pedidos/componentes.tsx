import { Badge } from '@/components/ui/badge';

/**
 * Rótulo e cor de cada status. O valor do banco (`rascunho`,
 * `aguardando_pagamento`) é vocabulário interno; o cliente lê "Em aberto" e
 * "Aguardando pagamento". Traduzir aqui e não no banco mantém o `status` como
 * chave estável para as funções do agente.
 *
 * Server component: é só apresentação, não precisa de 'use client'.
 */
const STATUS: Record<string, { rotulo: string; variante: 'success' | 'warning' | 'secondary' }> = {
  rascunho: { rotulo: 'Em aberto', variante: 'secondary' },
  aguardando_pagamento: { rotulo: 'Aguardando pagamento', variante: 'warning' },
  pago: { rotulo: 'Pago', variante: 'success' },
  cancelado: { rotulo: 'Cancelado', variante: 'secondary' },
  expirado: { rotulo: 'Expirado', variante: 'secondary' },
};

export function StatusPedido({ status }: { status: string }) {
  const s = STATUS[status] ?? { rotulo: status, variante: 'secondary' as const };
  return <Badge variant={s.variante}>{s.rotulo}</Badge>;
}

export function dataCurta(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}
