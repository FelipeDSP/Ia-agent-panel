import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { exigirSuperAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { REGISTRO_TOOLS, TOOLS_BASELINE } from '@/lib/tools/registro';

import { ListaCatalogo, type ToolCatalogo } from './componentes';

/**
 * O catálogo de tools — DERIVADO DO CÓDIGO.
 *
 * Até 16/09/2026 esta tela deixava "criar tool" com nome, descrição "que
 * ensina a IA quando usar" e `workflow_id` do n8n. Nada disso criava
 * capacidade: a descrição nunca chegou ao modelo (os nós do n8n tinham
 * `description` fixa, e o código porta essas strings), o `workflow_id` estava
 * nulo em todas as linhas, e criar a linha sem o código produzia um módulo que
 * o cliente podia contratar e não fazia nada.
 *
 * Agora a fonte é `REGISTRO_TOOLS` (src/lib/tools/registro.ts) — a mesma que o
 * painel do cliente usa para menu e Módulos. `catalogo_tools` continua
 * existindo porque as funções do banco (`api_n8n_tools_ativas`,
 * `api_n8n_config_tool`) a leem; a linha é criada pela MIGRAÇÃO que traz a
 * tool (como a 61 fez para `pagamento`), e `teste:catalogo-derivado` acusa se
 * o registry e a tabela divergirem. O que a agência ainda decide aqui é
 * `ativo`: tirar um módulo de circulação sem apagar contratação de ninguém.
 */
export default async function PaginaCatalogo() {
  await exigirSuperAdmin();
  const supabase = await criarClienteServidor();

  const [{ data: catalogo, error }, { data: usos }] = await Promise.all([
    supabase.from('catalogo_tools').select('tool_nome, ativo, tipo').order('tool_nome'),
    supabase.from('tenant_tools').select('tool_nome, contratado'),
  ]);

  const emUso = new Map<string, number>();
  for (const l of usos ?? []) if (l.contratado) emUso.set(l.tool_nome, (emUso.get(l.tool_nome) ?? 0) + 1);
  const linhaDb = new Map((catalogo ?? []).map((c) => [c.tool_nome, c]));

  const tools: ToolCatalogo[] = Object.values(REGISTRO_TOOLS).map((d) => ({
    tool_nome: d.nome,
    rotulo: d.rotulo,
    resumo: d.resumo,
    tipo: d.tipo ?? 'tool_modelo',
    baseline: (TOOLS_BASELINE as readonly string[]).includes(d.nome),
    contratavel: d.contratavel === true,
    desligavel: d.desligavel === true,
    temConfigCliente: d.temConfigCliente,
    rotas: (d.rotasPainel ?? []).map((r) => r.href),
    noBanco: linhaDb.has(d.nome),
    ativo: linhaDb.get(d.nome)?.ativo ?? false,
    emUso: emUso.get(d.nome) ?? 0,
  }));
  const soNoBanco = (catalogo ?? []).filter((c) => !REGISTRO_TOOLS[c.tool_nome]).map((c) => c.tool_nome);
  const soNoCodigo = tools.filter((t) => !t.noBanco).map((t) => t.tool_nome);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Catálogo de tools</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          O que o agente sabe fazer, lido do código. Uma tool nova é código (<code>agente/src/tools/</code> + funções no
          banco + seção do prompt); a migração que a traz cria a linha aqui. Nesta tela a agência só decide o que está
          em circulação para contratar.
        </p>
      </header>

      {error ? <Alert variant="destructive">Não foi possível ler o catálogo: {error.message}</Alert> : null}
      {soNoBanco.length > 0 ? (
        <Alert variant="warning">
          No banco há tool que o código não conhece: <code>{soNoBanco.join(', ')}</code>. Contratá-la não faz nada — remova a linha ou traga o código.
        </Alert>
      ) : null}
      {soNoCodigo.length > 0 ? (
        <Alert variant="warning">
          O código conhece tool sem linha no banco: <code>{soNoCodigo.join(', ')}</code>. As funções do banco não a listam para nenhum tenant — falta a migração.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Tools</CardTitle>
          <CardDescription>
            “Oculta” tira o módulo da oferta sem descontratar quem já tem. Contratar/descontratar é na página de cada cliente.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ListaCatalogo tools={tools} />
        </CardContent>
      </Card>
    </div>
  );
}
