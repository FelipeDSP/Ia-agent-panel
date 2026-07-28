-- Rollback de 10_remover_fallback_app_tenant_id
--
-- Reabre o caminho app.tenant_id em todas as policies. So use se algo
-- dependia dele e nao houver tempo de corrigir na hora — e trate como
-- pendencia de seguranca aberta, nao como estado final.

create or replace function public.auth_tenant_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select coalesce(
    nullif(public.jwt_claims() -> 'app_metadata' ->> 'tenant_id', '')::uuid,
    nullif(current_setting('app.tenant_id', true), '')::uuid
  );
$$;

create or replace function public.match_kb_documentos(
  query_embedding vector,
  match_count     integer default 5,
  filter          jsonb   default '{}'::jsonb
)
returns table (
  id         uuid,
  text       text,
  metadata   jsonb,
  similarity double precision
)
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
begin
  if v_tenant is null and not public.auth_is_super_admin() then
    raise exception
      'Sem contexto de tenant. No n8n execute: SELECT set_config(''app.tenant_id'', ''<uuid>'', true);';
  end if;

  return query
  select d.id, d.text, d.metadata,
         1 - (d.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.kb_documentos d
  where d.tenant_id = v_tenant
    and d.deletado_em is null
    and d.metadata @> filter
  order by d.embedding operator(extensions.<=>) query_embedding
  limit match_count;
end;
$$;
