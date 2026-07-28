import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirSuperAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

import { FormularioPreco } from './formulario-preco';

type LinhaConsumo = {
  tenant_id: string;
  tenant_nome: string;
  mes: string;
  tokens_entrada: number | string;
  tokens_saida: number | string;
  tokens_embedding: number | string;
  custo_usd: number | string;
};

// NUMERIC e BIGINT chegam do PostgREST como string (adendo §5). Converter sempre
// antes de formatar ou somar.
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const num = new Intl.NumberFormat('pt-BR');

function mesLabel(iso: string): string {
  const [ano, mes] = iso.split('-');
  return `${mes}/${ano}`;
}

export default async function PaginaConsumoAdmin() {
  await exigirSuperAdmin();
  const supabase = await criarClienteServidor();

  const [{ data: consumoRaw, error }, { data: precos }] = await Promise.all([
    supabase.rpc('billing_consumo_mensal'),
    supabase
      .from('precos_modelo')
      .select('modelo, vigente_desde, usd_entrada_por_1m, usd_saida_por_1m, usd_embedding_por_1m')
      .order('modelo')
      .order('vigente_desde', { ascending: false }),
  ]);

  const consumo = (consumoRaw ?? []) as LinhaConsumo[];
  const custoTotal = consumo.reduce((acc, l) => acc + Number(l.custo_usd), 0);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Consumo de IA</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tokens e custo estimado por cliente e mês. Ferramenta interna da agência.
        </p>
      </header>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Custo por cliente / mês</CardTitle>
              <CardDescription>
                Total no período: <span className="font-medium text-foreground">{usd.format(custoTotal)}</span>
              </CardDescription>
            </div>
            <Badge variant="outline" title="Tokens registrados × tabela de preços. Não é a fatura real da OpenAI.">
              Estimativa
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error ? (
            <p className="text-sm text-destructive">Não foi possível carregar o consumo: {error.message}</p>
          ) : consumo.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Sem consumo registrado ainda. Os tokens começam a aparecer quando o agente responder
              (o n8n grava tokens em cada resposta) e quando houver ingestão de documentos.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                    <th className="pb-2 pr-4">Mês</th>
                    <th className="pb-2 pr-4">Cliente</th>
                    <th className="pb-2 pr-4 text-right">Tokens entrada</th>
                    <th className="pb-2 pr-4 text-right">Tokens saída</th>
                    <th className="pb-2 pr-4 text-right">Tokens embedding</th>
                    <th className="pb-2 text-right">Custo (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {consumo.map((l) => (
                    <tr key={`${l.tenant_id}-${l.mes}`} className="border-b border-border">
                      <td className="py-2 pr-4">{mesLabel(l.mes)}</td>
                      <td className="py-2 pr-4">{l.tenant_nome}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{num.format(Number(l.tokens_entrada))}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{num.format(Number(l.tokens_saida))}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{num.format(Number(l.tokens_embedding))}</td>
                      <td className="py-2 text-right font-medium tabular-nums">{usd.format(Number(l.custo_usd))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            <strong>Estimativa:</strong> tokens registrados × tabela de preços vigente na data de cada
            mensagem. Não é a fatura real da OpenAI, que pode divergir por arredondamento, cache e
            outros serviços.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tabela de preços</CardTitle>
          <CardDescription>
            Preços da OpenAI por 1M de tokens, em USD. Versionados por data de vigência — o
            histórico é calculado com o preço da época.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {precos && precos.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                    <th className="pb-2 pr-4">Modelo</th>
                    <th className="pb-2 pr-4">Vigente desde</th>
                    <th className="pb-2 pr-4 text-right">Entrada</th>
                    <th className="pb-2 pr-4 text-right">Saída</th>
                    <th className="pb-2 text-right">Embedding</th>
                  </tr>
                </thead>
                <tbody>
                  {precos.map((p) => (
                    <tr key={`${p.modelo}-${p.vigente_desde}`} className="border-b border-border">
                      <td className="py-2 pr-4 font-medium">{p.modelo}</td>
                      <td className="py-2 pr-4">
                        {new Date(p.vigente_desde).toLocaleDateString('pt-BR')}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {p.usd_entrada_por_1m != null ? usd.format(Number(p.usd_entrada_por_1m)) : '—'}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {p.usd_saida_por_1m != null ? usd.format(Number(p.usd_saida_por_1m)) : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {p.usd_embedding_por_1m != null ? usd.format(Number(p.usd_embedding_por_1m)) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nenhum preço cadastrado.</p>
          )}

          <div className="border-t border-border pt-4">
            <p className="mb-3 text-sm font-medium">Nova vigência</p>
            <FormularioPreco />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
