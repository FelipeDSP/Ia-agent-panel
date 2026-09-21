import Link from 'next/link';

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
  HORAS_PERMITIDAS,
  corDoStatus,
  corDoVeredito,
  desde,
  duracaoMs,
  formatarDuracao,
  lerFiltros,
  resumo,
  type PassoLinha,
  type TurnoLinha,
} from '@/lib/agente/trace';
import { criarClienteServidor } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

/**
 * Os turnos do agente — a tela de "execuções" e o
 * código não tinha até aqui. Cada linha é uma resposta; clicar abre os passos.
 *
 * Só super_admin: a agência olha todos os tenants para diagnosticar. O que a
 * RLS da 62 já garante (tenant só vê o seu) não é repetido aqui. O limite é
 * 200 turnos por página de filtro — com mais do que isso a pergunta muda e
 * quem responde é o `diff:custo` ou SQL.
 */

const num = new Intl.NumberFormat('pt-BR');
const hora = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Porto_Velho' });

export default async function PaginaAgenteAdmin({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await exigirSuperAdmin();
  const filtros = lerFiltros(await searchParams);
  const supabase = await criarClienteServidor();

  let q = supabase
    .from('agente_turnos')
    .select('id, tenant_id, conversation_id, acao, perfil, modelo, status, usage_entrada, usage_saida, chamadas_modelo, tools_chamadas, portao_veredito, erro, iniciado_em, concluido_em')
    .gte('iniciado_em', desde(filtros.horas))
    .order('iniciado_em', { ascending: false })
    .limit(200);
  if (filtros.tenantId) q = q.eq('tenant_id', filtros.tenantId);
  if (filtros.status) q = q.eq('status', filtros.status);
  if (filtros.conversa !== null) q = q.eq('conversation_id', filtros.conversa);

  const [{ data: turnosRaw, error }, { data: tenantsRaw }] = await Promise.all([
    q,
    supabase.from('tenants').select('id, nome, slug').is('deletado_em', null).order('nome'),
  ]);
  const turnos = (turnosRaw ?? []) as TurnoLinha[];
  const tenants = (tenantsRaw ?? []) as Array<{ id: string; nome: string; slug: string }>;
  const nomeDoTenant = new Map(tenants.map((t) => [t.id, t.slug]));

  // As tools por turno, numa query só (os passos `tool` dos turnos listados).
  const ids = turnos.map((t) => t.id);
  const { data: passosRaw } = ids.length
    ? await supabase.from('agente_passos').select('turno_id, tipo, nome, ordem').in('turno_id', ids).eq('tipo', 'tool').order('ordem')
    : { data: [] as Pick<PassoLinha, 'turno_id' | 'tipo' | 'nome' | 'ordem'>[] };
  const toolsPorTurno = new Map<string, string[]>();
  for (const p of (passosRaw ?? []) as Array<{ turno_id: string; nome: string }>) {
    toolsPorTurno.set(p.turno_id, [...(toolsPorTurno.get(p.turno_id) ?? []), p.nome]);
  }

  const r = resumo(turnos);
  const link = (mud: Partial<{ tenant: string | null; status: string | null; horas: number; conversa: number | null }>) => {
    const p = new URLSearchParams();
    const tenant = mud.tenant === undefined ? filtros.tenantId : mud.tenant;
    const status = mud.status === undefined ? filtros.status : mud.status;
    const horas = mud.horas ?? filtros.horas;
    const conversa = mud.conversa === undefined ? filtros.conversa : mud.conversa;
    if (tenant) p.set('tenant', tenant);
    if (status) p.set('status', status);
    if (tenant && conversa) p.set('conversa', String(conversa));
    p.set('horas', String(horas));
    return `/admin/agente?${p.toString()}`;
  };
  const chip = (ativo: boolean) => cn('rounded-full border px-3 py-1 text-xs', ativo ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted');

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Agente — turnos</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cada linha é uma resposta do agente em código. Abra um turno para ver os passos: prompt, chamadas ao modelo, ferramentas, portão, envio.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Período:</span>
          {HORAS_PERMITIDAS.map((h) => (
            <Link key={h} href={link({ horas: h })} className={chip(filtros.horas === h)}>
              {h < 24 ? `${h} h` : `${h / 24} d`}
            </Link>
          ))}
          <span className="ml-3 text-xs text-muted-foreground">Estado:</span>
          <Link href={link({ status: null })} className={chip(filtros.status === null)}>todos</Link>
          {(['ok', 'falhou', 'descartado', 'aberto'] as const).map((s) => (
            <Link key={s} href={link({ status: s })} className={chip(filtros.status === s)}>{s}</Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Cliente:</span>
          <Link href={link({ tenant: null })} className={chip(filtros.tenantId === null)}>todos</Link>
          {tenants.map((t) => (
            <Link key={t.id} href={link({ tenant: t.id })} className={chip(filtros.tenantId === t.id)} title={t.nome}>
              {t.slug}
            </Link>
          ))}
        </div>
      </div>

      {filtros.conversa !== null ? (
        <p className="text-sm">
          Só a conversa <span className="font-medium tabular-nums">{filtros.conversa}</span>.{' '}
          <Link href={link({ conversa: null })} className="text-primary underline-offset-4 hover:underline">ver todas</Link>
        </p>
      ) : null}
      {error ? <Alert variant="destructive">Não foi possível carregar os turnos: {error.message}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ['Turnos', num.format(r.total)],
          ['OK', num.format(r.ok)],
          ['Falharam', num.format(r.falhou)],
          ['Barrados pelo portão', num.format(r.barrados)],
          ['Tokens', num.format(r.tokens)],
        ].map(([rotulo, valor]) => (
          <Card key={rotulo}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{rotulo}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{valor}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quando</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Conversa</TableHead>
                <TableHead>Ação</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Portão</TableHead>
                <TableHead>Ferramentas</TableHead>
                <TableHead className="text-right">Modelo</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Duração</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {turnos.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                    Nenhum turno no período com esses filtros.
                  </TableCell>
                </TableRow>
              ) : turnos.map((t) => (
                <TableRow key={t.id} className={t.status === 'falhou' ? 'bg-destructive/5' : undefined}>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    <Link href={`/admin/agente/${t.id}`} className="text-primary underline-offset-4 hover:underline">
                      {hora.format(new Date(t.iniciado_em))}
                    </Link>
                  </TableCell>
                  <TableCell>{nomeDoTenant.get(t.tenant_id) ?? t.tenant_id.slice(0, 8)}</TableCell>
                  <TableCell className="tabular-nums">
                    <Link href={link({ tenant: t.tenant_id, conversa: Number(t.conversation_id) })} className="underline-offset-4 hover:underline" title="só esta conversa">
                      {String(t.conversation_id)}
                    </Link>
                  </TableCell>
                  <TableCell>{t.acao ?? '—'}</TableCell>
                  <TableCell><Badge variant={corDoStatus(t.status)}>{t.status}</Badge></TableCell>
                  <TableCell>{t.portao_veredito ? <Badge variant={corDoVeredito(t.portao_veredito)}>{t.portao_veredito}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="max-w-[16rem] truncate text-xs" title={(toolsPorTurno.get(t.id) ?? []).join(', ')}>
                    {(toolsPorTurno.get(t.id) ?? []).join(', ') || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{t.chamadas_modelo ?? 0}×</TableCell>
                  <TableCell className="text-right tabular-nums">{num.format((t.usage_entrada ?? 0) + (t.usage_saida ?? 0))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatarDuracao(duracaoMs(t))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
