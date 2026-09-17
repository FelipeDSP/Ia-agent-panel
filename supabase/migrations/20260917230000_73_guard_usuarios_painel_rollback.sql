-- =====================================================================
-- ROLLBACK da 73 — tira a guarda de colunas de usuarios_painel
-- =====================================================================
-- Volta ao estado em que o proprio usuario reescreve papel/tenant_id da
-- sua linha (achado 2 da analise de 17/09). REEXECUTÁVEL.
-- =====================================================================

begin;

drop trigger if exists trg_usuarios_painel_guard_colunas on public.usuarios_painel;
drop function if exists public.usuarios_painel_guard_colunas();

commit;
