-- Migracao 43 — fecha o ACL de sete funcoes SECURITY DEFINER abertas a anon
--
-- ============================ O QUE ESTA EM JOGO ============================
--
-- `api_n8n_pode_transcrever` e `api_n8n_enviar_foto` DEVOLVEM `chatwoot_token`,
-- e as duas estavam executaveis por `anon` — a chave publicavel, a que vai no
-- bundle do navegador.
--
-- NAO E INFERENCIA DE CATALOGO. Verificado em 18/08/2026 chamando de verdade,
-- por HTTPS, com a chave publicavel e sem sessao nenhuma:
--
--   POST /rest/v1/rpc/api_n8n_pode_transcrever  {"p_tenant_id": "<uuid>", ...}
--   -> HTTP 200, com `chatwoot_token` preenchido (24 chars)
--
-- O controle na mesma rodada: `api_n8n_buscar_produtos`, que ja estava fechada,
-- respondeu `42501 permission denied`. Ou seja, o metodo funciona e o que separa
-- uma da outra e exatamente o grant.
--
-- Basta o `tenant_id` — que e UUID, mas circula: aparece em URL do painel de
-- admin, em link compartilhado, em captura de tela. Quem tiver um, tem o token
-- do Chatwoot daquele cliente, e com ele fala pelo WhatsApp da loja.
--
-- ISSO REABRE O QUE A MIGRACAO 21 FECHOU, por outra porta e com role mais
-- aberto: a 21 tirou `chatwoot_token` de `tenants` para tirar a credencial do
-- alcance do painel, e estas funcoes a devolvem por RPC publica.
--
-- ======================= POR QUE NAO HA `DROP FUNCTION` =====================
--
-- Esta migracao NAO recria funcao nenhuma: e SO ACL. Nenhum corpo muda, nenhuma
-- assinatura muda, nenhuma aridade nova aparece. Com isso ela nao tem a classe
-- de armadilha das migracoes 28, 32, 37, 40, 41 e 42 — nao ha ambiguidade
-- possivel e nao ha grant perdido por recriacao. O unico risco e o inverso, e e
-- o da 41: **revogar sem conceder**.
--
-- ================== A ARMADILHA DA 41, AQUI EM SETE FUNCOES =================
--
-- Nenhuma das sete tem `n8n_agent` no ACL hoje. As tres que o n8n chama de fato
-- funcionam HOJE pelo grant implicito a PUBLIC. Revogar de PUBLIC sem conceder
-- explicitamente a `n8n_agent` derruba, na ordem: o envio de foto, a
-- transcricao de audio e a guarda do `resolver_conversa`.
--
-- Conferido quem chama o que, por varredura em `n8n/workflows/`:
--
--   api_n8n_enviar_foto          -> tool-enviar-foto.json
--   api_n8n_pode_transcrever     -> agente-principal.json
--   api_n8n_tem_pedido_pendente  -> Tool - Resolver Conversa (Multi-Tenant).json
--   pedido_aberto_da_conversa    -> (ninguem: interna)
--   expirar_pedidos_vencidos     -> (ninguem: interna)
--   pedido_horas_para_expirar    -> (ninguem: interna)
--   tenants_versionar_prompt     -> (ninguem: e TRIGGER)
--
-- As tres internas ficam so com `service_role`, que e o padrao ja praticado por
-- `n8n_assert_tenant` e `pedido_em_texto` — as duas SECURITY DEFINER internas
-- que ja estavam certas. Funcao chamada de DENTRO de outra roda com os
-- privilegios do dono; grant para o chamador nao e necessario.
--
-- `tenants_versionar_prompt` retorna `trigger`: nao da para invocar direto (o
-- Postgres recusa e o PostgREST nao expoe), entao nao era vetor. O revoke entra
-- por higiene, para a varredura de propriedade nao precisar de excecao.
--
-- ===================== O QUE ESTA MIGRACAO NAO TOCA ========================
--
-- `billing_consumo_mensal`, `billing_volume_mensal`, `conversa_historico` e
-- `agendar_podcast` tem `authenticated` e NAO tem `anon`. Sao chamadas pelo
-- painel, pelo cliente Supabase com a sessao do usuario — ou seja, o role
-- `authenticated` e o correto ali, e revogar quebraria a tela. Estao fora de
-- proposito: a propriedade que se quer nao e "nenhuma funcao tem grant", e sim
-- "nenhuma SECURITY DEFINER esta ao alcance de quem nao se autenticou".
--
-- VERIFICACAO: tests/migracao-acl-security-definer.mjs — chamada real com
-- `set local role`, incluindo o contra-teste (n8n_agent passa no MESMO comando
-- em que anon leva 42501).
--
-- ROLLBACK: 20260818180000_43_fechar_acl_security_definer_rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. As tres que o n8n chama: fecham para fora, abrem para os dois roles reais.
--    A linha de `n8n_agent` e a que o agente usa em producao — ela nao e
--    redundante com a de `service_role`, e era a que faltava.
-- ---------------------------------------------------------------------------
revoke all on function public.api_n8n_enviar_foto(uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function public.api_n8n_enviar_foto(uuid, bigint, uuid) to service_role;
grant execute on function public.api_n8n_enviar_foto(uuid, bigint, uuid) to n8n_agent;

revoke all on function public.api_n8n_pode_transcrever(uuid, bigint) from public, anon, authenticated;
grant execute on function public.api_n8n_pode_transcrever(uuid, bigint) to service_role;
grant execute on function public.api_n8n_pode_transcrever(uuid, bigint) to n8n_agent;

revoke all on function public.api_n8n_tem_pedido_pendente(uuid, bigint) from public, anon, authenticated;
grant execute on function public.api_n8n_tem_pedido_pendente(uuid, bigint) to service_role;
grant execute on function public.api_n8n_tem_pedido_pendente(uuid, bigint) to n8n_agent;

-- ---------------------------------------------------------------------------
-- 2. As tres internas: so `service_role`, como `n8n_assert_tenant` ja faz.
--    Sao chamadas de dentro de outras funcoes, que rodam como o dono.
-- ---------------------------------------------------------------------------
revoke all on function public.pedido_aberto_da_conversa(uuid, bigint) from public, anon, authenticated;
grant execute on function public.pedido_aberto_da_conversa(uuid, bigint) to service_role;

revoke all on function public.expirar_pedidos_vencidos(uuid, bigint) from public, anon, authenticated;
grant execute on function public.expirar_pedidos_vencidos(uuid, bigint) to service_role;

revoke all on function public.pedido_horas_para_expirar(uuid) from public, anon, authenticated;
grant execute on function public.pedido_horas_para_expirar(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Trigger: nao era vetor (nao se invoca direto), mas fica no padrao.
--    Trigger dispara com os privilegios do dono da tabela; nao precisa de grant.
-- ---------------------------------------------------------------------------
revoke all on function public.tenants_versionar_prompt() from public, anon, authenticated;

commit;
