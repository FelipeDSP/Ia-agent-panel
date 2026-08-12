-- Rollback da migracao 30 — volta api_n8n_config_tool a ignorar `contratado`
--
-- ATENCAO: rodar isto REABRE o furo. A trava `Vendas Ativa?` dos sub-workflows
-- volta a liberar tool com `contratado = false, ativo = true`, e a defesa em
-- duas camadas volta a ser uma.
--
-- So faz sentido se a 30 quebrar alguma coisa inesperada em producao e for
-- preciso ganhar tempo. Nesse caso, descontrate a tool pelo painel
-- (`ativo = false`) enquanto investiga -- ai as duas funcoes concordam de novo,
-- por outro caminho.
--
-- Corpo exatamente como estava antes da 30, capturado de
-- pg_get_functiondef em producao em 12/08/2026.

begin;

create or replace function public.api_n8n_config_tool(p_tenant_id uuid, p_tool_nome text)
returns table(chatwoot_url text, chatwoot_token text, tool_ativa boolean, config jsonb)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  return query
  select t.chatwoot_url,
         c.chatwoot_token,
         coalesce(tt.ativo, false),
         coalesce(tt.config, '{}'::jsonb)
  from public.tenants t
  left join public.tenant_credenciais c
         on c.tenant_id = t.id
  left join public.tenant_tools tt
         on tt.tenant_id = t.id and tt.tool_nome = p_tool_nome
  where t.id = p_tenant_id;
end;
$function$;

commit;
