-- 17_clamp_match_count
--
-- match_kb_documentos aceitava match_count arbitrario (sem teto), diferente de
-- api_n8n_buscar_kb que ja clampa 1..50. Nao e cross-tenant (a funcao filtra
-- por auth_tenant_id()), mas um match_count enorme e uso de recurso desnecessario
-- (DoS/custo). Clampa para 1..50, mantendo o corpo identico.
--
-- Nao-destrutivo e idempotente (create or replace). Rollback restaura a versao
-- sem clamp.
--
-- Rollback: 20260804130000_17_clamp_match_count_rollback.sql

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
  -- Teto de 50 (paridade com api_n8n_buscar_kb); minimo 1; default 5 se nulo.
  v_limite integer := least(greatest(coalesce(match_count, 5), 1), 50);
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
  limit v_limite;
end;
$$;
