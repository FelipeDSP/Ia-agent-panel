-- =====================================================================
-- 58. Fecha o ACL de `produtos_atribui_sku` — defeito da 57
-- =====================================================================
--
-- ESTA MIGRACAO EXISTE PORQUE A 57 ESQUECEU UM BLOCO, e o esquecimento tem nome
-- no CLAUDE.md: "esquecer o bloco de grants nao deixa o agente sem acesso:
-- deixa a funcao ABERTA".
--
-- A 57 escreveu `revoke`/`grant` para as tres TABELAS que criou (`categorias`,
-- `produto_sku_seq`, `backfill_57_nome_original`) e NAO escreveu para a FUNCAO
-- `produtos_atribui_sku()`. Como toda funcao nova neste projeto, ela nasceu com
-- EXECUTE para PUBLIC, `anon` e `authenticated`:
--
--   =X/postgres | postgres=X | anon=X | authenticated=X | service_role=X
--
-- Quem pegou foram `npm run teste:grants-n8n` e `npm run teste:acl-secdef`, na
-- primeira execucao da suite depois do apply. A guarda existe exatamente para
-- isto e funcionou.
--
-- ---------------------------------------------------------------------
-- A GRAVIDADE, MEDIDA — nao e incidente, e e anomalia mesmo assim
--
-- Tres medicoes, para o registro nao ficar nem alarmista nem complacente:
--
--   a) chamada direta e RECUSADA pelo proprio Postgres:
--      `select public.produtos_atribui_sku()` como `anon` devolve
--      `0A000 trigger functions can only be called as triggers`. Nao ha
--      caminho de exploracao pelo ACL aberto;
--   b) as TRES trigger functions irmas (`set_atualizado_em`,
--      `pedidos_recalcula_total`, `pedido_itens_herda_tenant`) tem a MESMA forma
--      aberta. A minha nao destoa do que ja existia;
--   c) mas nenhuma das tres e `SECURITY DEFINER`, e a minha e. E essa a
--      diferenca que a guarda enxerga, e ela esta certa em enxergar: a regra do
--      projeto e sobre a FORMA do ACL, nao sobre a explorabilidade de hoje.
--      "Nao da para explorar agora" e o raciocinio que a nota do `arwdDxtm`
--      recusa.
--
-- POR QUE A FUNCAO PRECISA SER `SECURITY DEFINER`: ela escreve em
-- `produto_sku_seq`, que `authenticated` nao alcanca (RLS ativo, sem policy,
-- sem grant). A alternativa seria dar escrita no contador ao `authenticated` e
-- tirar o `SECURITY DEFINER` — o que exporia o contador a manipulacao direta, e
-- um contador manipulavel devolve numero ja usado. Fica `SECURITY DEFINER`.
--
-- REVOGAR NAO QUEBRA O TRIGGER, e isso foi TESTADO e nao suposto: com o EXECUTE
-- revogado de `public`, `anon` e `authenticated`, um INSERT em `produtos` feito
-- como `authenticated` continuou gerando o sku (saiu 42, o proximo do emporio).
-- O Postgres nao checa EXECUTE do invocador ao disparar trigger.
--
-- ---------------------------------------------------------------------
-- A FORMA ALVO: `postgres+service_role`
--
-- Toda SECURITY DEFINER de `public` cai em uma de tres formas conhecidas, e o
-- teste reprova forma nova. Esta e helper interno — ninguem a chama pelo nome —,
-- entao vai para `postgres+service_role`, a mesma dos outros oito helpers.
--
-- POR QUE NAO EDITEI A 57: ela JA RODOU em producao. O texto de uma migracao
-- aplicada tem de continuar sendo o texto que rodou, senao o arquivo deixa de
-- descrever o banco e passa a descrever a intencao. Ambiente novo aplica 57 e
-- depois 58 e chega no mesmo lugar.
--
-- ROLLBACK: 20260910163000_58_acl_da_trigger_de_sku_rollback.sql
--   Ele DEVOLVE o ACL aberto, porque e o estado de antes. Rollback que "melhora"
--   deixa de ser rollback.
-- =====================================================================

begin;

-- `revoke` ANTES do grant, e nao e redundancia: sem ele o grant e decoracao
-- sobre um objeto que ja nasceu publico.
revoke all on function public.produtos_atribui_sku() from public;
revoke all on function public.produtos_atribui_sku() from anon;
revoke all on function public.produtos_atribui_sku() from authenticated;

grant execute on function public.produtos_atribui_sku() to service_role;

commit;
