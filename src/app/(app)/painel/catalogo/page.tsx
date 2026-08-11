import { Alert } from '@/components/ui/alert';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';

import { GestaoCatalogo, type Produto } from './componentes';

export default async function PaginaCatalogo() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  // Filtro explícito por tenant além da RLS: as duas camadas, como manda a
  // regra 6 do CLAUDE.md. `deletado_em is null` porque a exclusão é soft.
  const { data, error } = await supabase
    .from('produtos')
    .select('id, nome, descricao, preco_centavos, unidade, sku, estoque, disponivel')
    .eq('tenant_id', usuario.tenantId)
    .is('deletado_em', null)
    .order('nome', { ascending: true });

  if (error) {
    return <Alert variant="destructive">Não foi possível carregar o catálogo.</Alert>;
  }

  const produtos: Produto[] = (data ?? []).map((p) => ({
    id: p.id as string,
    nome: p.nome as string,
    descricao: (p.descricao as string | null) ?? null,
    // Centavos param aqui: daqui para a tela, só passa por centavosParaReais /
    // formatarBRL. Nenhum componente recebe valor em reais como número.
    precoCentavos: p.preco_centavos as number,
    unidade: p.unidade as string,
    sku: (p.sku as string | null) ?? null,
    estoque: (p.estoque as number | null) ?? null,
    disponivel: p.disponivel as boolean,
  }));

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Catálogo</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          O que você vende, com preço e unidade. Por enquanto o catálogo é seu registro —
          o agente ainda não usa estes itens para vender.
        </p>
      </header>

      <GestaoCatalogo produtosIniciais={produtos} />
    </div>
  );
}
