-- Rollback de 26_api_n8n_vendas
--
-- Remove as sete funcoes de venda e os tres auxiliares. NAO toca em dado: as
-- tabelas e os pedidos ficam intactos — quem os remove e o rollback da 25.
--
-- ORDEM: rode ESTE ANTES do rollback da 25. As funcoes referenciam `pedidos` e
-- `pedido_itens`, e corpo de plpgsql e opaco para o pg_depend: dropar as tabelas
-- primeiro passaria verde e deixaria as funcoes apontando para relacao
-- inexistente, estourando so em runtime, no meio de uma conversa com cliente. E
-- a mesma classe de falha da migracao 21.
--
-- EFEITO IMEDIATO NO AGENTE: os sub-workflows de venda param de funcionar assim
-- que isto rodar. Desligue as tools em `tenant_tools` (ou remova os nos do
-- workflow principal) ANTES, senao o agente chama funcao inexistente e o cliente
-- recebe erro no meio do pedido.

begin;

drop function if exists public.api_n8n_tem_pedido_pendente(uuid, bigint);
drop function if exists public.api_n8n_cancelar_pedido(uuid, bigint);
drop function if exists public.api_n8n_fechar_pedido(uuid, bigint, jsonb);
drop function if exists public.api_n8n_ver_pedido(uuid, bigint);
drop function if exists public.api_n8n_remover_item(uuid, bigint, uuid);
drop function if exists public.api_n8n_adicionar_item(uuid, bigint, uuid, integer, text);
drop function if exists public.api_n8n_buscar_produtos(uuid, text);

-- Auxiliares depois: as funcoes acima os chamam.
drop function if exists public.pedido_aberto_da_conversa(uuid, bigint);
drop function if exists public.pedido_em_texto(uuid);

-- `centavos_brl` por ultimo. Se a tela do painel passar a usa-la, REMOVA esta
-- linha — derruba-la quebraria a formatacao de preco no painel tambem.
drop function if exists public.centavos_brl(integer);

commit;
