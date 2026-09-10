import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { temToolContratada } from '@/lib/tools/contratacao';

import { GestaoCategorias, type CategoriaComUso } from './componentes';

/**
 * Categorias do catálogo — criar, renomear, remover.
 *
 * SUPERFÍCIE DE TOOL, e por isso a rota checa contratação: esconder o item de
 * menu não impede digitar a URL. As Server Actions checam de novo, porque elas
 * são entrada própria e não passam por página nenhuma — as três camadas da
 * regra de superfície do CLAUDE.md.
 */
export default async function PaginaCategorias() {
  const usuario = await exigirTenantAdmin();

  if (!(await temToolContratada(usuario.tenantId, 'vendas'))) {
    return (
      <Alert variant="destructive">
        Este módulo não está contratado.{' '}
        <Link className="underline" href="/painel">
          Voltar
        </Link>
      </Alert>
    );
  }

  const supabase = await criarClienteServidor();

  // Filtro explícito por tenant além da RLS (regra 6). A contagem de produtos
  // por categoria é o que a tela precisa para explicar por que uma remoção é
  // recusada, ANTES de o cliente tentar.
  const { data, error } = await supabase
    .from('categorias')
    .select('id, nome, produtos(count)')
    .eq('tenant_id', usuario.tenantId)
    .order('nome', { ascending: true });

  if (error) {
    return <Alert variant="destructive">Não foi possível carregar as categorias.</Alert>;
  }

  const categorias: CategoriaComUso[] = (data ?? []).map((c) => {
    // Mesma armadilha do embed do catálogo: o agregado `produtos(count)` é
    // tipado como lista e chega como lista de um elemento. Ler direto daria
    // `undefined` e a tela mostraria "0 produtos" em categoria cheia — o que
    // faria o cliente tentar remover e levar uma recusa sem explicação.
    const bruto = c.produtos as { count: number }[] | { count: number } | null;
    const total = Array.isArray(bruto) ? (bruto[0]?.count ?? 0) : (bruto?.count ?? 0);
    return { id: c.id as string, nome: c.nome as string, produtos: total };
  });

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Categorias</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Como você agrupa o que vende. Todo produto pertence a uma categoria, e é por
          ela que o catálogo é resumido em vez de listado inteiro.
        </p>
      </header>

      <GestaoCategorias categoriasIniciais={categorias} />
    </div>
  );
}
