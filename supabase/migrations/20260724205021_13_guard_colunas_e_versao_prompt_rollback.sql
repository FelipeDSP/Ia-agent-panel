-- Rollback de 13_guard_colunas_e_versao_prompt
--
-- ATENCAO: remover o guard reabre o buraco em que o tenant_admin pode alterar
-- modelo, temperatura e tokens da propria linha. So use se o guard causar algo
-- pior. As versoes ja gravadas em prompt_versoes permanecem.

drop trigger if exists trg_tenants_versionar_prompt on public.tenants;
drop trigger if exists trg_tenants_guard_colunas on public.tenants;

drop function if exists public.tenants_versionar_prompt();
drop function if exists public.tenants_guard_colunas();
