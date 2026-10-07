import Link from 'next/link';

import { rotuloPagamentoModo } from '@/lib/tools/vendas-config';
import { formatarBRL } from '@/lib/vendas/dinheiro';

import { StatusPedido } from './componentes';
import { horaLocal, type PedidoDaFila } from './fila';
import { PassoDoPedido } from './marcar';

/**
 * UMA linha de pedido, para as três abas.
 *
 * Por que isto virou um componente só (06/10, depois de o Felipe olhar as
 * abas e dizer que estavam "muito diferentes umas das outras"): eu tinha
 * escrito duas — uma para a fila, com a hora à esquerda e o botão à direita, e
 * outra para o histórico, com o valor à direita e a linha inteira clicável. O
 * resultado é que a mesma informação mudava de lugar conforme a aba, e quem
 * trabalha nas três o dia inteiro precisa reaprender a ler a cada clique.
 *
 * O esqueleto é fixo e as quatro colunas estão sempre no mesmo lugar:
 *
 *   [ quando ]  [ nº · quem · status ]          [ valor ]  [ ação ]
 *                 itens · pagamento
 *
 * O que varia é o CONTEÚDO, não a posição: na fila a primeira coluna é a hora,
 * nas outras é a data; a ação só existe onde há próximo passo, e a coluna
 * continua reservada para as linhas não dançarem.
 *
 * O link é só no número, nunca na linha inteira: botão dentro de link é HTML
 * inválido e, na prática, clicar em "Separar" abriria o pedido.
 */
export function LinhaPedido({
  p,
  tz,
  mostrarHora,
  acao,
  novo,
}: {
  p: PedidoDaFila;
  tz: string;
  /** Fila: a hora combinada. Histórico e rascunhos: a data de criação. */
  mostrarHora: boolean;
  acao: 'passo' | 'nenhuma';
  /** Fechou depois da última vez que ESTA pessoa abriu a fila. */
  novo?: boolean;
}) {
  const quando = mostrarHora
    ? (p.quando_em ? horaLocal(p.quando_em, tz) : '—')
    : new Date(p.criado_em).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

  return (
    <div className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
      <span className="w-12 shrink-0 text-right text-sm font-medium tabular-nums text-muted-foreground">
        {quando}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={`/painel/pedidos/${p.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {p.numero ? `Pedido nº ${p.numero}` : 'Pedido'}
          </Link>
          {p.retirada_nome ? <span className="truncate">{p.retirada_nome}</span> : null}
          {novo ? (
            <span className="rounded-full bg-primary px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-primary-foreground">
              novo
            </span>
          ) : null}
          <StatusPedido status={p.status} retiradoEm={p.retirado_em} />
          {p.separado_em && !p.retirado_em ? (
            <span className="text-xs text-muted-foreground">separado</span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {p.itens} {p.itens === 1 ? 'item' : 'itens'}
          {p.pagamento_modo ? ` · ${rotuloPagamentoModo(p.pagamento_modo)}` : ''}
          {' · '}
          {/* 06/10, pedido do Felipe: ir do pedido para a conversa sem procurar.
              É a pergunta que quem prepara faz o tempo todo — "o que ele pediu
              mesmo?" — e a resposta está no diálogo, não no pedido. */}
          <Link
            href={`/painel/conversas/${p.conversation_id}`}
            className="underline-offset-4 hover:underline"
          >
            ver conversa
          </Link>
        </p>
      </div>

      <span className="shrink-0 whitespace-nowrap font-medium tabular-nums">
        {formatarBRL(p.total_centavos)}
      </span>

      {/*
       * `min-w`, NÃO `w`. A coluna existe sempre para o valor não dançar entre
       * as linhas — mas um pedido JÁ SEPARADO tem DOIS botões ("Desfazer" e o
       * próximo passo), e com largura fixa eles transbordavam por cima do
       * valor: a tela imprimia `R$D1e2s,f0a0zer`, as duas coisas no mesmo
       * lugar (visto pelo Felipe em 06/10). Largura mínima alinha o caso comum
       * e deixa o caso de dois botões crescer, empurrando o nome — que é
       * `min-w-0 flex-1` e encolhe de propósito.
       */}
      <div className="flex min-w-[8.5rem] shrink-0 justify-end gap-2">
        {acao === 'passo' ? (
          <PassoDoPedido
            pedidoId={p.id}
            passo={p.separado_em ? (p.status === 'aguardando_pagamento' ? 'pago' : 'retirado') : 'separar'}
            pagamentoModo={p.pagamento_modo}
            separado={Boolean(p.separado_em)}
          />
        ) : null}
      </div>
    </div>
  );
}
