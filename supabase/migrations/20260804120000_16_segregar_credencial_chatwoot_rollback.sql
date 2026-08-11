-- Rollback de 16_segregar_credencial_chatwoot
--
-- Recoloca chatwoot_token em tenants, restaura AS DUAS funcoes do n8n para ler
-- dali e remove a tabela segregada. ATENCAO: reverter REABRE a exposicao do
-- token ao tenant_admin — so use se o deploy do codigo tambem for revertido.
--
-- As duas funcoes sao api_n8n_credencial_chatwoot e api_n8n_config_tool. A
-- segunda foi esquecida na primeira versao deste par (ver cabecalho da migracao
-- ida): sem restaurar tambem a config_tool, o `drop table tenant_credenciais` no
-- passo 4 deixaria a funcao referenciando uma tabela inexistente — o mesmo modo
-- de falha que o rollback existe para desfazer, porque plpgsql tambem nao valida
-- a referencia no momento do drop. As duas tools quebrariam DEPOIS do rollback.

-- 1. Recria a coluna em tenants.
alter table public.tenants
  add column if not exists chatwoot_token text;

-- 2. Copia os tokens de volta.
--
-- O guard de coluna da migracao 13 (trg_tenants_guard_colunas) dispara em TODO
-- update de `tenants` e libera cedo so quando `auth_is_super_admin()` e
-- verdadeiro. Numa conexao de migracao nao existe JWT, entao essa funcao devolve
-- falso e o guard levanta 42501 ("Sem permissao: tenant_admin so pode alterar
-- prompt, mensagens, debounce e agente_ativo") — mesmo rodando como owner do
-- banco. Sem desabilitar o trigger, este rollback aborta no meio: a coluna volta
-- vazia, a tabela segregada e dropada no passo 4 e os tokens somem dos dois
-- lados. Verificado em 2026-08-11 executando o par ida+rollback em transacao
-- abortada contra producao.
--
-- A ida nao passa por isso: ela so faz SELECT em tenants e DDL, e DDL nao
-- dispara trigger de linha.
alter table public.tenants disable trigger trg_tenants_guard_colunas;

update public.tenants t
set chatwoot_token = c.chatwoot_token
from public.tenant_credenciais c
where c.tenant_id = t.id;

alter table public.tenants enable trigger trg_tenants_guard_colunas;

-- 3a. Restaura api_n8n_credencial_chatwoot para ler o token de tenants.
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

-- 3b. Restaura api_n8n_config_tool ao corpo da migracao 11 (token de tenants).
create or replace function public.api_n8n_config_tool(
  p_tenant_id uuid,
  p_tool_nome text
)
returns table (
  chatwoot_url   text,
  chatwoot_token text,
  tool_ativa     boolean,
  config         jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
BEGIN
  PERFORM public.n8n_assert_tenant(p_tenant_id);

  RETURN QUERY
  SELECT t.chatwoot_url,
         t.chatwoot_token,
         COALESCE(tt.ativo, FALSE),
         COALESCE(tt.config, '{}'::jsonb)
  FROM public.tenants t
  LEFT JOIN public.tenant_tools tt
         ON tt.tenant_id = t.id AND tt.tool_nome = p_tool_nome
  WHERE t.id = p_tenant_id;
END;
$$;

comment on function public.api_n8n_config_tool(uuid, text) is
  'Credencial do Chatwoot + estado e config de uma tool, numa chamada so. '
  'Usada pelo sub-workflow de transferencia para humano.';

-- 4. Remove a tabela segregada.
-- Depois de 3a e 3b: nenhuma funcao referencia mais tenant_credenciais.
drop table if exists public.tenant_credenciais;
