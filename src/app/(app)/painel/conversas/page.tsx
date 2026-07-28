import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

function StatusBadge({ status }: { status: string }) {
  if (status === 'pausado') return <Badge variant="warning">pausado</Badge>;
  if (status === 'resolvido') return <Badge variant="secondary">resolvido</Badge>;
  return <Badge variant="success">ativo</Badge>;
}

function dataCurta(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export default async function PaginaConversas() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  // RLS ja escopa por tenant; filtro explicito por tenant_id como segunda camada.
  const { data: conversas } = await supabase
    .from('conversas')
    .select('conversation_id, contact_name, phone, status, atualizado_em')
    .eq('tenant_id', usuario.tenantId)
    .order('atualizado_em', { ascending: false })
    .limit(200);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Conversas</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Acompanhe o atendimento do agente. Abra uma conversa para ver o histórico ou
          pausar o agente nela.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Atendimentos</CardTitle>
          <CardDescription>
            {conversas && conversas.length > 0
              ? `${conversas.length} conversa(s).`
              : 'Nenhuma conversa ainda.'}
          </CardDescription>
        </CardHeader>
        {conversas && conversas.length > 0 ? (
          <CardContent className="flex flex-col">
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-border pb-2 text-xs font-medium text-muted-foreground">
              <span>Contato</span>
              <span>Situação</span>
              <span className="text-right">Última atividade</span>
            </div>
            {conversas.map((c) => (
              <Link
                key={c.conversation_id}
                href={`/painel/conversas/${c.conversation_id}`}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b border-border py-3 text-sm transition-colors hover:bg-muted/50"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{c.contact_name ?? 'Sem nome'}</span>
                  {c.phone ? (
                    <span className="ml-2 text-muted-foreground">{c.phone}</span>
                  ) : null}
                </span>
                <StatusBadge status={c.status} />
                <span className="text-right text-muted-foreground">
                  {dataCurta(c.atualizado_em)}
                </span>
              </Link>
            ))}
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
