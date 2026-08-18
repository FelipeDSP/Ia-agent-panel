-- Migracao 44 — times do Chatwoot por tenant
--
-- Sustenta `docs/ESPEC-TRANSFERIR-PARA-TIME.md`. Nao muda nada do que existe:
-- so acrescenta a tabela e a funcao que o n8n vai ler.
--
-- ============================ POR QUE A TABELA EXISTE =======================
--
-- Medido em 18/08 com o token de Agent Bot do fortalize: o bot ATRIBUI
-- (`POST /conversations/{id}/assignments` devolve 200 com o objeto do time),
-- mas NAO LISTA nada — `GET /teams`, `/agents`, `/inboxes` e `/contacts` sao
-- 401 "not authorized for bots".
--
-- Sem listar, nao ha seletor a popular: o cliente cadastra o `team_id` a mao, e
-- por isso ele precisa morar aqui. E `id errado` nao da erro — devolve 200 com
-- corpo `null` —, entao a tabela guarda tambem o resultado da ultima
-- verificacao, que e o unico jeito de o cliente saber que o time sumiu.
--
-- ROLLBACK: 20260818210000_44_times_do_chatwoot_rollback.sql

begin;

create table if not exists public.tenant_times (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  -- Id do time NO CHATWOOT. BIGINT como `chatwoot_account_id`, pela mesma razao:
  -- e id de outro sistema e nao cabe supor faixa.
  team_id       bigint not null,
  nome          text not null,

  -- O QUE O MODELO LE PARA DECIDIR. Entra no System Message a cada chamada, e
  -- por isso tem teto: ver o trigger de soma abaixo.
  descricao     text not null default '',

  -- Para onde vai quando o modelo mandar um nome que nao existe. Sem padrao, o
  -- cliente fica sem transferencia E sem aviso, porque a falha e silenciosa.
  padrao        boolean not null default false,

  -- Resultado da ULTIMA tentativa de atribuir (cadastro ou transferencia real).
  -- `verificado_em` preenchido e `falhou_em` nulo = o time existia da ultima vez.
  verificado_em timestamptz,
  falhou_em     timestamptz,

  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  constraint tenant_times_team_id_check   check (team_id > 0),
  constraint tenant_times_nome_check      check (length(btrim(nome)) between 1 and 40),
  -- 120 por descricao. O teto que segura o custo e o da SOMA (trigger abaixo);
  -- este existe so para uma descricao nao comer a cota inteira.
  constraint tenant_times_descricao_check check (length(descricao) <= 120)
);

-- `tenant_id` primeiro em todo indice composto (regra 3 da CLAUDE.md).
create unique index if not exists uq_tenant_times_tenant_team
  on public.tenant_times (tenant_id, team_id);

-- O MODELO ESCOLHE PELO NOME: dois times com o mesmo nome no mesmo tenant
-- tornariam a escolha ambigua, e o servidor resolveria para um dos dois sem
-- criterio. `lower` porque "Suporte" e "suporte" sao o mesmo nome para quem le.
create unique index if not exists uq_tenant_times_tenant_nome
  on public.tenant_times (tenant_id, lower(btrim(nome)));

-- UM padrao por tenant. Indice parcial: `padrao = false` pode repetir a vontade.
create unique index if not exists uq_tenant_times_padrao
  on public.tenant_times (tenant_id) where padrao;

comment on table public.tenant_times is
  'Times do Chatwoot por tenant. O bot nao lista times (401), entao o team_id e cadastrado a mao e verificado por tentativa de atribuicao.';
comment on column public.tenant_times.descricao is
  'Lida pelo modelo para escolher o time. Entra no System Message a cada chamada — teto de 120 por linha e 720 por tenant.';
comment on column public.tenant_times.falhou_em is
  'Ultima vez que atribuir a este time devolveu corpo nulo (time inexistente no Chatwoot). Nulo = a ultima tentativa deu certo.';

-- ---------------------------------------------------------------------------
-- O TETO DA SOMA, no banco e nao so na tela.
--
-- Quinze times de 80 caracteres passam em toda validacao individual e custam o
-- dobro do cenario de seis de 120 — quem paga a conta e o TOTAL. Deixar isso so
-- na Server Action significaria que qualquer outro caminho de escrita (script,
-- SQL avulso, uma tela futura) fura o limite sem perceber.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_times_teto_descricao()
returns trigger
language plpgsql
as $$
declare
  v_total integer;
begin
  select coalesce(sum(length(descricao)), 0) into v_total
    from public.tenant_times
   where tenant_id = new.tenant_id
     and id <> new.id;          -- na atualizacao, a linha nova entra pelo NEW

  if v_total + length(new.descricao) > 720 then
    raise exception
      'as descricoes dos times somam % caracteres e o limite e 720 (elas entram no prompt a cada mensagem)',
      v_total + length(new.descricao)
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- `create OR REPLACE trigger` (Postgres 14+; aqui roda 17.6). Com `create
-- trigger` puro a migracao NAO e reexecutavel: a segunda aplicacao morre em
-- "trigger already exists", e o teste que aplica em transacao abortada contra
-- producao para de rodar no instante em que a migracao entra — foi exatamente
-- o que aconteceu aqui, e a CLAUDE.md avisa dessa armadilha para funcoes.
-- Trigger nao tem `if not exists`; tem `or replace`.
create or replace trigger trg_tenant_times_teto
  before insert or update on public.tenant_times
  for each row execute function public.tenant_times_teto_descricao();

create or replace trigger trg_tenant_times_upd
  before update on public.tenant_times
  for each row execute function public.set_atualizado_em();

-- ---------------------------------------------------------------------------
-- RLS. Tabela com `tenant_id` sem policy vaza (regra 2 da CLAUDE.md), e a
-- policy vai na MESMA migracao que cria a tabela.
-- ---------------------------------------------------------------------------
alter table public.tenant_times enable row level security;

-- `create policy` tambem nao tem `if not exists` nem `or replace`: o idioma que
-- mantem a migracao reexecutavel e dropar antes. Dentro da transacao, a janela
-- sem policy nao existe para ninguem de fora.
drop policy if exists p_tenant_times_all on public.tenant_times;

create policy p_tenant_times_all on public.tenant_times
  for all
  using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())
  with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

-- ---------------------------------------------------------------------------
-- A leitura do n8n: nome + descricao para o prompt, e o id para resolver.
--
-- Devolve TAMBEM o time padrao, porque o sub-workflow precisa dele no mesmo
-- round-trip — buscar em duas chamadas seria uma chance a mais de o caminho
-- quente falhar pela metade.
-- ---------------------------------------------------------------------------
create or replace function public.api_n8n_times(p_tenant_id uuid)
returns table (team_id bigint, nome text, descricao text, padrao boolean)
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $$
  select t.team_id, t.nome, t.descricao, t.padrao
    from public.tenant_times t
   where t.tenant_id = p_tenant_id
   order by t.padrao desc, lower(btrim(t.nome));
$$;

comment on function public.api_n8n_times(uuid) is
  'Times do tenant para o sub-workflow de transferencia: o modelo escolhe pelo nome, o servidor resolve o team_id.';

-- Grants nos DOIS roles, e so neles — a licao das migracoes 40, 41, 42 e 43.
-- `revoke from public` tira o grant implicito que a criacao devolve; sem ele,
-- `anon` executa por heranca.
revoke all on function public.api_n8n_times(uuid) from public, anon, authenticated;
grant execute on function public.api_n8n_times(uuid) to service_role;
grant execute on function public.api_n8n_times(uuid) to n8n_agent;

commit;
