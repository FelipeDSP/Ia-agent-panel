-- Rollback de 17_clamp_match_count — restaura match_kb_documentos sem clamp.

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
  if v_tenant is null then
    raise exception
      'match_kb_documentos: sem tenant no JWT. Super admin deve consultar a KB '
      'de um tenant especifico; o n8n usa api_n8n_buscar_kb(p_tenant_id, ...).'
      using errcode = '22023';
  end if;

  return query
  select d.id,
         d.text,
         d.metadata,
         1 - (d.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.kb_documentos d
  where d.tenant_id = v_tenant
    and d.deletado_em is null
    and d.metadata @> coalesce(filter, '{}'::jsonb)
  order by d.embedding operator(extensions.<=>) query_embedding
  limit match_count;
end;
$$;
