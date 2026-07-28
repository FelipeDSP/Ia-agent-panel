import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

type LinhaVolume = { mes: string; mensagens: number | string; conversas_ativas: number | string };

const num = new Intl.NumberFormat('pt-BR');

function mesLabel(iso: string): string {
  const [ano, mes] = iso.split('-');
  return `${mes}/${ano}`;
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
  const volume = (volumeRaw ?? []) as LinhaVolume[];

  const totalMsg = volume.reduce((a, l) => a + Number(l.mensagens), 0);
  const maxMsg = volume.reduce((a, l) => Math.max(a, Number(l.mensagens)), 0);

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
              ? `${num.format(totalMsg)} mensagem(ns) no total.`
              : 'Ainda sem atividade registrada.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="text-sm text-destructive">Não foi possível carregar o uso.</p>
          ) : volume.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Quando o agente começar a atender, o volume aparece aqui.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {volume.map((l) => {
                const msgs = Number(l.mensagens);
                const pct = maxMsg > 0 ? Math.round((msgs / maxMsg) * 100) : 0;
                return (
                  <div key={l.mes} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="font-medium">{mesLabel(l.mes)}</span>
                      <span className="text-muted-foreground">
                        {num.format(msgs)} mensagens · {num.format(Number(l.conversas_ativas))} conversas
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
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
