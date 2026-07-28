-- 10_remover_fallback_app_tenant_id
--
-- auth_tenant_id() hoje aceita duas origens de tenant:
--
--   coalesce(
--     jwt_claims() -> 'app_metadata' ->> 'tenant_id',   <- JWT
--     current_setting('app.tenant_id', true)            <- variavel de sessao
--   )
--
-- Como TODA policy do schema chama auth_tenant_id(), a segunda origem e um
-- caminho de autorizacao paralelo: quem conseguir executar
-- set_config('app.tenant_id', ...) numa conexao do painel passa a ser
-- qualquer tenant, sem token, sem login. Era a Opcao B da secao 5.4.
--
-- Com a Opcao C decidida, o n8n nunca usa esse caminho — ele chama as funcoes
-- api_n8n_* com o tenant na assinatura. O fallback ficou sem consumidor e so
-- mantem a superficie de bypass aberta.
--
-- IMPACTO NOS TESTES: se a suite de isolamento simula tenant com
-- set_config('app.tenant_id', ...), ela para de funcionar. A correcao e trocar
-- pelo claim real, que tem a vantagem de exercitar o mesmo caminho de producao:
--
--   select set_config(
--     'request.jwt.claims',
--     json_build_object('app_metadata',
--       json_build_object('tenant_id', '<uuid>', 'papel', 'tenant_admin')
--     )::text,
--     true
--   );
--
-- Rollback: 20260724160500_10_remover_fallback_app_tenant_id_rollback.sql

create or replace function public.auth_tenant_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(public.jwt_claims() -> 'app_metadata' ->> 'tenant_id', '')::uuid;
$$;

comment on function public.auth_tenant_id() is
  'Tenant do usuario logado, exclusivamente do app_metadata do JWT. '
  'app.tenant_id foi removido em 10: o n8n usa as funcoes api_n8n_*.';

-- ---------------------------------------------------------------------------
-- match_kb_documentos: duas correcoes
--
-- 1. A mensagem de erro instruia usar set_config('app.tenant_id', ...), que
--    a partir daqui nao tem efeito nenhum.
--
-- 2. Para super_admin sem tenant no JWT, v_tenant era NULL e a clausula
--    "d.tenant_id = v_tenant" avaliava NULL para toda linha — a funcao
--    retornava zero resultados sem erro. Busca vetorial que devolve vazio em
--    silencio e a falha mais cara possivel aqui: o agente responde sem base
--    de conhecimento e nada no log indica que faltou contexto.
--    Agora levanta excecao.
-- ---------------------------------------------------------------------------

-- Os defaults precisam ser repetidos: CREATE OR REPLACE nao consegue remover
-- default de funcao existente (42P13), so redefinir identico.
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
