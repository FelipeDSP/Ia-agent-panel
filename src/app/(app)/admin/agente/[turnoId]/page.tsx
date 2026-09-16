import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { exigirSuperAdmin } from '@/lib/auth';
import {
  corDoStatus,
  corDoVeredito,
  duracaoMs,
  formatarDuracao,
  jsonBonito,
  linhaDoPasso,
  type PassoLinha,
  type TurnoLinha,
} from '@/lib/agente/trace';
import { criarClienteServidor } from '@/lib/supabase/server';

/**
 * UM turno, passo a passo — o equivalente a abrir uma execução no n8n.
 *
 * Cada passo mostra o resumo (o que importa daquele tipo) e, dobrado, a
 * entrada e a saída como o serviço gravou (já truncadas na escrita, migração
 * 62 §6 — aqui não se corta de novo). Chave nenhuma passa por aqui: as tools
 * não a gravam no trace (a de pagamento remove `api_key` antes).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hora = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Porto_Velho' });
const num = new Intl.NumberFormat('pt-BR');

const COR_TIPO: Record<string, string> = {
  entrada: 'bg-muted text-muted-foreground',
  memoria: 'bg-muted text-muted-foreground',
  registro: 'bg-muted text-muted-foreground',
  modelo: 'bg-primary/10 text-primary',
  tool: 'bg-warning/10 text-warning',
  portao: 'bg-success/10 text-success',
  envio: 'bg-primary/10 text-primary',
  falha: 'bg-destructive/10 text-destructive',
};

export default async function PaginaTurno({ params }: { params: Promise<{ turnoId: string }> }) {
  await exigirSuperAdmin();
  const { turnoId } = await params;
  if (!UUID.test(turnoId)) notFound();
  const supabase = await criarClienteServidor();

  const [{ data: turno, error }, { data: passosRaw }] = await Promise.all([
    supabase.from('agente_turnos').select('*').eq('id', turnoId).maybeSingle(),
    supabase.from('agente_passos').select('id, turno_id, ordem, tipo, nome, entrada, saida, erro, duracao_ms, criado_em').eq('turno_id', turnoId).order('ordem'),
  ]);
  if (!turno) notFound();
  const t = turno as TurnoLinha & { prompt_hash: string | null; fila_id: string | null };
  const passos = (passosRaw ?? []) as PassoLinha[];
  const { data: tenant } = await supabase.from('tenants').select('nome, slug').eq('id', t.tenant_id).maybeSingle();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href="/admin/agente" className="text-sm text-muted-foreground underline-offset-4 hover:underline">← Turnos</Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Turno {t.id.slice(0, 8)}</h1>
          <Badge variant={corDoStatus(t.status)}>{t.status}</Badge>
          {t.portao_veredito ? <Badge variant={corDoVeredito(t.portao_veredito)}>portão: {t.portao_veredito}</Badge> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {tenant?.slug ?? t.tenant_id} · conversa {String(t.conversation_id)} · {hora.format(new Date(t.iniciado_em))} · {formatarDuracao(duracaoMs(t))}
        </p>
      </header>

      {error ? <Alert variant="destructive">{error.message}</Alert> : null}
      {t.erro ? <Alert variant="destructive"><span className="font-mono text-xs">{t.erro}</span></Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Ação / perfil', `${t.acao ?? '—'} / ${t.perfil ?? '—'}`],
          ['Modelo', `${t.modelo ?? '—'} · ${t.chamadas_modelo ?? 0} chamada(s)`],
          ['Tokens (entrada / saída)', `${num.format(t.usage_entrada ?? 0)} / ${num.format(t.usage_saida ?? 0)}`],
          ['Prompt', t.prompt_hash ? t.prompt_hash.slice(0, 19) + '…' : '—'],
        ].map(([rotulo, valor]) => (
          <Card key={rotulo}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{rotulo}</p>
              <p className="mt-1 truncate text-sm font-medium tabular-nums" title={valor}>{valor}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <ol className="divide-y">
            {passos.length === 0 ? (
              <li className="py-10 text-center text-muted-foreground">Sem passos gravados (retenção de {'>'}30 dias, ou turno aberto).</li>
            ) : passos.map((p) => (
              <li key={p.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{p.ordem}</span>
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${COR_TIPO[p.tipo] ?? 'bg-muted'}`}>{p.tipo}</span>
                  <span className="font-mono text-sm">{p.nome}</span>
                  {p.duracao_ms !== null ? <span className="text-xs tabular-nums text-muted-foreground">{formatarDuracao(p.duracao_ms)}</span> : null}
                </div>
                <p className={`mt-1 whitespace-pre-wrap pl-8 text-sm ${p.erro ? 'text-destructive' : ''}`}>{linhaDoPasso(p)}</p>
                {(p.entrada !== null && p.entrada !== undefined) || (p.saida !== null && p.saida !== undefined) ? (
                  <details className="mt-1 pl-8">
                    <summary className="cursor-pointer text-xs text-muted-foreground">entrada / saída</summary>
                    <div className="mt-2 grid gap-2 lg:grid-cols-2">
                      <pre className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs">{jsonBonito(p.entrada) || '—'}</pre>
                      <pre className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs">{jsonBonito(p.saida) || '—'}</pre>
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
