-- Rollback de 19_contratado_tenant_tools.
--
-- Volta api_n8n_tools_ativas a filtrar so `ativo` e remove a coluna contratado.
-- Ordem: restaura a funcao ANTES de dropar a coluna (a versao restaurada nao
-- referencia contratado). Reversivel sem perda: contratado era derivado/comercial,
-- nao havia dado de cliente nele alem do default true.

-- 1. Restaura a funcao ao filtro anterior (so ativo), assinatura inalterada.
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
    and t.ativo;
end;
$$;

revoke all on function public.api_n8n_tools_ativas(uuid) from public;
revoke all on function public.api_n8n_tools_ativas(uuid) from anon, authenticated;
grant execute on function public.api_n8n_tools_ativas(uuid) to n8n_agent;

-- 2. Remove a coluna.
alter table public.tenant_tools drop column if exists contratado;
