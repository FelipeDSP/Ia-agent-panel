-- 25_pedidos
--
-- Fatia 2 de vendas, parte 1: as tabelas. As funcoes `api_n8n_*` que o agente
-- chama vem na migracao 26, separada de proposito — assim da para corrigir uma
-- funcao com bug sem passar perto dos dados de pedido.
--
-- SEM COLUNA `variacao` EM pedido_itens, e isso e uma decisao, nao um
-- esquecimento. O desenho original pedia `variacao jsonb` no item sem definir
-- variacao no catalogo; sem fonte de verdade la, o conteudo viria do LLM em
-- texto livre — e variacao afeta preco, o que fura a trava 1 por outra porta.
-- Os 19 produtos reais cadastrados na fatia 1 nao precisaram de variacao
-- ("Moqueca para 2" poe tamanho no nome; "Terno 2 pecas" e servico distinto;
-- "agua com ou sem gas" nao muda preco). Pedido e produto x quantidade.
-- `observacao` fica, para texto que NAO afeta preco — esse pode vir do LLM sem
-- risco. Proposta completa de variacao e gatilho para retomar em
-- docs/VENDAS-ESTADO.md.
--
-- Rollback: 20260811190000_25_pedidos_rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. pedidos
-- ---------------------------------------------------------------------------

create table if not exists public.pedidos (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid   not null references public.tenants(id) on delete cascade,
  conversation_id bigint not null,
  -- Referencia legivel para o cliente final ("pedido 27"). UUID nao se fala no
  -- WhatsApp. Nao viola a regra 4 do CLAUDE.md: nao e chave de acesso — nenhuma
  -- funcao localiza pedido por `numero`, elas filtram por tenant_id +
  -- conversation_id. E rotulo de exibicao, atribuido so no fechamento.
  numero          integer,
  status          text   not null default 'rascunho',
  total_centavos  integer not null default 0,
  metadados       jsonb  not null default '{}'::jsonb,
  deletado_em     timestamptz,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),

  constraint pedidos_status_valido check (status in (
    'rascunho', 'aguardando_pagamento', 'pago', 'cancelado', 'expirado'
  )),
  constraint pedidos_total_nao_negativo check (total_centavos >= 0),
  constraint pedidos_numero_positivo check (numero is null or numero > 0),
  constraint pedidos_metadados_objeto check (jsonb_typeof(metadados) = 'object')
);

comment on table public.pedidos is
  'Pedido por conversa (fatia 2 de vendas). total_centavos e SEMPRE recalculado '
  'do somatorio dos itens por trigger, nunca recebido de fora — e a trava 1 do '
  'VENDAS-ESTADO.md: o LLM decide o que, o servidor decide quanto.';

comment on column public.pedidos.numero is
  'Rotulo legivel por tenant, atribuido no fechamento. Nao e chave de acesso.';
comment on column public.pedidos.metadados is
  'Endereco, retirada, observacao geral — varia por vertical, por isso jsonb.';

-- UM PEDIDO ABERTO POR CONVERSA. Elimina a classe de bug "o agente criou dois
-- carrinhos e perdeu o primeiro": a segunda tentativa de abrir da erro de
-- unicidade em vez de criar um carrinho paralelo silencioso.
create unique index if not exists uq_pedidos_conversa_aberta
  on public.pedidos (tenant_id, conversation_id)
  where status in ('rascunho', 'aguardando_pagamento') and deletado_em is null;

-- Numero unico dentro do tenant. Tambem serve de rede para a corrida do
-- max(numero)+1 em fechar_pedido: duas transacoes simultaneas nao geram
-- numeros iguais em silencio, uma falha e tenta de novo.
create unique index if not exists uq_pedidos_tenant_numero
  on public.pedidos (tenant_id, numero)
  where numero is not null;

-- Listagem da tela do painel: pedidos do tenant, mais recentes primeiro.
create index if not exists idx_pedidos_tenant_criado
  on public.pedidos (tenant_id, criado_em desc)
  where deletado_em is null;

-- ---------------------------------------------------------------------------
-- 2. pedido_itens
-- ---------------------------------------------------------------------------

create table if not exists public.pedido_itens (
  id                  uuid primary key default gen_random_uuid(),
  -- tenant_id DENORMALIZADO de proposito. Sem ele a policy de RLS viraria um
  -- EXISTS em `pedidos` a cada linha lida, e a regra 3 (tenant_id na frente do
  -- indice composto) nao teria como valer aqui. E a mesma redundancia
  -- consciente que os chunks de kb_documentos ja carregam no metadata. Mantido
  -- em sincronia pelo trigger abaixo, nao pela aplicacao.
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  pedido_id           uuid not null references public.pedidos(id) on delete cascade,
  -- Sem ON DELETE CASCADE: produto usa soft delete justamente para o item
  -- historico continuar apontando para algo. Se alguem apagar produto
  -- fisicamente, a FK recusa — que e o aviso desejado.
  produto_id          uuid not null references public.produtos(id),
  -- SNAPSHOT: reajuste no catalogo nao muda pedido antigo, e produto removido
  -- continua legivel no historico.
  nome_snapshot       text not null,
  preco_unit_centavos integer not null,
  quantidade          integer not null,
  observacao          text,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),

  constraint pedido_itens_nome_nao_vazio check (btrim(nome_snapshot) <> ''),
  constraint pedido_itens_preco_nao_negativo check (preco_unit_centavos >= 0),
  constraint pedido_itens_quantidade_positiva check (quantidade > 0)
);

comment on table public.pedido_itens is
  'Item de pedido, com nome e preco CONGELADOS no momento em que entrou. '
  'Sem coluna de variacao — ver cabecalho da migracao 25 e VENDAS-ESTADO.md.';

-- Mesmo produto duas vezes SOMA quantidade em vez de duplicar linha. O upsert
-- em adicionar_item depende deste unique; sem ele o carrinho encheria de linhas
-- repetidas do mesmo item e o cliente veria "2x cafe" e "1x cafe" separados.
create unique index if not exists uq_pedido_itens_produto
  on public.pedido_itens (pedido_id, produto_id);

create index if not exists idx_pedido_itens_tenant_pedido
  on public.pedido_itens (tenant_id, pedido_id);

-- ---------------------------------------------------------------------------
-- 3. tenant_id do item vem do pedido, nunca do chamador
-- ---------------------------------------------------------------------------
-- Denormalizacao so e segura se a copia nao puder divergir. O trigger sobrescreve
-- o que vier de fora: um insert com tenant_id alheio e corrigido para o dono do
-- pedido, em vez de criar uma linha que a RLS mostraria ao tenant errado.

create or replace function public.pedido_itens_herda_tenant()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select p.tenant_id into new.tenant_id
  from public.pedidos p
  where p.id = new.pedido_id;

  if new.tenant_id is null then
    raise exception 'pedido_itens: pedido % inexistente', new.pedido_id
      using errcode = '23503';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_pedido_itens_tenant on public.pedido_itens;
create trigger trg_pedido_itens_tenant
  before insert or update of pedido_id on public.pedido_itens
  for each row execute function public.pedido_itens_herda_tenant();

-- ---------------------------------------------------------------------------
-- 4. total_centavos recalculado, nunca recebido
-- ---------------------------------------------------------------------------
-- No trigger e nao na funcao de aplicacao: assim o total continua correto mesmo
-- se alguem escrever direto na tabela. "Nunca recebido de fora" so e verdade se
-- o banco garantir, e nao se a aplicacao lembrar.

create or replace function public.pedidos_recalcula_total()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_pedido uuid := coalesce(new.pedido_id, old.pedido_id);
begin
  update public.pedidos p
  set total_centavos = coalesce((
        select sum(i.preco_unit_centavos::bigint * i.quantidade)
        from public.pedido_itens i
        where i.pedido_id = v_pedido
      ), 0)
  where p.id = v_pedido;

  return null;
end;
$$;

drop trigger if exists trg_pedido_itens_total on public.pedido_itens;
create trigger trg_pedido_itens_total
  after insert or update or delete on public.pedido_itens
  for each row execute function public.pedidos_recalcula_total();

-- ---------------------------------------------------------------------------
-- 5. atualizado_em
-- ---------------------------------------------------------------------------

drop trigger if exists trg_pedidos_upd on public.pedidos;
create trigger trg_pedidos_upd
  before update on public.pedidos
  for each row execute function public.set_atualizado_em();

drop trigger if exists trg_pedido_itens_upd on public.pedido_itens;
create trigger trg_pedido_itens_upd
  before update on public.pedido_itens
  for each row execute function public.set_atualizado_em();

-- ---------------------------------------------------------------------------
-- 6. RLS na mesma migracao (regra 2)
-- ---------------------------------------------------------------------------
-- Mesma forma de produtos e kb_documentos. O cliente LE os proprios pedidos
-- (a tela do painel desta fatia so lista e detalha) e nao escreve: quem escreve
-- e o n8n, pelas funcoes SECURITY DEFINER da migracao 26, que bypassam RLS.
-- Por isso `for select`, e nao `for all` — deixar o tenant_admin editar pedido
-- por PostgREST abriria alterar total e status por fora das travas.

alter table public.pedidos enable row level security;
alter table public.pedido_itens enable row level security;

drop policy if exists p_pedidos_leitura on public.pedidos;
create policy p_pedidos_leitura on public.pedidos
  for select to authenticated
  using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

drop policy if exists p_pedido_itens_leitura on public.pedido_itens;
create policy p_pedido_itens_leitura on public.pedido_itens
  for select to authenticated
  using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

-- Sem grant de tabela para n8n_agent: o acesso dele e so pelas funcoes da 26.

commit;
