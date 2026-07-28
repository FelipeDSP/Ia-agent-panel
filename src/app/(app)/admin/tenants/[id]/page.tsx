import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PromptEditor, type VersaoPrompt } from '@/components/prompt-editor';
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

import {
  BotaoSuspensao,
  FormChatwoot,
  FormConfigSuper,
  FormConvite,
} from './componentes';

export default async function PaginaDetalheTenant({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await exigirSuperAdmin();
  const { id } = await params;

  const supabase = await criarClienteServidor();

  const { data: tenant } = await supabase
    .from('tenants')
    .select(
      'id, nome, slug, ativo, agente_ativo, chatwoot_account_id, chatwoot_url, system_prompt, modelo, temperatura, debounce_segundos',
    )
    .eq('id', id)
    .is('deletado_em', null)
    .maybeSingle();

  if (!tenant) notFound();

  // Histórico de prompt + admins do cliente + conversas recentes, em paralelo.
  const [{ data: versoesRaw }, { data: admins }, { data: conversas }] = await Promise.all([
    supabase
      .from('prompt_versoes')
      .select('id, conteudo, criado_em, criado_por')
      .eq('tenant_id', id)
      .order('criado_em', { ascending: false }),
    supabase
      .from('usuarios_painel')
      .select('nome, email, ativo')
      .eq('tenant_id', id),
    supabase
      .from('conversas')
      .select('conversation_id, contact_name, phone, status, atualizado_em')
      .eq('tenant_id', id)
      .order('atualizado_em', { ascending: false })
      .limit(30),
  ]);

  // Resolve nome do autor de cada versão (poucas linhas; map simples).
  const autores = new Map((admins ?? []).map((a) => [a.email, a.nome]));
  const versoes: VersaoPrompt[] = (versoesRaw ?? []).map((v) => ({
    id: v.id,
    conteudo: v.conteudo,
    criado_em: v.criado_em,
    autor: null, // criado_por é uuid; nome do autor não é crítico aqui
  }));
  void autores;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/admin/tenants"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            ← Clientes
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{tenant.nome}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{tenant.slug}</p>
        </div>
        <div className="flex gap-2">
          <Badge variant={tenant.ativo ? 'success' : 'secondary'}>
            {tenant.ativo ? 'ativo' : 'suspenso'}
          </Badge>
          <Badge variant={tenant.agente_ativo ? 'success' : 'warning'}>
            {tenant.agente_ativo ? 'agente ligado' : 'agente desligado'}
          </Badge>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Prompt</CardTitle>
          <CardDescription>
            Alterações ficam no histórico e podem ser revertidas.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PromptEditor
            tenantId={tenant.id}
            promptAtual={tenant.system_prompt ?? ''}
            versoes={versoes}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Configuração</CardTitle>
            <CardDescription>Modelo, temperatura e debounce — só a agência.</CardDescription>
          </CardHeader>
          <CardContent>
            <FormConfigSuper
              tenantId={tenant.id}
              nome={tenant.nome}
              modelo={tenant.modelo}
              temperatura={Number(tenant.temperatura)}
              debounce={tenant.debounce_segundos}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Chatwoot</CardTitle>
            <CardDescription>
              {tenant.chatwoot_account_id
                ? `Conectado à conta ${tenant.chatwoot_account_id}.`
                : 'Ainda não conectado.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormChatwoot
              tenantId={tenant.id}
              accountId={tenant.chatwoot_account_id}
              url={tenant.chatwoot_url}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Admin do cliente</CardTitle>
            <CardDescription>
              {admins && admins.length > 0
                ? `${admins.length} usuário(s) vinculado(s).`
                : 'Nenhum admin convidado ainda.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {admins && admins.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {admins.map((a) => (
                  <li key={a.email} className="flex items-center justify-between gap-2">
                    <span>
                      {a.nome} <span className="text-muted-foreground">· {a.email}</span>
                    </span>
                    {!a.ativo ? <Badge variant="secondary">inativo</Badge> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <FormConvite tenantId={tenant.id} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Situação</CardTitle>
            <CardDescription>Suspender interrompe o agente.</CardDescription>
          </CardHeader>
          <CardContent>
            <BotaoSuspensao tenantId={tenant.id} ativo={tenant.ativo} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conversas</CardTitle>
          <CardDescription>
            {conversas && conversas.length > 0
              ? `${conversas.length} conversa(s) mais recente(s).`
              : 'Nenhuma conversa ainda.'}
          </CardDescription>
        </CardHeader>
        {conversas && conversas.length > 0 ? (
          <CardContent className="flex flex-col">
            {conversas.map((c) => (
              <div
                key={c.conversation_id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b border-border py-2 text-sm last:border-0"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{c.contact_name ?? 'Sem nome'}</span>
                  {c.phone ? <span className="ml-2 text-muted-foreground">{c.phone}</span> : null}
                </span>
                <Badge
                  variant={
                    c.status === 'pausado' ? 'warning' : c.status === 'resolvido' ? 'secondary' : 'success'
                  }
                >
                  {c.status}
                </Badge>
                <span className="text-right text-xs text-muted-foreground">
                  {c.atualizado_em
                    ? new Date(c.atualizado_em).toLocaleString('pt-BR', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })
                    : '—'}
                </span>
              </div>
            ))}
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
