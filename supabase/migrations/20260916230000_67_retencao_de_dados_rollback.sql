-- =====================================================================
-- ROLLBACK da 67 — tira a função de retenção. O que ela já apagou não
-- volta (é a natureza da retenção); o serviço passa a logar a falha da
-- chamada diária até a 67 ser reaplicada. Extensão: nenhuma. REEXECUTÁVEL.
-- =====================================================================

begin;

drop function if exists public.api_agente_retencao(integer, integer, integer, integer);

commit;
