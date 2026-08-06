-- 18_seguranca_tenant_tools
--
-- Fecha o furo da §4.1 do ESPEC-CATALOGO-DE-TOOLS. Hoje tenant_tools tem UMA
-- policy `p_tools_all` FOR ALL com (auth_is_super_admin() OR tenant_id =
-- auth_tenant_id()) e NENHUM trigger de guard. Consequencia: um tenant_admin
-- autenticado, batendo direto no PostgREST com o token dele, consegue:
--   - INSERT uma linha nova com qualquer tool_nome/workflow_id (auto-contratar
--     um modulo que nao foi vendido a ele);
--   - UPDATE ativo=true numa linha, ou trocar workflow_id/descricao/tool_nome;
--   - DELETE as proprias linhas.
-- Ou seja: a fronteira comercial do produto esta editavel pelo cliente pela
-- API. E o mesmo tipo de furo que a migracao 13 fechou para `tenants` — o
-- painel nao e a unica porta, o PostgREST tambem e.
--
-- Correcao (mesma tecnica da 13):
--   1. Policies separadas por comando. tenant_admin recebe SELECT e UPDATE;
--      INSERT e DELETE ficam SO para super_admin. super_admin mantem tudo.
--   2. Trigger BEFORE UPDATE que, para quem nao e super_admin, so deixa mudar
--      as colunas da whitelist (ativo, config). Qualquer outra coluna —
--      inclusive coluna nova adicionada no futuro (ex.: `contratado` da §4.2) —
--      levanta 42501. Default seguro: "protegido".
--
-- ARMADILHA (adendo §5, repetida aqui de proposito): o guard le
-- auth_is_super_admin(), que vem do JWT (app_metadata->>'papel'). service_role
-- e postgres NAO tem esse claim, entao para eles auth_is_super_admin() = false
-- e o trigger BARRA o UPDATE — o trigger dispara mesmo para service_role, que
-- so bypassa RLS, nao trigger. O painel NAO usa service_role para escrever em
-- tenant_tools (admin e cliente usam o cliente AUTENTICADO via
-- criarClienteServidor), entao a aplicacao nao e afetada. Para manutencao
-- manual por script rodando como postgres/service_role, definir o claim antes:
--   select set_config('request.jwt.claims',
--     '{"app_metadata":{"papel":"super_admin"}}', true);
--
-- Nao toca em api_n8n_tools_ativas nem em nenhuma funcao api_n8n_*: o agente da
-- Acqua no n8n continua identico. Nao altera nenhum dado. Reversivel pelo
-- rollback (que reabre o furo — usar so para desfazer um deploy problematico).
--
-- Rollback: 20260805155810_18_seguranca_tenant_tools_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Policies por comando (substituem a unica p_tools_all FOR ALL)
-- ---------------------------------------------------------------------------

drop policy if exists p_tools_all on public.tenant_tools;

-- Leitura: super ve tudo; tenant ve as proprias linhas.
create policy p_tools_select on public.tenant_tools
  for select to authenticated
  using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

-- Update: mesma visibilidade. QUAIS colunas podem mudar e decidido pelo trigger
-- de guard abaixo — RLS nao restringe por coluna.
create policy p_tools_update on public.tenant_tools
  for update to authenticated
  using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())
  with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

-- Insert: SO super_admin. Contratar/habilitar um modulo e decisao da agencia.
create policy p_tools_insert on public.tenant_tools
  for insert to authenticated
  with check (public.auth_is_super_admin());

-- Delete: SO super_admin.
create policy p_tools_delete on public.tenant_tools
  for delete to authenticated
  using (public.auth_is_super_admin());

-- ---------------------------------------------------------------------------
-- 2. Guard de coluna por papel (before update), espelhando tenants_guard_colunas
-- ---------------------------------------------------------------------------

create or replace function public.tenant_tools_guard_colunas()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Super admin pode tudo.
  if public.auth_is_super_admin() then
    return new;
  end if;

  -- Para os demais (tenant_admin): so ativo e config podem diferir. Qualquer
  -- outra coluna — tool_nome, workflow_id, descricao, tenant_id, criado_em e
  -- colunas futuras como `contratado` — fica protegida por padrao.
  if (to_jsonb(new) - '{ativo,config}'::text[])
     is distinct from
     (to_jsonb(old) - '{ativo,config}'::text[])
  then
    raise exception
      'Sem permissao: tenant_admin so pode alterar ativo e config em tenant_tools. Contratacao, workflow e descricao sao da agencia.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.tenant_tools_guard_colunas() is
  'Barra tenant_admin de alterar colunas de contratacao/infra em tenant_tools. '
  'Whitelist por diff de jsonb: ativo e config liberados; coluna nova protegida por padrao.';

drop trigger if exists trg_tenant_tools_guard_colunas on public.tenant_tools;

create trigger trg_tenant_tools_guard_colunas
  before update on public.tenant_tools
  for each row
  execute function public.tenant_tools_guard_colunas();
