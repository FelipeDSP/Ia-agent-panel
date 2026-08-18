-- Rollback da migracao 43 — reabre o ACL das sete funcoes
--
-- AVISO, e ele e o ponto todo: este script REABRE `api_n8n_pode_transcrever` e
-- `api_n8n_enviar_foto` — que devolvem `chatwoot_token` — para `anon`, a chave
-- que vai no bundle do navegador. Foi verificado em 18/08 que, nesse estado, o
-- token de qualquer tenant sai por HTTPS sem autenticacao, bastando o
-- `tenant_id`.
--
-- Ele existe porque toda migracao precisa de caminho de volta, e porque
-- rollback que devolve OUTRO estado nao e rollback. Mas rodar este arquivo
-- inteiro reintroduz uma exposicao de credencial conhecida.
--
-- SE O MOTIVO DO ROLLBACK FOR "o agente parou de funcionar": o problema NAO e o
-- revoke de anon — e o grant a `n8n_agent`. Rode so a secao 1 abaixo, que
-- devolve o acesso do agente sem reabrir para o publico. A secao 2 e a que
-- reabre, e so deve rodar se a intencao for mesmo voltar ao estado anterior por
-- inteiro.

begin;

-- ---------------------------------------------------------------------------
-- SECAO 1 — devolve o que o AGENTE precisa (seguro, nao reabre para ninguem)
--
-- Antes da 43 estas funcoes nao tinham grant a `n8n_agent`: o agente executava
-- pelo grant implicito a PUBLIC. Manter estas tres linhas depois do rollback e
-- inofensivo e evita que a secao 2 seja a unica coisa segurando producao.
-- ---------------------------------------------------------------------------
grant execute on function public.api_n8n_enviar_foto(uuid, bigint, uuid) to n8n_agent;
grant execute on function public.api_n8n_pode_transcrever(uuid, bigint) to n8n_agent;
grant execute on function public.api_n8n_tem_pedido_pendente(uuid, bigint) to n8n_agent;

-- ---------------------------------------------------------------------------
-- SECAO 2 — devolve o estado anterior DE VERDADE, exposicao inclusa.
--
-- <<< E ESTA A PARTE QUE REABRE O VAZAMENTO DO TOKEN. >>>
-- Comente o bloco inteiro se voce quer desfazer a 43 mas MANTER o fechamento.
-- ---------------------------------------------------------------------------
grant execute on function public.api_n8n_enviar_foto(uuid, bigint, uuid) to public, anon, authenticated;
grant execute on function public.api_n8n_pode_transcrever(uuid, bigint) to public, anon, authenticated;
grant execute on function public.api_n8n_tem_pedido_pendente(uuid, bigint) to public, anon, authenticated;
grant execute on function public.pedido_aberto_da_conversa(uuid, bigint) to public, anon, authenticated;
grant execute on function public.expirar_pedidos_vencidos(uuid, bigint) to public, anon, authenticated;
grant execute on function public.pedido_horas_para_expirar(uuid) to public, anon, authenticated;
grant execute on function public.tenants_versionar_prompt() to public, anon, authenticated;

-- `service_role` tinha grant explicito antes e continua tendo; nao foi tocado
-- pela 43 alem do revoke/grant no mesmo comando, mas fica declarado para o
-- rollback ser autossuficiente.
grant execute on function public.api_n8n_enviar_foto(uuid, bigint, uuid) to service_role;
grant execute on function public.api_n8n_pode_transcrever(uuid, bigint) to service_role;
grant execute on function public.api_n8n_tem_pedido_pendente(uuid, bigint) to service_role;
grant execute on function public.pedido_aberto_da_conversa(uuid, bigint) to service_role;
grant execute on function public.expirar_pedidos_vencidos(uuid, bigint) to service_role;
grant execute on function public.pedido_horas_para_expirar(uuid) to service_role;
grant execute on function public.tenants_versionar_prompt() to service_role;

commit;
