-- Rollback de 16_segregar_credencial_chatwoot
--
-- Recoloca chatwoot_token em tenants, restaura a funcao do n8n para ler dali e
-- remove a tabela segregada. ATENCAO: reverter REABRE a exposicao do token ao
-- tenant_admin — so use se o deploy do codigo tambem for revertido.

-- 1. Recria a coluna em tenants.
alter table public.tenants
  add column if not exists chatwoot_token text;

-- 2. Copia os tokens de volta.
update public.tenants t
set chatwoot_token = c.chatwoot_token
from public.tenant_credenciais c
where c.tenant_id = t.id;

-- 3. Restaura a funcao do n8n para ler o token de tenants.
create or replace function public.api_n8n_credencial_chatwoot(p_tenant_id uuid)
returns table (chatwoot_url text, chatwoot_token text, chatwoot_account_id bigint)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  return query
  select t.chatwoot_url, t.chatwoot_token, t.chatwoot_account_id
  from public.tenants t
  where t.id = p_tenant_id;
end;
$$;

-- 4. Remove a tabela segregada.
drop table if exists public.tenant_credenciais;
