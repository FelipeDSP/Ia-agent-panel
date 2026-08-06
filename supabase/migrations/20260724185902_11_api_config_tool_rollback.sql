-- Rollback de 11_api_config_tool
--
-- Derruba a funcao. O sub-workflow de transferencia para humano no n8n para de
-- funcionar na hora — ele chama api_n8n_config_tool por nome. Antes de rodar
-- isto, troque o node por duas chamadas (api_n8n_credencial_chatwoot +
-- api_n8n_tools_ativas) ou aceite que a transferencia fica fora do ar.
--
-- Nada mais depende dela: nenhuma policy, nenhum trigger, nenhuma outra funcao.

drop function if exists public.api_n8n_config_tool(uuid, text);
