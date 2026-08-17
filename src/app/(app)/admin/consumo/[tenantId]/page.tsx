import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { exigirSuperAdmin } from '@/lib/auth';
import {
  formatarUsd,
  historicoDoTenant,
  mesCorrente,
  rotuloMes,
  type LinhaConsumo,
} from '@/lib/billing/consumo';
import { criarClienteServidor } from '@/lib/supabase/server';

/**
 * Histórico de consumo de UM cliente — a pergunta de investigação.
 *
 * Só se chega aqui clicando num card do mês, que é quando a pergunta "quanto
 * esse cliente custa?" de fato é feita. Na tela anterior ela dividia a tabela
 * com a pergunta do mês corrente e nenhuma das duas era respondida.
 *
 * SEM QUERY NOVA. `billing_consumo_mensal()` já devolve tenant × mês com o
 * breakdown; o filtro por tenant é feito aqui em memória. Trazer a RPC inteira
 * para exibir um cliente é aceitável na ordem de grandeza de hoje (uma linha
 * por cliente por mês, dezenas ao todo) e evita uma migração para um parâmetro
 * de tenant que a função não tem — e, pelo aviso do CLAUDE.md sobre aridade,
 * acrescentar parâmetro com DEFAULT a uma função viva exige `drop function` da
 * assinatura antiga. Não vale por uma tela de leitura.
 */

const num = new Intl.NumberFormat('pt-BR');

/** Coluna `uuid`: um id malformado vira erro 22P02 do Postgres, não 404. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PaginaConsumoDoTenant({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  await exigirSuperAdmin();
  const { tenantId } = await params;
  if (!UUID.test(tenantId)) notFound();

  const supabase = await criarClienteServidor();

  const [{ data: tenant }, { data: consumoRaw, error }] = await Promise.all([
    // Sem filtro de `deletado_em`: o custo de um cliente já excluído continua
    // sendo custo que a agência pagou, e some da tela principal justamente
    // quando alguém quer conferir de onde veio.
    supabase.from('tenants').select('id, nome, slug, deletado_em').eq('id', tenantId).maybeSingle(),
    supabase.rpc('billing_consumo_mensal'),
  ]);

  if (!tenant) notFound();

  const linhas = (consumoRaw ?? []) as LinhaConsumo[];
  const historico = historicoDoTenant(linhas, tenantId, mesCorrente(new Date()));
  const totalAcumulado = historico.reduce((acc, m) => acc + m.custo, 0);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/admin/consumo"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Consumo do mês
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{tenant.nome}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Histórico de consumo mês a mês. {tenant.slug}
            </p>
          </div>
          {/*
            O link só existe para cliente VIVO. `/admin/tenants/[id]` filtra
            `deletado_em` e chama `notFound()`, então em cliente excluído este
            link era um 404 garantido — e só aparecia clicando, porque nenhum
            teste navega. Excluído mostra o badge e nada mais: não há tela de
            configuração para quem não está mais lá.
          */}
          <div className="flex flex-wrap items-center gap-2">
            {tenant.deletado_em ? (
              <Badge variant="secondary">cliente excluído</Badge>
            ) : (
              <Link
                href={`/admin/tenants/${tenantId}`}
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                Configurações do cliente
              </Link>
            )}
          </div>
        </div>
      </header>

      {error ? (
        <Alert variant="destructive">Não foi possível carregar o consumo: {error.message}</Alert>
      ) : null}

      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">Acumulado desde o primeiro consumo</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">{formatarUsd(totalAcumulado)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {historico.length} {historico.length === 1 ? 'mês' : 'meses'} de histórico. O mês
            corrente ({rotuloMes(mesCorrente(new Date()))}) ainda está em curso.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mês</TableHead>
                <TableHead className="text-right">Entrada</TableHead>
                <TableHead className="text-right">Saída</TableHead>
                <TableHead className="text-right">Embedding</TableHead>
                <TableHead className="text-right">Custo (USD)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {historico.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    Este cliente ainda não registrou consumo. Os tokens aparecem quando o agente
                    responde e quando há ingestão de documentos.
                  </TableCell>
                </TableRow>
              ) : (
                historico.map((m) => {
                  // Mês preenchido com zero: existe no meio do histórico, mas
                  // não houve movimento. Apagado, como na tela do mês.
                  const parado = m.custo === 0 && m.entrada + m.saida + m.embedding === 0;
                  return (
                    <TableRow key={m.mes} className={parado ? 'opacity-60' : undefined}>
                      <TableCell className="font-medium">{rotuloMes(m.mes)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {num.format(m.entrada)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{num.format(m.saida)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {num.format(m.embedding)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatarUsd(m.custo)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        <strong>Estimativa:</strong> tokens registrados × tabela de preços vigente na data de cada
        mensagem. Mês sem linha na tabela é mês sem consumo, não mês sem dado.
      </p>
    </div>
  );
}
