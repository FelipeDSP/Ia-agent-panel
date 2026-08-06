-- 19_contratado_tenant_tools
--
-- §4.2 do ESPEC-CATALOGO-DE-TOOLS: separa dois significados que hoje moram na
-- coluna `ativo`.
--
--   - contratado  -> decisao COMERCIAL (Ordem de Servico). So super_admin altera.
--                    Cliente que desligou nao paga menos; cliente que nao
--                    contratou nao ve.
--   - ativo       -> decisao OPERACIONAL. O cliente liga/desliga um modulo que
--                    ja contratou.
--
-- api_n8n_tools_ativas passa a filtrar `contratado AND ativo`. A ASSINATURA NAO
-- MUDA (mesmo argumento, mesmas 4 colunas de saida) — o n8n em producao depende
-- dela; mudar a assinatura quebraria o agente da Acqua.
--
-- Todas as linhas existentes ganham contratado = true (default da coluna): a
-- Acqua e os demais nao perdem nenhuma tool. Como todas ficam contratado=true,
-- `contratado AND ativo` == `ativo` para os dados atuais — o retorno da funcao e
-- IDENTICO ao de antes desta migracao (verificado antes/depois de aplicar).
--
-- Seguranca: a coluna nova ja nasce PROTEGIDA para tenant_admin — o guard
-- tenant_tools_guard_colunas (migracao 18) usa whitelist {ativo, config}, entao
-- qualquer tentativa de tenant_admin mudar `contratado` cai em 42501 sem esta
-- migracao precisar tocar no guard.
--
-- Nao altera comportamento do painel: as actions atuais fazem update de
-- {ativo, config} (cliente) e upsert que na criacao pega o default (agencia).
--
-- Rollback: 20260805161935_19_contratado_tenant_tools_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Coluna contratado
-- ---------------------------------------------------------------------------

alter table public.tenant_tools
  add column if not exists contratado boolean not null default true;

comment on column public.tenant_tools.contratado is
  'Decisao comercial (Ordem de Servico): a agencia contratou o modulo. So '
  'super_admin altera (protegido pelo guard tenant_tools_guard_colunas). '
  '`ativo` e o liga/desliga do cliente. api_n8n_tools_ativas = contratado AND ativo.';

-- Explicito, ainda que o default ja cubra: documenta a intencao de que o estado
-- existente e "tudo contratado".
update public.tenant_tools set contratado = true where contratado is distinct from true;

-- ---------------------------------------------------------------------------
-- 2. api_n8n_tools_ativas: filtra contratado AND ativo (assinatura inalterada)
-- ---------------------------------------------------------------------------

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

-- create or replace preserva as permissoes, mas reafirmamos o invariante da
-- migracao 09 (so n8n_agent executa; anon/authenticated nunca) de forma explicita
-- e idempotente.
revoke all on function public.api_n8n_tools_ativas(uuid) from public;
revoke all on function public.api_n8n_tools_ativas(uuid) from anon, authenticated;
grant execute on function public.api_n8n_tools_ativas(uuid) to n8n_agent;
