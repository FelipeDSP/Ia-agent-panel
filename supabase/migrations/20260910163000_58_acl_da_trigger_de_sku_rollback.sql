-- =====================================================================
-- ROLLBACK da 58 — devolve o ACL aberto de `produtos_atribui_sku`
-- =====================================================================
--
-- O QUE ELE FAZ, E POR QUE ISSO PARECE ERRADO E NAO E: devolve o EXECUTE a
-- PUBLIC, `anon` e `authenticated`, que e como a funcao estava depois da 57.
--
-- Rollback restaura o estado ANTERIOR, inclusive quando o estado anterior era o
-- defeito. Um rollback que "melhora" alguma coisa deixa de ser rollback e vira
-- migracao nao versionada — e a proxima pessoa que o rodasse acharia que voltou
-- ao ponto de partida sem ter voltado.
--
-- Na pratica isto e quase inocuo: chamada direta e recusada com
-- `0A000 trigger functions can only be called as triggers`, e as tres trigger
-- functions irmas tem a mesma forma. Mas o motivo de reverter e o de cima, nao
-- este.
--
-- REEXECUTAVEL: `grant` repetido nao acumula nada.
-- =====================================================================

begin;

grant execute on function public.produtos_atribui_sku() to public;
grant execute on function public.produtos_atribui_sku() to anon;
grant execute on function public.produtos_atribui_sku() to authenticated;
grant execute on function public.produtos_atribui_sku() to service_role;

commit;
