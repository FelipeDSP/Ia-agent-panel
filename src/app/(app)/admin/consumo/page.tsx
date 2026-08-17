import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { exigirSuperAdmin } from '@/lib/auth';
import {
  montarVisaoMensal,
  rotuloMes,
  type CardConsumo,
  type LinhaConsumo,
  type TenantConsumo,
} from '@/lib/billing/consumo';
import { criarClienteServidor } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

/**
 * Consumo do MÊS CORRENTE — a olhada rápida.
 *
 * A tela anterior despejava todos os clientes de todos os meses numa tabela só,
 * e a pergunta que ela era aberta para responder ("como está o mês?") tinha de
 * ser respondida procurando as linhas do mês certo no meio do histórico. Com
 * quatro clientes já custava; com dez o mês corrente sumia.
 *
 * Aqui há só o mês corrente. O histórico é a OUTRA pergunta ("quanto esse
 * cliente custa?"), é investigação, e mora em `/admin/consumo/[tenantId]` —
 * onde só se chega clicando num cliente, que é quando ela é feita.
 *
 * `billing_consumo_mensal()` já devolve tudo por tenant e mês; a separação é
 * inteira no front, sem SQL novo. A única query a mais é a de `tenants`, porque
 * a RPC não emite linha para cliente sem consumo e é exatamente esse cliente
 * que precisa aparecer no fim da lista.
 */

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const num = new Intl.NumberFormat('pt-BR');
const pct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

export default async function PaginaConsumoAdmin() {
  await exigirSuperAdmin();
  const supabase = await criarClienteServidor();

  const [{ data: consumoRaw, error }, { data: tenantsRaw, error: erroTenants }] =
    await Promise.all([
      supabase.rpc('billing_consumo_mensal'),
      supabase.from('tenants').select('id, nome, deletado_em').is('deletado_em', null).order('nome'),
    ]);

  const linhas = (consumoRaw ?? []) as LinhaConsumo[];
  const tenants: TenantConsumo[] = (tenantsRaw ?? []).map((t) => ({
    id: t.id as string,
    nome: t.nome as string,
    deletado: false,
  }));

  const { mes, mesAnterior, total, cards } = montarVisaoMensal({
    linhas,
    tenants,
    agora: new Date(),
  });

  const comConsumo = cards.filter((c) => !c.semConsumo);
  const parados = cards.filter((c) => c.semConsumo);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Consumo de IA</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rotuloMes(mes)} — mês em curso. Custo estimado da agência, por cliente.
          </p>
        </div>
        <Link href="/admin/consumo/precos" className={buttonVariants({ variant: 'outline' })}>
          Tabela de preços
        </Link>
      </header>

      {error ? (
        <Alert variant="destructive">Não foi possível carregar o consumo: {error.message}</Alert>
      ) : null}
      {erroTenants ? (
        <Alert variant="warning">
          Não foi possível carregar a lista de clientes: {erroTenants.message}. Os clientes sem
          consumo neste mês podem estar faltando abaixo.
        </Alert>
      ) : null}

      {/* O total do mês, em destaque. É o número que se olha primeiro. */}
      <Card>
        <CardContent className="flex flex-wrap items-end justify-between gap-4 p-6">
          <div>
            <p className="text-sm text-muted-foreground">Total em {rotuloMes(mes)}</p>
            <p className="mt-1 text-4xl font-semibold tabular-nums">{usd.format(total)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {comConsumo.length} {comConsumo.length === 1 ? 'cliente ativo' : 'clientes ativos'} no
              mês
              {parados.length > 0 ? `, ${parados.length} sem consumo` : ''}
            </p>
          </div>
          <Badge
            variant="outline"
            title="Tokens registrados × tabela de preços vigente na data de cada mensagem. Não é a fatura real da OpenAI."
          >
            Estimativa
          </Badge>
        </CardContent>
      </Card>

      {cards.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Nenhum cliente cadastrado ainda.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => (
            <CardCliente key={c.tenantId} card={c} mesAnterior={mesAnterior} />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        <strong>Estimativa:</strong> tokens registrados × tabela de preços vigente na data de cada
        mensagem. Não é a fatura real da OpenAI, que pode divergir por arredondamento, cache e
        outros serviços. Meses fechados ficam no histórico de cada cliente.
      </p>
    </div>
  );
}

/**
 * Card de um cliente no mês. O card inteiro é o link para o histórico — a
 * investigação começa exatamente quando um número aqui chama atenção.
 */
function CardCliente({ card, mesAnterior }: { card: CardConsumo; mesAnterior: string }) {
  return (
    <Link
      href={`/admin/consumo/${card.tenantId}`}
      className={cn(
        'rounded-2xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/40',
        // Sem consumo continua na lista, mas apagado: sai da atenção sem sair da
        // vista. "Esse cliente parou de usar" também é informação.
        card.semConsumo && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{card.nome}</p>
          {card.deletado ? (
            <Badge variant="secondary" className="mt-1">
              cliente excluído
            </Badge>
          ) : null}
        </div>
        <span className="shrink-0 text-lg font-semibold tabular-nums">{usd.format(card.custo)}</span>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div className="flex gap-1">
          <dt>entrada</dt>
          <dd className="tabular-nums text-foreground">{num.format(card.entrada)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>saída</dt>
          <dd className="tabular-nums text-foreground">{num.format(card.saida)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>embedding</dt>
          <dd className="tabular-nums text-foreground">{num.format(card.embedding)}</dd>
        </div>
      </dl>

      <div className="mt-3 border-t border-border pt-2">
        <LinhaVariacao card={card} mesAnterior={mesAnterior} />
      </div>
    </Link>
  );
}

/** Uma linha discreta; colorida só quando passa do limiar. */
function LinhaVariacao({ card, mesAnterior }: { card: CardConsumo; mesAnterior: string }) {
  const v = card.variacao;
  const rotulo = rotuloMes(mesAnterior);

  if (v.tipo === 'sem-consumo') {
    return <p className="text-xs text-muted-foreground">Sem consumo neste mês nem em {rotulo}.</p>;
  }

  if (v.tipo === 'primeiro-mes') {
    return (
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Primeiro mês com consumo</span> — nada em{' '}
        {rotulo}, então não há variação para calcular.
      </p>
    );
  }

  if (v.tipo === 'parou') {
    return (
      <p className={cn('text-xs', v.destacar ? 'font-medium text-warning' : 'text-muted-foreground')}>
        Sem consumo neste mês — {rotulo} fechou em {usd.format(v.anterior)}.
      </p>
    );
  }

  const subiu = v.delta > 0;
  return (
    <p className={cn('text-xs', v.destacar ? 'font-medium text-warning' : 'text-muted-foreground')}>
      {subiu ? '▲' : '▼'} {pct.format(Math.abs(v.pct))}% vs {rotulo} (
      {usd.format(card.custo - v.delta)})
    </p>
  );
}
