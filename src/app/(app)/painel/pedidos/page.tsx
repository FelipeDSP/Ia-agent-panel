import { ShoppingCart } from 'lucide-react';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { formatarBRL } from '@/lib/vendas/dinheiro';
import { StatusPedido, dataCurta } from './componentes';

export default async function PaginaPedidos() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  // RLS já escopa por tenant; filtro explícito como segunda camada (regra 6).
  // pedido_itens vem embutido só para contar itens na lista — o detalhe de cada
  // um fica na página do pedido.
  const { data, error } = await supabase
    .from('pedidos')
    .select('id, numero, conversation_id, status, total_centavos, criado_em, pedido_itens(id)')
    .eq('tenant_id', usuario.tenantId)
    .is('deletado_em', null)
    .order('criado_em', { ascending: false })
    .limit(200);

  if (error) {
    return <Alert variant="destructive">Não foi possível carregar os pedidos.</Alert>;
  }

  const pedidos = data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Pedidos</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          O que o agente montou nas conversas. Aqui você acompanha — quem altera o pedido é
          o agente, junto com o cliente.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Pedidos recebidos</CardTitle>
          <CardDescription>
            <strong>Em aberto</strong> ainda está sendo montado na conversa.{' '}
            <strong>Aguardando pagamento</strong> foi fechado com o cliente e não aceita mais
            alteração.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pedidos.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
              <ShoppingCart className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">Nenhum pedido ainda</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  Quando o agente montar um pedido numa conversa, ele aparece aqui. Confira se
                  seu catálogo está cadastrado e se o módulo de vendas está ligado em
                  Configurações.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {pedidos.map((p) => {
                const itens = Array.isArray(p.pedido_itens) ? p.pedido_itens.length : 0;
                return (
                  <Link
                    key={p.id as string}
                    href={`/painel/pedidos/${p.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 hover:bg-muted/40"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {p.numero ? `Pedido nº ${p.numero}` : 'Pedido em aberto'}
                        </span>
                        <StatusPedido status={p.status as string} />
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {itens} {itens === 1 ? 'item' : 'itens'} · conversa{' '}
                        {String(p.conversation_id)} · {dataCurta(p.criado_em as string)}
                      </p>
                    </div>
                    <div className="font-medium tabular-nums">
                      {formatarBRL(p.total_centavos as number)}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
