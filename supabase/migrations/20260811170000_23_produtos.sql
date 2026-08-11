-- 23_produtos
--
-- Fatia 1 do modulo de vendas: SO o catalogo de produtos. `pedidos` e
-- `pedido_itens` ficam para a fatia 2 e nao entram aqui — a tela de cadastro e
-- o que valida o modelo contra uso real, e e barato mudar antes de existir
-- pedido apontando para produto.
--
-- Decisoes vindas de docs/VENDAS-ESTADO.md, que nao se reabrem aqui:
--
-- DINHEIRO EM INTEGER DE CENTAVOS. Nunca numeric, nunca float. Float perde
-- centavo e o erro so aparece somando pedido, longe da causa. A conversao
-- reais <-> centavos mora na borda da aplicacao (src/lib/vendas/dinheiro.ts);
-- valor em reais nao chega ao banco e centavo nao chega a tela.
--
-- SOFT DELETE via deletado_em, como o resto do schema. Na fatia 2 um pedido
-- antigo referencia o produto pelo id: apagar fisicamente quebraria historico e
-- deixaria item de pedido apontando para o nada.
--
-- VARIACOES EM JSONB, sem tabela de variacao. E o que faz a mesma tabela servir
-- a restaurante (tamanho, ponto da carne), lavanderia (peca, tipo de lavagem) e
-- loja (cor, numeracao) sem remodelar por vertical. A coluna ja nasce aqui, mas
-- a UI da fatia 1 nao a expoe — quem escreve nela e a fatia 2.
--
-- ESTOQUE NULL = NAO CONTROLA. Distinto de 0, que e "controla e acabou". Sem
-- essa distincao, prato de restaurante (que nao tem estoque) e produto esgotado
-- ficariam indistinguiveis, e o agente da fatia 2 recusaria venda de prato.
--
-- Rollback: 20260811170000_23_produtos_rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- 0. btree_gin: deixa o indice de busca comecar por tenant_id
-- ---------------------------------------------------------------------------
-- GIN puro nao indexa uuid, entao um indice textual sozinho seria GLOBAL: a
-- busca do tenant varreria as entradas de todos os clientes e so depois
-- filtraria — a mesma forma que o CLAUDE.md descreve no HNSW de kb_documentos.
-- Com btree_gin o indice composto (tenant_id, busca) e possivel e a regra 3
-- ("tenant_id e a primeira coluna de todo indice composto") vale tambem aqui.

create extension if not exists btree_gin with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Tabela
-- ---------------------------------------------------------------------------

create table if not exists public.produtos (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  sku            text,
  nome           text not null,
  descricao      text,
  preco_centavos integer not null,
  unidade        text not null default 'un',
  variacoes      jsonb not null default '{}'::jsonb,
  estoque        integer,
  deletado_em    timestamptz,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),

  constraint produtos_nome_nao_vazio    check (btrim(nome) <> ''),
  constraint produtos_unidade_nao_vazia check (btrim(unidade) <> ''),
  constraint produtos_preco_nao_negativo check (preco_centavos >= 0),
  -- Estoque negativo seria venda de item inexistente virando numero negativo em
  -- vez de erro. Null continua permitido: e "nao controla estoque".
  constraint produtos_estoque_nao_negativo check (estoque is null or estoque >= 0),
  -- SKU em branco nao e SKU: seria um '' colidindo com outro '' no indice unico.
  -- Ou vem preenchido, ou vem null.
  constraint produtos_sku_nao_vazio check (sku is null or btrim(sku) <> ''),
  constraint produtos_variacoes_objeto check (jsonb_typeof(variacoes) = 'object')
);

comment on table public.produtos is
  'Catalogo de produtos por tenant (fatia 1 de vendas). Preco em centavos '
  '(integer). Soft delete via deletado_em porque pedido_itens da fatia 2 '
  'referencia o produto. variacoes em jsonb serve verticais diferentes sem '
  'remodelar.';

comment on column public.produtos.preco_centavos is
  'Preco em CENTAVOS. R$ 24,90 = 2490. Nunca reais, nunca float.';
comment on column public.produtos.estoque is
  'null = nao controla estoque (ex.: prato de restaurante). 0 = controla e esgotou.';
comment on column public.produtos.variacoes is
  'Reservada para a fatia 2. A UI da fatia 1 nao escreve aqui.';

-- ---------------------------------------------------------------------------
-- 2. Indices — tenant_id sempre na frente (regra 3)
-- ---------------------------------------------------------------------------

-- Listagem da tela: produtos vivos do tenant, em ordem alfabetica.
create index if not exists idx_produtos_tenant_nome
  on public.produtos (tenant_id, nome)
  where deletado_em is null;

-- SKU e unico dentro do tenant, nao global: dois clientes podem usar "CAM-001"
-- sem se atrapalhar. Parcial em deletado_em is null para que excluir um produto
-- libere o SKU para reuso — do contrario o cliente que apagou "CAM-001" por
-- engano nunca mais poderia recria-lo.
create unique index if not exists uq_produtos_tenant_sku
  on public.produtos (tenant_id, sku)
  where sku is not null and deletado_em is null;

-- Busca textual em portugues sobre nome + descricao. A fatia 2 precisa
-- (api_n8n_buscar_produtos), e criar agora, com a tabela vazia, e instantaneo;
-- criar depois, com catalogo carregado, e janela de manutencao.
--
-- Expressao em vez de coluna gerada: mantem a tabela com as colunas que o
-- briefing definiu, sem um campo derivado aparecendo em `select *`. O literal
-- 'portuguese' e obrigatorio para a expressao ser IMMUTABLE e indexavel.
create index if not exists idx_produtos_busca
  on public.produtos
  using gin (
    tenant_id,
    to_tsvector('portuguese', nome || ' ' || coalesce(descricao, ''))
  )
  where deletado_em is null;

-- ---------------------------------------------------------------------------
-- 3. atualizado_em
-- ---------------------------------------------------------------------------

drop trigger if exists trg_produtos_upd on public.produtos;
create trigger trg_produtos_upd
  before update on public.produtos
  for each row execute function public.set_atualizado_em();

-- ---------------------------------------------------------------------------
-- 4. RLS na mesma migracao (regra 2)
-- ---------------------------------------------------------------------------
-- Mesma forma de kb_documentos: super_admin ve tudo, tenant ve o proprio. O
-- WITH CHECK e o que impede o cliente de INSERIR linha com tenant_id alheio —
-- sem ele, o USING filtraria a leitura e a escrita cruzada passaria.

alter table public.produtos enable row level security;

drop policy if exists p_produtos_all on public.produtos;
create policy p_produtos_all on public.produtos
  for all to authenticated
  using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())
  with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

-- Sem grant para n8n_agent: nesta fatia o agente nao enxerga produto. O acesso
-- dele vem na fatia 2, por funcao api_n8n_* com SECURITY DEFINER e p_tenant_id,
-- nunca por grant direto de tabela.

commit;
