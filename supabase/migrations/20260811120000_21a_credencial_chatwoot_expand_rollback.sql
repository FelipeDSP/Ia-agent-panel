-- Rollback de 21a_credencial_chatwoot_expand
--
-- Devolve AS DUAS funcoes do n8n para ler o token de `tenants` e remove a tabela
-- segregada. ATENCAO: reverter REABRE a exposicao do token ao tenant_admin — so
-- use se o deploy do painel novo tambem for revertido.
--
-- As duas funcoes sao api_n8n_credencial_chatwoot e api_n8n_config_tool. A
-- segunda foi esquecida na primeira versao deste par (ver cabecalho da ida):
-- sem restaura-la tambem, o `drop table tenant_credenciais` no passo 3 deixaria
-- a funcao referenciando uma relacao inexistente — o mesmo modo de falha que
-- este rollback existe para desfazer, porque plpgsql tambem nao valida a
-- referencia no momento do drop. As duas tools quebrariam DEPOIS do rollback.
--
-- ORDEM: sincroniza tokens de volta -> restaura as funcoes -> dropa a tabela.
-- A coluna `tenants.chatwoot_token` nao precisa ser recriada: a 21a nunca a
-- removeu (isso e trabalho da 21b, e o rollback dela cuida disso).

-- ---------------------------------------------------------------------------
-- 1. Sincroniza de volta o que tiver sido gravado na tabela segregada
-- ---------------------------------------------------------------------------
-- Necessario porque, se o painel NOVO ja estava no ar, ele gravou token apenas
-- em tenant_credenciais. Reverter sem sincronizar deixaria `tenants` com um
-- token velho e a tabela nova seria dropada logo abaixo — o valor mais recente
-- sumiria sem aviso.
--
-- POR QUE session_replication_role: o guard de coluna da migracao 13
-- (trg_tenants_guard_colunas) dispara em TODO update de `tenants` e so libera
-- cedo quando `auth_is_super_admin()` e verdadeiro. Numa conexao de migracao nao
-- existe JWT, entao a funcao devolve falso e o guard levanta 42501 ("Sem
-- permissao: tenant_admin so pode alterar prompt, mensagens, debounce e
-- agente_ativo") mesmo rodando como owner do banco. Verificado em 2026-08-11
-- executando este par contra producao em transacao abortada.
--
-- `set local` e preferivel a `alter table ... disable trigger` aqui por tres
-- razoes: e restrito a esta sessao (o guard segue valendo para todo mundo),
-- reverte sozinho no fim da transacao, e nao pega ACCESS EXCLUSIVE em `tenants`
-- (que bloquearia ate as leituras do n8n). O `disable trigger`, se o script
-- abortasse entre desabilitar e reabilitar, deixaria o guard desligado em
-- producia em silencio; ja o `set local`, se rodar fora de transacao, so emite
-- warning e o update falha alto — modo de falha melhor.
--
-- Efeito colateral aceito: `replica` tambem suspende os demais triggers de
-- usuario nesta sessao, incluindo set_atualizado_em. Num rollback e desejavel
-- nao carimbar `atualizado_em`. Nao ha FK envolvida neste update.

begin;

set local session_replication_role = replica;

update public.tenants t
set chatwoot_token = c.chatwoot_token
from public.tenant_credenciais c
where c.tenant_id = t.id
  and c.chatwoot_token is not null
  and t.chatwoot_token is distinct from c.chatwoot_token;

-- ---------------------------------------------------------------------------
-- 2a. Restaura api_n8n_credencial_chatwoot para ler o token de tenants
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 2b. Restaura api_n8n_config_tool ao corpo da migracao 11
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 3. Remove a tabela segregada
-- ---------------------------------------------------------------------------
-- Depois de 2a e 2b: nenhuma funcao referencia mais tenant_credenciais.

drop table if exists public.tenant_credenciais;

commit;
