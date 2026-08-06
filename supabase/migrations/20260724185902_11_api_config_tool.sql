-- 11_api_config_tool
--
-- Arquivo reconstruido em 2026-08-05 a partir de pg_get_functiondef() no banco
-- de producao: a migracao consta no ledger (20260724185902) desde 24/07, mas
-- nunca foi versionada aqui. O corpo abaixo e byte a byte o que esta rodando.
--
-- O QUE ELA RESOLVE
--
-- O sub-workflow de transferencia para humano precisa de tres coisas ao mesmo
-- tempo: para onde postar no Chatwoot (url + token), se a tool esta ligada para
-- aquele cliente, e a config dela (horario de atendimento, canal e destino da
-- notificacao). Sem esta funcao seriam duas chamadas — api_n8n_credencial_chatwoot
-- e api_n8n_tools_ativas — e o n8n teria que casar os resultados no meio do
-- fluxo, com o token trafegando por mais um node (a saida dos nodes vai para o
-- log de execucao do n8n).
--
-- LEFT JOIN e nao INNER: cliente sem linha em tenant_tools para aquela tool
-- devolve tool_ativa = FALSE em vez de nenhuma linha. Zero linhas obrigaria o
-- workflow a distinguir "tool desligada" de "tenant inexistente", que sao
-- tratamentos diferentes — e o n8n erra esse tipo de ramificacao em silencio.
--
-- O isolamento vem de n8n_assert_tenant (migracao 09): tenant obrigatorio, vivo
-- e ativo. Como toda api_n8n_*, e SECURITY DEFINER com EXECUTE so para
-- n8n_agent — o revoke em massa no fim da 09 alcanca esta funcao tambem, desde
-- que ela seja criada ANTES daquele bloco rodar. Como a 11 vem depois, o grant
-- vai explicito aqui embaixo.
--
-- Rollback: 20260724185902_11_api_config_tool_rollback.sql

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

-- Mesmo fechamento das demais api_n8n_*: o Postgres da EXECUTE a PUBLIC em toda
-- funcao nova, e esta e SECURITY DEFINER e devolve o token do Chatwoot. Sem o
-- revoke, anon chamaria passando qualquer tenant_id.
revoke all on function public.api_n8n_config_tool(uuid, text) from public;
revoke all on function public.api_n8n_config_tool(uuid, text) from anon, authenticated;
grant execute on function public.api_n8n_config_tool(uuid, text) to n8n_agent;
