import { PromptEditor, type VersaoPrompt } from '@/components/prompt-editor';
import { Alert } from '@/components/ui/alert';
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
        <p className="mt-2 text-2xl font-semibold tabular-nums">{valor}</p>
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
      <Alert variant="destructive">Não foi possível carregar os dados do seu cliente.</Alert>
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
    /*
     * Da VIEW e por `status_efetivo` (migracao 51). Com o cru, esta contagem
     * nunca drenava: a lapide mantem 'pausado' gravado depois de a pausa
     * caducar, e o numero so subia. Agora ela significa "em atendimento humano
     * agora", que e a pergunta que o dono realmente faz.
     */
    supabase
      .from('conversas_painel')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', usuario.tenantId)
      .eq('status_efetivo', 'pausado'),
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
          {/* O `slug` saiu: é identificador interno, e o cliente não tem o que
              fazer com ele. */}
          <h1 className="text-2xl font-semibold tracking-tight">{tenant.nome}</h1>
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

      {/*
        O card "Configuração" (Modelo + Debounce) saiu daqui.
        `modelo` é decisão da agência: o cliente não pode mudar e o nome
        (`gpt-4.1-mini`) não significa nada para ele. `debounce` ele PODE mudar,
        e o lugar disso é Configurações — em duplicata e só de leitura, servia
        para confundir sobre onde se mexe.
      */}
    </div>
  );
}
