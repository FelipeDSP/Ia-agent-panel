import { Minus, TrendingDown, TrendingUp } from 'lucide-react';

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
import { cn } from '@/lib/utils';

type LinhaVolume = { mes: string; mensagens: number | string; conversas_ativas: number | string };

const num = new Intl.NumberFormat('pt-BR');

// A RPC devolve `mes` como date do primeiro dia do mês (ex.: "2026-07-01").
function mesLabel(iso: string): string {
  const [ano, mes] = iso.split('-');
  return `${mes}/${ano}`;
}

const NOMES_MES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
function mesNome(iso: string): string {
  const mes = Number(iso.split('-')[1]);
  return NOMES_MES[mes - 1] ?? mesLabel(iso);
}

/**
 * Tendência do mês contra o mês anterior. Substitui a barra relativa (que sem
 * escala parecia uma cota): mostra explicitamente quanto o volume subiu ou caiu.
 * Verde = subiu, vermelho = caiu, cinza = estável — leitura de variação, não de
 * "bom/ruim".
 */
function Tendencia({
  atual,
  anterior,
  mesAnteriorIso,
}: {
  atual: number;
  anterior: number | null;
  mesAnteriorIso: string | null;
}) {
  if (anterior === null || mesAnteriorIso === null) {
    return <span className="text-xs text-muted-foreground">primeiro mês registrado</span>;
  }

  const refMes = mesNome(mesAnteriorIso);

  // Veio do zero: qualquer volume é "novo", sem porcentagem que faça sentido.
  if (anterior === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <TrendingUp className="h-3.5 w-3.5" aria-hidden /> novo volume vs. {refMes}
      </span>
    );
  }

  const delta = Math.round(((atual - anterior) / anterior) * 100);

  if (delta === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Minus className="h-3.5 w-3.5" aria-hidden /> estável vs. {refMes}
      </span>
    );
  }

  const subiu = delta > 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        subiu ? 'text-success' : 'text-destructive',
      )}
    >
      {subiu ? (
        <TrendingUp className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <TrendingDown className="h-3.5 w-3.5" aria-hidden />
      )}
      {subiu ? '+' : ''}
      {delta}% vs. {refMes}
    </span>
  );
}

/**
 * Consumo do cliente: SÓ volume. A função billing_volume_mensal não devolve
 * token nem custo — a base de custo da agência não chega ao browser do cliente.
 * A tela do custo em USD é exclusiva do super admin (/admin/consumo).
 */
export default async function PaginaConsumoTenant() {
  await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  const { data: volumeRaw, error } = await supabase.rpc('billing_volume_mensal');
  // A RPC ordena por mês desc (mais recente primeiro). Mantemos assim: o mês
  // corrente aparece no topo e a comparação é sempre contra a linha seguinte.
  const volume = (volumeRaw ?? []) as LinhaVolume[];

  const totalMsg = volume.reduce((a, l) => a + Number(l.mensagens), 0);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Uso</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Volume de atendimento do seu agente ao longo do tempo.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Atividade por mês</CardTitle>
          <CardDescription>
            {totalMsg > 0
              ? `${num.format(totalMsg)} mensagem(ns) no total. Cada mês é comparado com o anterior.`
              : 'Ainda sem atividade registrada.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <Alert variant="destructive">Não foi possível carregar o uso.</Alert>
          ) : volume.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Quando o agente começar a atender, o volume aparece aqui.
            </p>
          ) : (
            <div className="flex flex-col">
              {volume.map((l, i) => {
                const msgs = Number(l.mensagens);
                // Próxima linha é o mês anterior (lista em ordem decrescente).
                const proxima = volume[i + 1];
                const anterior = proxima ? Number(proxima.mensagens) : null;

                return (
                  <div
                    key={l.mes}
                    className="flex items-center justify-between gap-4 border-b border-border py-4 last:border-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium capitalize">{mesNome(l.mes)}</p>
                      <p className="text-xs text-muted-foreground">
                        {num.format(Number(l.conversas_ativas))} conversa(s) ativa(s)
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-0.5">
                      <p className="text-2xl font-semibold tabular-nums leading-none">
                        {num.format(msgs)}
                      </p>
                      <p className="text-xs text-muted-foreground">mensagens</p>
                      <Tendencia
                        atual={msgs}
                        anterior={anterior}
                        mesAnteriorIso={proxima?.mes ?? null}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
