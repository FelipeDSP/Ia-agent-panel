import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { rotuloModalidade, rotuloPagamentoModo } from '@/lib/tools/vendas-config';
import { formatarBRL } from '@/lib/vendas/dinheiro';

import { StatusPedido, dataCurta } from '../componentes';
import { MarcarPedido } from '../marcar';

export default async function PaginaPedido({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  // O `id` vem da URL, então é entrada não confiável — daí o filtro explícito
  // por tenant_id junto. A RLS já barraria, mas as duas camadas (regra 6): id de
  // outro cliente dá 404, não "sem permissão", que confirmaria a existência.
  const { data: pedido } = await supabase
    .from('pedidos')
    .select('id, numero, conversation_id, status, total_centavos, metadados, criado_em, atualizado_em, modalidade, pagamento_modo, pago_em, retirado_em, retirada_nome')
    .eq('id', id)
    .eq('tenant_id', usuario.tenantId)
    .is('deletado_em', null)
    .maybeSingle();

  if (!pedido) notFound();

  const { data: itens } = await supabase
    .from('pedido_itens')
    .select('id, nome_snapshot, preco_unit_centavos, quantidade, observacao')
    .eq('pedido_id', id)
    .eq('tenant_id', usuario.tenantId)
    .order('criado_em', { ascending: true });

  const metadados = (pedido.metadados ?? {}) as Record<string, unknown>;
  // `notificacao`/`avisos` são controle do aviso ao dono, não informação do
  // fechamento — ficam fora da lista
  const metadadosVisiveis = Object.entries(metadados).filter(([k]) => k !== 'notificacao' && k !== 'avisos');
  const temMetadados = metadadosVisiveis.length > 0;
  const fechado = pedido.status !== 'rascunho';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/painel/pedidos"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Pedidos
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {pedido.numero ? `Pedido nº ${pedido.numero}` : 'Pedido em aberto'}
          </h1>
          <StatusPedido status={pedido.status as string} retiradoEm={pedido.retirado_em as string | null} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Conversa {String(pedido.conversation_id)} · aberto em{' '}
          {dataCurta(pedido.criado_em as string)}
        </p>
      </div>

      {fechado ? (
        <Card>
          <CardHeader>
            <CardTitle>Retirada e pagamento</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="font-medium">Modalidade:</dt>
                <dd className="text-muted-foreground">{rotuloModalidade(pedido.modalidade as string | null)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium">Pagamento:</dt>
                <dd className="text-muted-foreground">{rotuloPagamentoModo(pedido.pagamento_modo as string | null)}</dd>
              </div>
              {pedido.retirada_nome ? (
                <div className="flex gap-2">
                  <dt className="font-medium">Quem retira:</dt>
                  <dd className="text-muted-foreground">{pedido.retirada_nome as string}</dd>
                </div>
              ) : null}
              {pedido.pago_em ? (
                <div className="flex gap-2">
                  <dt className="font-medium">Pago em:</dt>
                  <dd className="text-muted-foreground">{dataCurta(pedido.pago_em as string)}</dd>
                </div>
              ) : null}
              {pedido.retirado_em ? (
                <div className="flex gap-2">
                  <dt className="font-medium">Retirado em:</dt>
                  <dd className="text-muted-foreground">{dataCurta(pedido.retirado_em as string)}</dd>
                </div>
              ) : null}
            </dl>
            <MarcarPedido
              pedidoId={pedido.id as string}
              status={pedido.status as string}
              pagamentoModo={(pedido.pagamento_modo as string | null) ?? null}
              retiradoEm={(pedido.retirado_em as string | null) ?? null}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Itens</CardTitle>
          <CardDescription>
            Nome e preço são os do momento em que o item entrou no pedido. Reajuste no
            catálogo depois disso não muda este pedido.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(itens ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Este pedido ainda não tem itens.
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {(itens ?? []).map((i) => (
                <div
                  key={i.id as string}
                  className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <span className="font-medium">
                      {i.quantidade as number}× {i.nome_snapshot as string}
                    </span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatarBRL(i.preco_unit_centavos as number)} cada
                      {i.observacao ? ` · ${i.observacao as string}` : ''}
                    </p>
                  </div>
                  <div className="font-medium tabular-nums">
                    {formatarBRL((i.preco_unit_centavos as number) * (i.quantidade as number))}
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between pt-3">
                <span className="font-medium">Total</span>
                <span className="text-lg font-semibold tabular-nums">
                  {formatarBRL(pedido.total_centavos as number)}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {temMetadados ? (
        <Card>
          <CardHeader>
            <CardTitle>Informações do fechamento</CardTitle>
            <CardDescription>
              O que o agente registrou ao fechar — entrega, retirada, observações.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-2 text-sm">
              {metadadosVisiveis.map(([chave, valor]) => (
                <div key={chave} className="flex flex-wrap gap-2">
                  <dt className="font-medium">{chave}:</dt>
                  <dd className="text-muted-foreground">
                    {typeof valor === 'object' ? JSON.stringify(valor) : String(valor)}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
