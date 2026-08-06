import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { exigirSuperAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

import { FormNovaTool, ListaCatalogo, type ToolCatalogo } from './componentes';

export default async function PaginaCatalogo() {
  await exigirSuperAdmin();
  const supabase = await criarClienteServidor();

  const [{ data: catalogo }, { data: usos }] = await Promise.all([
    supabase
      .from('catalogo_tools')
      .select('tool_nome, nome_exibicao, descricao_padrao, workflow_id_padrao, schema_config, ativo')
      .order('tool_nome'),
    // Quantos tenants usam cada tool (super vê tudo por RLS). Contagem em JS:
    // tabela pequena, evita RPC de group by.
    supabase.from('tenant_tools').select('tool_nome'),
  ]);

  const usoPorTool = new Map<string, number>();
  for (const linha of usos ?? []) {
    usoPorTool.set(linha.tool_nome, (usoPorTool.get(linha.tool_nome) ?? 0) + 1);
  }

  const tools: ToolCatalogo[] = (catalogo ?? []).map((c) => ({
    tool_nome: c.tool_nome,
    nome_exibicao: c.nome_exibicao,
    descricao_padrao: c.descricao_padrao,
    workflow_id_padrao: c.workflow_id_padrao,
    schema_config: c.schema_config,
    ativo: c.ativo,
    emUso: usoPorTool.get(c.tool_nome) ?? 0,
  }));

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Catálogo de tools</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          As capacidades que a agência pode contratar por cliente. Provisionar uma tool nova =
          criar aqui + um sub-workflow no n8n; depois é só contratar na página do cliente.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Tools no catálogo</CardTitle>
          <CardDescription>
            Uma tool em uso por clientes não pode ser removida; deixe-a “oculta” para parar de
            oferecê-la.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ListaCatalogo tools={tools} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Nova tool</CardTitle>
          <CardDescription>
            O <code>tool_nome</code> é o identificador que o n8n usa e não muda depois de criado.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormNovaTool />
        </CardContent>
      </Card>
    </div>
  );
}
