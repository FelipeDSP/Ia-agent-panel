-- 15_billing
--
-- Fase 5, frente de billing. Mede consumo de IA por tenant para a agencia
-- faturar (a agencia usa a propria chave OpenAI e cobra com margem). Esta fase
-- MEDE e MOSTRA; nao emite fatura.
--
-- Duas tabelas novas e duas funcoes:
--   precos_modelo  — tabela de precos versionada (super_admin only)
--   uso_ingestao   — tokens de embedding da ingestao (Fase 4)
--   billing_consumo_mensal() — tokens + custo USD por tenant/mes (SO super_admin)
--   billing_volume_mensal()  — volume por mes do PROPRIO tenant, SEM custo
--
-- Regra de negocio critica: o custo em USD e a base de custo da agencia. NUNCA
-- chega ao tenant_admin. Por isso precos_modelo e a funcao de custo sao
-- exclusivas de super_admin; o tenant tem so a funcao de volume, que nem
-- seleciona token nem preco.
--
-- Rollback: 20260727180000_15_billing_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. precos_modelo — preco por 1M tokens, versionado por data de vigencia
-- ---------------------------------------------------------------------------
--
-- Uma linha por (modelo, vigente_desde). Nao ha vigente_ate: a proxima linha
-- do mesmo modelo supersede. O preco de uma mensagem e a linha com o maior
-- vigente_desde <= criado_em da mensagem. Assim consumo de janeiro usa preco
-- de janeiro mesmo depois de a OpenAI reajustar.
--
-- Valores em USD. Modelo de embedding preenche so usd_embedding_por_1m; modelo
-- de chat preenche entrada e saida.

create table if not exists public.precos_modelo (
  id                   uuid primary key default gen_random_uuid(),
  modelo               text not null,
  vigente_desde        timestamptz not null,
  usd_entrada_por_1m   numeric(12,4),
  usd_saida_por_1m     numeric(12,4),
  usd_embedding_por_1m numeric(12,4),
  criado_em            timestamptz not null default now(),
  atualizado_em        timestamptz not null default now(),
  unique (modelo, vigente_desde)
);

comment on table public.precos_modelo is
  'Precos OpenAI por 1M tokens, versionados por vigente_desde. So super_admin. '
  'A base de custo da agencia — nunca exposta ao tenant.';

alter table public.precos_modelo enable row level security;

-- Leitura e escrita apenas para super_admin. Sem policy para tenant = tenant
-- nao le nada. Editavel pelo painel (super_admin) ou pelo dashboard.
drop policy if exists p_precos_super on public.precos_modelo;
create policy p_precos_super on public.precos_modelo
  for all to authenticated
  using (public.auth_is_super_admin())
  with check (public.auth_is_super_admin());

-- Preços de referência (vigencia retroativa para cobrir o historico ja gravado).
-- gpt-4.1 aparece configurado em 1 tenant; incluido para o custo dele nao sair
-- zero em silencio. Ajuste os valores se a tabela da OpenAI diferir.
insert into public.precos_modelo (modelo, vigente_desde, usd_entrada_por_1m, usd_saida_por_1m, usd_embedding_por_1m)
values
  ('gpt-4.1-mini',            '2025-01-01 00:00:00+00', 0.4000, 1.6000, null),
  ('gpt-4.1',                 '2025-01-01 00:00:00+00', 2.0000, 8.0000, null),
  ('text-embedding-3-small', '2025-01-01 00:00:00+00', null,   null,   0.0200)
on conflict (modelo, vigente_desde) do nothing;

-- ---------------------------------------------------------------------------
-- 2. uso_ingestao — tokens de embedding gastos na ingestao de documentos
-- ---------------------------------------------------------------------------
--
-- A Edge Function da Fase 4 chama a API de embeddings, que devolve
-- usage.total_tokens. Registramos aqui, fora de mensagens_log (ingestao nao e
-- mensagem de conversa; misturar sujaria o historico e a CHECK de direcao).
-- Escrita so pela service_role (Edge Function); leitura so super_admin, porque
-- entra no calculo de custo.

create table if not exists public.uso_ingestao (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  modelo     text not null,
  tokens     integer not null default 0,
  job_id     uuid,
  criado_em  timestamptz not null default now()
);

comment on table public.uso_ingestao is
  'Tokens de embedding por job de ingestao (Fase 4). Escrita via service_role, '
  'leitura so super_admin — entra no custo, que nao chega ao tenant.';

create index if not exists idx_uso_ingestao_tenant on public.uso_ingestao (tenant_id, criado_em);

alter table public.uso_ingestao enable row level security;

drop policy if exists p_uso_ingestao_super on public.uso_ingestao;
create policy p_uso_ingestao_super on public.uso_ingestao
  for all to authenticated
  using (public.auth_is_super_admin())
  with check (public.auth_is_super_admin());

-- ---------------------------------------------------------------------------
-- 3. billing_consumo_mensal() — tokens + custo USD por tenant/mes
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER: ignora RLS para ler todos os tenants, mensagens e precos.
-- Blindada por um gate explicito de super_admin — se um tenant chamar, ergue
-- 42501. E a unica porta para o custo em USD, e ela so abre para a agencia.
--
-- Custo = tokens/1e6 * preco vigente na data da mensagem (lateral join pega a
-- linha de preco com maior vigente_desde <= criado_em). Modelo sem preco
-- (inclusive lixo de dados) entra com custo 0, nunca quebra.

create or replace function public.billing_consumo_mensal()
returns table (
  tenant_id        uuid,
  tenant_nome      text,
  mes              date,
  tokens_entrada   bigint,
  tokens_saida     bigint,
  tokens_embedding bigint,
  custo_usd        numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.auth_is_super_admin() then
    raise exception 'billing_consumo_mensal: apenas super_admin' using errcode = '42501';
  end if;

  return query
  with conv as (
    select m.tenant_id,
           date_trunc('month', m.criado_em)::date as mes,
           coalesce(m.tokens_entrada, 0)::bigint as te,
           coalesce(m.tokens_saida, 0)::bigint   as ts,
           p.usd_entrada_por_1m as pe,
           p.usd_saida_por_1m   as ps
    from public.mensagens_log m
    left join lateral (
      select pm.usd_entrada_por_1m, pm.usd_saida_por_1m
      from public.precos_modelo pm
      where pm.modelo = m.modelo and pm.vigente_desde <= m.criado_em
      order by pm.vigente_desde desc
      limit 1
    ) p on true
  ),
  ing as (
    select u.tenant_id,
           date_trunc('month', u.criado_em)::date as mes,
           coalesce(u.tokens, 0)::bigint as tk,
           p.usd_embedding_por_1m as pemb
    from public.uso_ingestao u
    left join lateral (
      select pm.usd_embedding_por_1m
      from public.precos_modelo pm
      where pm.modelo = u.modelo and pm.vigente_desde <= u.criado_em
      order by pm.vigente_desde desc
      limit 1
    ) p on true
  ),
  agg as (
    select c.tenant_id, c.mes,
           sum(c.te) as te, sum(c.ts) as ts, 0::bigint as tk,
           sum(c.te / 1e6 * coalesce(c.pe, 0) + c.ts / 1e6 * coalesce(c.ps, 0)) as custo
    from conv c
    group by c.tenant_id, c.mes
    union all
    select i.tenant_id, i.mes,
           0::bigint, 0::bigint, sum(i.tk),
           sum(i.tk / 1e6 * coalesce(i.pemb, 0))
    from ing i
    group by i.tenant_id, i.mes
  )
  select a.tenant_id, t.nome, a.mes,
         sum(a.te)::bigint, sum(a.ts)::bigint, sum(a.tk)::bigint,
         round(sum(a.custo)::numeric, 4)
  from agg a
  join public.tenants t on t.id = a.tenant_id
  group by a.tenant_id, t.nome, a.mes
  order by a.mes desc, t.nome;
end;
$$;

comment on function public.billing_consumo_mensal() is
  'Custo estimado (tokens x tabela de precos) por tenant/mes. SO super_admin.';

revoke all on function public.billing_consumo_mensal() from public;
revoke all on function public.billing_consumo_mensal() from anon;
grant execute on function public.billing_consumo_mensal() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. billing_volume_mensal() — volume do PROPRIO tenant, sem custo
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER porque, apos a secao 5, o tenant nao le mensagens_log direto.
-- Filtra explicito por auth_tenant_id() e devolve SO contagens do proprio
-- tenant — nenhum token, nenhum preco. O custo nao pode vazar por aqui nem por
-- engano. super_admin (tenant nulo) recebe vazio; a agencia usa a funcao de custo.
create or replace function public.billing_volume_mensal()
returns table (
  mes              date,
  mensagens        bigint,
  conversas_ativas bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select date_trunc('month', m.criado_em)::date as mes,
         count(*)::bigint as mensagens,
         count(distinct m.conversation_id)::bigint as conversas_ativas
  from public.mensagens_log m
  where m.tenant_id = public.auth_tenant_id()
  group by 1
  order by 1 desc;
$$;

comment on function public.billing_volume_mensal() is
  'Volume mensal (mensagens, conversas) do proprio tenant. Sem token, sem custo.';

revoke all on function public.billing_volume_mensal() from public;
revoke all on function public.billing_volume_mensal() from anon;
grant execute on function public.billing_volume_mensal() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Blindagem de mensagens_log: tenant nao le a tabela direto
-- ---------------------------------------------------------------------------
--
-- mensagens_log tem tokens_entrada/tokens_saida. A policy antiga (p_log_all)
-- dava ao tenant acesso de LINHA — e RLS nao restringe COLUNA, entao o tenant
-- conseguia ler os proprios tokens por SELECT direto. Como super_admin e
-- tenant_admin compartilham o mesmo role Postgres (authenticated), grant de
-- coluna nao os separa. A saida e tirar o acesso direto do tenant e servir o
-- historico por uma funcao que nunca devolve token.
--
-- O n8n nao e afetado: api_n8n_registrar_mensagem e SECURITY DEFINER e ignora
-- RLS. O painel do tenant passa a ler via conversa_historico (abaixo).

drop policy if exists p_log_all on public.mensagens_log;
create policy p_log_super on public.mensagens_log
  for all to authenticated
  using (public.auth_is_super_admin())
  with check (public.auth_is_super_admin());

-- Historico de uma conversa para o tenant: SO conteudo, nunca token. Definer
-- para poder ler a tabela (o tenant nao le mais direto), mas travado ao proprio
-- tenant via auth_tenant_id.
create or replace function public.conversa_historico(p_conversation_id bigint)
returns table (
  direcao   text,
  conteudo  text,
  criado_em timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select m.direcao, m.conteudo, m.criado_em
  from public.mensagens_log m
  where m.tenant_id = public.auth_tenant_id()
    and m.conversation_id = p_conversation_id
  order by m.criado_em asc;
$$;

comment on function public.conversa_historico(bigint) is
  'Historico (direcao, conteudo, tempo) de uma conversa do proprio tenant. '
  'Nunca devolve token — o tenant nao le mensagens_log direto.';

revoke all on function public.conversa_historico(bigint) from public;
revoke all on function public.conversa_historico(bigint) from anon;
grant execute on function public.conversa_historico(bigint) to authenticated;
