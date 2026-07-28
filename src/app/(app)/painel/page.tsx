import { PromptEditor, type VersaoPrompt } from '@/components/prompt-editor';
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

function Metrica({ rotulo, valor }: { rotulo: string; valor: number | string }) {
  return (
    <Card>
      <CardContent className="p-6">
        <p className="text-sm text-muted-foreground">{rotulo}</p>
        <p className="mt-2 text-3xl font-semibold tabular-nums">{valor}</p>
      </CardContent>
    </Card>
  );
}

export default async function PaginaPainel() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  /*
   * O `.eq('id', usuario.tenantId)` e redundante com o RLS de proposito.
   * CLAUDE.md regra 6: RLS e a rede de seguranca, nao a primeira linha de
   * defesa. E o tenantId vem do JWT (exigirTenantAdmin), nunca da URL.
   */
  const { data: tenant } = await supabase
    .from('tenants')
    .select('nome, slug, ativo, agente_ativo, modelo, debounce_segundos, system_prompt')
    .eq('id', usuario.tenantId)
    .maybeSingle();

  if (!tenant) {
    return (
      <div className="text-sm text-destructive">
        Não foi possível carregar os dados do seu cliente.
      </div>
    );
  }

  const [documentos, conversas, conversasPausadas, versoesRaw] = await Promise.all([
    supabase
      .from('kb_documentos')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', usuario.tenantId)
      .is('deletado_em', null),
    supabase
      .from('conversas')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', usuario.tenantId),
    supabase
      .from('conversas')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', usuario.tenantId)
      .eq('status', 'pausado'),
    supabase
      .from('prompt_versoes')
      .select('id, conteudo, criado_em')
      .eq('tenant_id', usuario.tenantId)
      .order('criado_em', { ascending: false }),
  ]);

  const versoes: VersaoPrompt[] = (versoesRaw.data ?? []).map((v) => ({
    id: v.id,
    conteudo: v.conteudo,
    criado_em: v.criado_em,
    autor: null,
  }));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{tenant.nome}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{tenant.slug}</p>
        </div>
        <div className="flex gap-2">
          <Badge variant={tenant.agente_ativo ? 'success' : 'warning'}>
            {tenant.agente_ativo ? 'agente ativo' : 'agente desligado'}
          </Badge>
          {!tenant.ativo ? <Badge variant="secondary">conta suspensa</Badge> : null}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Metrica rotulo="Documentos na base" valor={documentos.count ?? 0} />
        <Metrica rotulo="Conversas" valor={conversas.count ?? 0} />
        <Metrica rotulo="Conversas pausadas" valor={conversasPausadas.count ?? 0} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Prompt do agente</CardTitle>
          <CardDescription>
            Edite e salve. Cada alteração fica no histórico e pode ser revertida.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PromptEditor
            tenantId={usuario.tenantId}
            promptAtual={tenant.system_prompt ?? ''}
            versoes={versoes}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configuração</CardTitle>
          <CardDescription>Modelo e temperatura são definidos pela agência.</CardDescription>
        </CardHeader>
        {/*
          Rotulo em cima, valor embaixo. Com justify-between numa coluna larga o
          par fica nas duas pontas e a relacao entre eles se perde.
        */}
        <CardContent>
          <dl className="grid gap-6 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Modelo</dt>
              <dd className="mt-1 font-medium">{tenant.modelo}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Debounce</dt>
              <dd className="mt-1 font-medium">{tenant.debounce_segundos}s</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
