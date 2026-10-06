'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { SubmitButton } from '@/components/ui/submit-button';

import { marcarPedido, type EstadoPedido } from './acoes';

/**
 * Os dois botões do dono (migração 69): "pago" aparece enquanto o pedido
 * aguarda pagamento; "retirado" aparece depois de pago e some quando
 * `retirado_em` existe. Pagar na retirada marca os dois de uma vez no banco,
 * então o segundo botão nem chega a aparecer nesse caso.
 */
export function MarcarPedido({
  pedidoId,
  status,
  pagamentoModo,
  retiradoEm,
}: {
  pedidoId: string;
  status: string;
  pagamentoModo: string | null;
  retiradoEm: string | null;
}) {
  const [estado, acao] = useActionState<EstadoPedido, FormData>(marcarPedido, {});
  const podePagar = status === 'aguardando_pagamento';
  const podeRetirar = status === 'pago' && !retiradoEm;
  if (!podePagar && !podeRetirar && !estado.erro && !estado.sucesso) return null;

  return (
    <form action={acao} className="flex flex-col gap-3">
      <input type="hidden" name="pedido_id" value={pedidoId} />
      {estado.erro ? <Alert variant="destructive">{estado.erro}</Alert> : null}
      {estado.sucesso ? <Alert variant="success">{estado.sucesso}</Alert> : null}
      <div className="flex flex-wrap items-center gap-3">
        {podePagar ? (
          <SubmitButton name="acao" value="pago" pendingLabel="Marcando…">
            {pagamentoModo === 'na_retirada' ? 'Pagou e retirou' : 'Marcar como pago'}
          </SubmitButton>
        ) : null}
        {podeRetirar ? (
          <SubmitButton name="acao" value="retirado" pendingLabel="Marcando…">
            Marcar como retirado
          </SubmitButton>
        ) : null}
      </div>
      {podePagar && pagamentoModo === 'link' ? (
        <p className="text-xs text-muted-foreground">
          Pelo link o agente confirma sozinho quando o pagamento cai. Marque à mão só se recebeu
          por fora — o link deixa de ser cobrado.
        </p>
      ) : null}
    </form>
  );
}


/**
 * O botão do PRÓXIMO PASSO, para a fila (83).
 *
 * Um botão só por pedido, de propósito: quem está preparando não escolhe entre
 * três ações, ele faz a próxima. Separar → (pagou) → saiu. Três botões lado a
 * lado numa fila de vinte pedidos é onde se clica no errado.
 */
export function PassoDoPedido({
  pedidoId,
  passo,
  pagamentoModo,
  separado,
}: {
  pedidoId: string;
  passo: 'separar' | 'pago' | 'retirado';
  pagamentoModo: string | null;
  separado: boolean;
}) {
  const [estado, acao] = useActionState<EstadoPedido, FormData>(marcarPedido, {});
  const rotulo =
    passo === 'separar'
      ? 'Separar'
      : passo === 'pago'
        ? (pagamentoModo === 'na_retirada' ? 'Pagou e levou' : 'Marcar pago')
        : 'Entregue';
  const valor = passo === 'separar' ? 'separado' : passo;

  return (
    <form action={acao} className="flex shrink-0 flex-col items-end gap-1">
      <input type="hidden" name="pedido_id" value={pedidoId} />
      <div className="flex items-center gap-2">
        {separado ? (
          <SubmitButton name="acao" value="desfazer_separado" variant="outline" size="sm" pendingLabel="…">
            Desfazer
          </SubmitButton>
        ) : null}
        <SubmitButton name="acao" value={valor} size="sm" pendingLabel="…">
          {rotulo}
        </SubmitButton>
      </div>
      {estado.erro ? <span className="text-xs text-destructive">{estado.erro}</span> : null}
    </form>
  );
}
