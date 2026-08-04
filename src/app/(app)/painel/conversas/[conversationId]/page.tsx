import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

import { ControlePausa, LimparMemoria } from './controles';

function dataHora(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export default async function PaginaConversa({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const usuario = await exigirTenantAdmin();
  const { conversationId } = await params;
  const idNum = Number(conversationId);
  if (!Number.isFinite(idNum)) notFound();

  const supabase = await criarClienteServidor();

  // O historico vem por conversa_historico (SECURITY DEFINER): o tenant nao le
  // mensagens_log direto — a tabela tem tokens, que nao podem chegar ao cliente.
  // A funcao devolve so direcao/conteudo/tempo, escopada ao proprio tenant.
  const [{ data: conversa }, { data: mensagensRaw }] = await Promise.all([
    supabase
      .from('conversas')
      .select('conversation_id, contact_name, phone, status')
      .eq('tenant_id', usuario.tenantId)
      .eq('conversation_id', idNum)
      .maybeSingle(),
    supabase.rpc('conversa_historico', { p_conversation_id: idNum }),
  ]);

  const mensagens = (mensagensRaw ?? []) as {
    direcao: string;
    conteudo: string | null;
    criado_em: string;
  }[];

  if (!conversa) notFound();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/painel/conversas"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            ← Conversas
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {conversa.contact_name ?? 'Sem nome'}
          </h1>
          {conversa.phone ? (
            <p className="mt-1 text-sm text-muted-foreground">{conversa.phone}</p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge variant={conversa.status === 'pausado' ? 'warning' : conversa.status === 'resolvido' ? 'secondary' : 'success'}>
            {conversa.status}
          </Badge>
          <ControlePausa conversationId={idNum} statusInicial={conversa.status} />
          <LimparMemoria conversationId={idNum} />
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Histórico</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {mensagens && mensagens.length > 0 ? (
            mensagens.map((m, i) => {
              const daAgente = m.direcao === 'saida';
              return (
                <div
                  key={`${m.criado_em}-${i}`}
                  className={`flex flex-col gap-1 ${daAgente ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[75%] rounded-lg border px-3 py-2 text-sm ${
                      daAgente
                        ? 'border-primary/20 bg-primary/15 text-foreground'
                        : 'border-border bg-muted text-foreground'
                    }`}
                  >
                    {m.conteudo ?? <span className="italic text-muted-foreground">(sem conteúdo)</span>}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {daAgente ? 'Agente' : 'Contato'} · {dataHora(m.criado_em)}
                  </span>
                </div>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground">Nenhuma mensagem registrada nesta conversa.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
