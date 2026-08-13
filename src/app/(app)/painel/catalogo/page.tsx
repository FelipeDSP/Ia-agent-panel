import { Alert } from '@/components/ui/alert';
import { exigirTenantAdmin } from '@/lib/auth';
import { criarClienteServidor } from '@/lib/supabase/server';
import { temToolContratada } from '@/lib/tools/contratacao';

import { GestaoCatalogo, type Produto } from './componentes';

export default async function PaginaCatalogo() {
  const usuario = await exigirTenantAdmin();
  const supabase = await criarClienteServidor();

  // A foto é SUPERFÍCIE de outra tool. `foto_produto` não tem rota própria — é
  // uma seção dentro desta tela — e obedece à mesma regra: só existe para quem
  // contratou. É o caso que prova que superfície não é sinônimo de rota.
  const podeFoto = await temToolContratada(usuario.tenantId, 'foto_produto');

  // Filtro explícito por tenant além da RLS: as duas camadas, como manda a
  // regra 6 do CLAUDE.md. `deletado_em is null` porque a exclusão é soft.
  const { data, error } = await supabase
    .from('produtos')
    .select('id, nome, descricao, preco_centavos, unidade, sku, estoque, disponivel, foto_path')
    .eq('tenant_id', usuario.tenantId)
    .is('deletado_em', null)
    .order('nome', { ascending: true });

  if (error) {
    return <Alert variant="destructive">Não foi possível carregar o catálogo.</Alert>;
  }

  // URLs assinadas em LOTE: uma chamada para a tela toda, não uma por produto.
  // Vida curta de propósito — a miniatura é reaberta a cada carregamento, e uma
  // assinatura longa vazando daria acesso à foto por horas. O bucket é privado
  // (migração 34), então esta é a única forma de a tela enxergar o arquivo.
  // Sem o modulo contratado nem assinamos URL: o arquivo continua no Storage,
  // mas a tela nao o busca. Descontratar esconde, nao apaga.
  const comFoto = podeFoto ? (data ?? []).filter((p) => p.foto_path) : [];
  const urlPorPath = new Map<string, string>();
  if (comFoto.length > 0) {
    const { data: assinadas } = await supabase.storage
      .from('produto-fotos')
      .createSignedUrls(comFoto.map((p) => p.foto_path as string), 300);
    for (const a of assinadas ?? []) {
      if (a.signedUrl && a.path) urlPorPath.set(a.path, a.signedUrl);
    }
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
    fotoUrl: podeFoto && p.foto_path ? (urlPorPath.get(p.foto_path as string) ?? null) : null,
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

      <GestaoCatalogo produtosIniciais={produtos} podeFoto={podeFoto} />
    </div>
  );
}
