-- Rollback de 09_api_n8n
--
-- Atencao: derruba o acesso do n8n. So rodar depois de reapontar o workflow
-- para o banco antigo (Coolify), nunca antes.

drop function if exists public.api_n8n_tools_ativas(uuid);
drop function if exists public.api_n8n_registrar_mensagem(uuid, bigint, text, text, integer, integer, text);
drop function if exists public.api_n8n_definir_status_conversa(uuid, bigint, text);
drop function if exists public.api_n8n_conversa_sync(uuid, bigint, text, text);
drop function if exists public.api_n8n_buscar_kb(uuid, vector, integer, jsonb);
drop function if exists public.api_n8n_credencial_chatwoot(uuid);
drop function if exists public.api_n8n_tenant_por_chatwoot(bigint);
drop function if exists public.n8n_assert_tenant(uuid);

revoke usage on schema extensions from n8n_agent;
revoke usage on schema public from n8n_agent;

drop role if exists n8n_agent;
