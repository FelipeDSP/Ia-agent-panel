-- Rollback de 20_catalogo_tools.
--
-- Ordem: restaura a funcao SEM o join no catalogo, remove a FK, dropa a tabela
-- (a policy cai junto). tenant_tools volta a carregar descricao/workflow_id como
-- valores proprios (nao override) — os dados ja estao la, nada se perde.

-- 1. Funcao volta ao estado da migracao 19 (contratado AND ativo, sem catalogo).
create or replace function public.api_n8n_tools_ativas(p_tenant_id uuid)
returns table (tool_nome text, workflow_id text, descricao text, config jsonb)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  return query
  select t.tool_nome, t.workflow_id, t.descricao, t.config
  from public.tenant_tools t
  where t.tenant_id = p_tenant_id
    and t.contratado
    and t.ativo;
end;
$$;

revoke all on function public.api_n8n_tools_ativas(uuid) from public;
revoke all on function public.api_n8n_tools_ativas(uuid) from anon, authenticated;
grant execute on function public.api_n8n_tools_ativas(uuid) to n8n_agent;

-- 2. Remove a FK e a tabela de catalogo.
alter table public.tenant_tools drop constraint if exists tenant_tools_tool_nome_fkey;
drop table if exists public.catalogo_tools;
