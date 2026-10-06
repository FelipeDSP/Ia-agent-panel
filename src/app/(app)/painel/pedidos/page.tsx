import { ShoppingCart } from 'lucide-react';
import Link from 'next/link';

import { Ajuda } from '@/components/ui/ajuda';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { exigirMembro } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { lerHorarioAgente } from '@/lib/tenants/horario-agente';
import { rotuloPagamentoModo } from '@/lib/tools/vendas-config';
import { formatarBRL } from '@/lib/vendas/dinheiro';

import { StatusPedido, dataCurta } from './componentes';
import { PassoDoPedido } from './marcar';
import { Busca } from './busca';
import { casaBusca, horaLocal, montarFila, naFila, type PedidoDaFila } from './fila';

const ABAS = [
  ['fila', 'A fazer'],
  ['historico', 'Já saíram'],
  ['rascunhos', 'Em aberto'],
] as const;
type Aba = (typeof ABAS)[number][0];

export default async function PaginaPedidos({
  searchParams,
}: {
  searchParams?: Promise<{ ver?: string; q?: string }>;
}) {
  const usuario = await exigirMembro();
  const sp = (await searchParams) ?? {};
  const aba: Aba = ABAS.some(([c]) => c === sp.ver) ? (sp.ver as Aba) : 'fila';
  const termo = String(sp.q ?? '').trim();

  const supabase = await criarClienteServidor();

  // O fuso da loja: a fila agrupa por DIA, e "hoje" em Ariquemes não é "hoje"
  // em São Paulo. Falha fecha no padrão, como o agente faz.
  const { data: tenant } = await supabase
    .from('tenants')
    .select('horario_agente')
    .eq('id', usuario.tenantId)
    .maybeSingle();
  // `lerHorarioAgente` devolve null quando o cliente não configurou horário —
  // a maioria. O fuso cai no padrão do serviço, o mesmo que o agente usa para
  // dizer que horas são (`FUSO_PADRAO`).
  const tz = lerHorarioAgente(tenant?.horario_agente ?? null)?.timezone ?? 'America/Sao_Paulo';

  // RLS já escopa por tenant; filtro explícito como segunda camada (regra 6).
  const { data, error } = await supabase
    .from('pedidos')
    .select(
      'id, numero, conversation_id, status, total_centavos, criado_em, pagamento_modo, pago_em, retirado_em, retirada_nome, quando_em, separado_em, pedido_itens(id)',
    )
    .eq('tenant_id', usuario.tenantId)
    .is('deletado_em', null)
    .order('criado_em', { ascending: false })
    .limit(300);

  if (error) {
    return (
      <Alert variant="destructive">
        Não foi possível carregar os pedidos.
        {/^.*(quando_em|separado_em).*$/.test(error.message)
          ? ' A migração 83 ainda não foi aplicada neste banco.'
          : ''}
      </Alert>
    );
  }

  const todos: PedidoDaFila[] = (data ?? []).map((p) => ({
    id: String(p.id),
    numero: (p.numero as number | null) ?? null,
    status: String(p.status),
    total_centavos: Number(p.total_centavos ?? 0),
    quando_em: (p.quando_em as string | null) ?? null,
    separado_em: (p.separado_em as string | null) ?? null,
    retirado_em: (p.retirado_em as string | null) ?? null,
    pago_em: (p.pago_em as string | null) ?? null,
    pagamento_modo: (p.pagamento_modo as string | null) ?? null,
    retirada_nome: (p.retirada_nome as string | null) ?? null,
    conversation_id: Number(p.conversation_id ?? 0),
    criado_em: String(p.criado_em),
    itens: Array.isArray(p.pedido_itens) ? p.pedido_itens.length : 0,
  }));

  const filtrados = todos.filter((p) => casaBusca(p, termo));
  const fila = montarFila(filtrados, new Date(), tz);
  const naFilaN = todos.filter(naFila).length;

  const historico = filtrados
    .filter((p) => p.retirado_em || p.status === 'cancelado' || p.status === 'expirado')
    .slice(0, 100);
  const rascunhos = filtrados.filter((p) => p.status === 'rascunho');

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Pedidos</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {naFilaN === 0
            ? 'Nada para preparar agora.'
            : `${naFilaN} pedido(s) para preparar.`}
        </p>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-border" aria-label="Pedidos">
        {ABAS.map(([chave, rotulo]) => (
          <Link
            key={chave}
            href={`/painel/pedidos${chave === 'fila' ? '' : `?ver=${chave}`}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${aba === chave ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            aria-current={aba === chave ? 'page' : undefined}
          >
            {rotulo}
          </Link>
        ))}
      </nav>

      <Busca valor={termo} aba={aba} />

      {aba === 'fila' ? (
        fila.length === 0 ? (
          <Vazio
            titulo={termo ? 'Nada encontrado' : 'Nenhum pedido para preparar'}
            texto={
              termo
                ? 'Procure pelo número do pedido ou pelo nome de quem vem buscar.'
                : 'Quando o agente fechar um pedido numa conversa, ele aparece aqui na hora combinada.'
            }
          />
        ) : (
          fila.map((g) => (
            <Card key={g.chave}>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5 text-base">
                  <span className={g.chave === 'atrasado' ? 'text-destructive' : undefined}>
                    {g.rotulo}
                  </span>
                  <span className="text-sm font-normal text-muted-foreground">
                    ({g.pedidos.length})
                  </span>
                  {g.chave === 'sem_horario' ? (
                    <Ajuda titulo="Sem horário combinado">
                      O agente pergunta quando o cliente vem buscar e grava a hora. Estes aqui
                      fecharam sem ninguém combinar — ou são de antes de o agente passar a
                      perguntar.
                      <br />
                      <br />
                      Abra o pedido para ver a conversa e combinar.
                    </Ajuda>
                  ) : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col divide-y divide-border">
                {g.pedidos.map((p) => (
                  <LinhaFila key={p.id} p={p} tz={tz} />
                ))}
              </CardContent>
            </Card>
          ))
        )
      ) : null}

      {aba === 'historico' ? (
        <Card>
          <CardContent className="flex flex-col divide-y divide-border pt-6">
            {historico.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum pedido encerrado ainda.</p>
            ) : (
              historico.map((p) => <LinhaSimples key={p.id} p={p} />)
            )}
          </CardContent>
        </Card>
      ) : null}

      {aba === 'rascunhos' ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-base">
              Em aberto
              <Ajuda titulo="Pedidos em aberto">
                Carrinho que o agente ainda está montando numa conversa. Os itens podem mudar, e
                por isso ele <strong>não</strong> entra na fila de preparo — o cliente ainda não
                fechou.
                <br />
                <br />
                Se um ficou parado há dias, a conversa provavelmente morreu.
              </Ajuda>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-border">
            {rascunhos.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum carrinho em aberto.</p>
            ) : (
              rascunhos.map((p) => <LinhaSimples key={p.id} p={p} />)
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Vazio({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <ShoppingCart className="h-8 w-8 text-muted-foreground" />
      <div>
        <p className="font-medium">{titulo}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{texto}</p>
      </div>
    </div>
  );
}

function LinhaFila({ p, tz }: { p: PedidoDaFila; tz: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-4">
        <span className="w-14 shrink-0 text-right font-medium tabular-nums">
          {p.quando_em ? horaLocal(p.quando_em, tz) : '—'}
        </span>
        <div className="min-w-0">
          <Link href={`/painel/pedidos/${p.id}`} className="font-medium underline-offset-4 hover:underline">
            {p.numero ? `Pedido nº ${p.numero}` : 'Pedido'}
          </Link>
          {p.retirada_nome ? <span className="ml-2">{p.retirada_nome}</span> : null}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {p.itens} {p.itens === 1 ? 'item' : 'itens'} · {formatarBRL(p.total_centavos)}
            {p.pagamento_modo ? ` · ${rotuloPagamentoModo(p.pagamento_modo)}` : ''}
            {p.separado_em ? ' · separado' : ''}
          </p>
        </div>
      </div>
      <PassoDoPedido
        pedidoId={p.id}
        passo={p.separado_em ? (p.status === 'aguardando_pagamento' ? 'pago' : 'retirado') : 'separar'}
        pagamentoModo={p.pagamento_modo}
        separado={Boolean(p.separado_em)}
      />
    </div>
  );
}

function LinhaSimples({ p }: { p: PedidoDaFila }) {
  return (
    <Link
      href={`/painel/pedidos/${p.id}`}
      className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 hover:bg-muted/40"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{p.numero ? `Pedido nº ${p.numero}` : 'Pedido em aberto'}</span>
          <StatusPedido status={p.status} retiradoEm={p.retirado_em} />
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {p.itens} {p.itens === 1 ? 'item' : 'itens'}
          {p.retirada_nome ? ` · retira: ${p.retirada_nome}` : ''} · conversa {p.conversation_id} ·{' '}
          {dataCurta(p.criado_em)}
        </p>
      </div>
      <div className="font-medium tabular-nums">{formatarBRL(p.total_centavos)}</div>
    </Link>
  );
}
