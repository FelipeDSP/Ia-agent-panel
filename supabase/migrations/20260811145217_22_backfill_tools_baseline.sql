-- 22_backfill_tools_baseline
--
-- Garante que todo tenant VIVO e ATIVO tenha as tres tools de baseline do
-- produto (busca_conhecimento, transferir_humano, resolver_conversa)
-- contratadas e ligadas.
--
-- MOTIVO. As tres passaram a ser baseline: `criarTenant` provisiona as tres no
-- cliente novo e `definirContratacao` insere com ativo=true. Isso cobre o que
-- vier daqui para frente e nao toca em quem ja existia. Tenant antigo criado
-- antes do fluxo de catalogo ficou com zero linhas em tenant_tools — o agente
-- dele nao teria nem busca na base de conhecimento.
--
-- Escrita como REGRA, nao como conserto dos casos conhecidos: o predicado e
-- "todo tenant com deletado_em is null e ativo = true", entao qualquer tenant
-- antigo que apareca depois (ou que seja reativado antes desta migracao rodar
-- num ambiente novo) tambem e coberto. Em 2026-08-11 os alcancados eram
-- clinica-teste e sandbox-de-testes, ambos com zero tools; acqua-lavanderia e
-- restaurante-teste ja tinham as tres e nao sao tocados.
--
-- QUEM FICA DE FORA, de proposito:
--   * `deletado_em` preenchido (soft delete) — padaria-aurora, sandbox. Repor
--     tool em cliente excluido e ressuscitar dado que alguem removeu.
--   * `ativo = false` — cliente suspenso. Provisionar modulo para quem esta
--     suspenso contradiz a suspensao.
-- Se um deles voltar, `alternarSuspensaoTenant` o reativa e esta migracao pode
-- ser reaplicada (e idempotente) ou o modulo contratado pela tela de Modulos.
--
-- IDEMPOTENTE: `on conflict (tenant_id, tool_nome) do nothing`. Reaplicar nao
-- duplica, nao sobrescreve `ativo` de quem desligou de proposito e nao mexe no
-- `config` de ninguem — em especial o de acqua-lavanderia, que tem horario e
-- notificacao reais gravados.
--
-- POR QUE A TABELA DE RASTREIO. O rollback precisa apagar EXATAMENTE as linhas
-- que esta migracao inseriu. Um delete por predicado largo ("baseline de tenant
-- ativo") varreria tambem as linhas que ja existiam antes — incluindo a
-- transferir_humano da Acqua, com config de producao dentro. Entao a ida grava
-- as chaves inseridas em `backfill_22_tools_inseridas` e o rollback consome e
-- dropa essa tabela.
--
-- Rollback: 20260811145217_22_backfill_tools_baseline_rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. Tabela de rastreio (some no rollback)
-- ---------------------------------------------------------------------------
-- Tem tenant_id, entao leva RLS com policy na mesma migracao (regra 2 do
-- CLAUDE.md). Super-only: e artefato de manutencao, nenhum cliente a le.

create table if not exists public.backfill_22_tools_inseridas (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tool_nome text not null,
  criado_em timestamptz not null default now(),
  primary key (tenant_id, tool_nome)
);

comment on table public.backfill_22_tools_inseridas is
  'Chaves inseridas pela migracao 22, para o rollback dela apagar exatamente '
  'estas linhas e nao as que ja existiam. Dropada pelo rollback.';

alter table public.backfill_22_tools_inseridas enable row level security;

drop policy if exists p_backfill22_super on public.backfill_22_tools_inseridas;
create policy p_backfill22_super on public.backfill_22_tools_inseridas
  for all to authenticated
  using (public.auth_is_super_admin())
  with check (public.auth_is_super_admin());

-- ---------------------------------------------------------------------------
-- 2. Insere o que falta e registra o que foi inserido
-- ---------------------------------------------------------------------------
-- A lista de tools espelha TOOLS_BASELINE em src/lib/tools/registro.ts. Ao
-- mexer em uma, mexa na outra — o FK para catalogo_tools garante que o nome
-- exista, mas nao que os dois lados concordem.

with alvo as (
  select t.id as tenant_id, b.tool_nome
  from public.tenants t
  cross join (values
    ('busca_conhecimento'),
    ('transferir_humano'),
    ('resolver_conversa')
  ) as b(tool_nome)
  where t.deletado_em is null
    and t.ativo = true
),
inseridas as (
  insert into public.tenant_tools (tenant_id, tool_nome, contratado, ativo, config)
  select a.tenant_id, a.tool_nome, true, true, '{}'::jsonb
  from alvo a
  on conflict (tenant_id, tool_nome) do nothing
  returning tenant_id, tool_nome
)
insert into public.backfill_22_tools_inseridas (tenant_id, tool_nome)
select tenant_id, tool_nome from inseridas
on conflict (tenant_id, tool_nome) do nothing;

commit;
