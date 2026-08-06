-- Rollback de 18_seguranca_tenant_tools.
--
-- Volta ao estado anterior: uma unica policy FOR ALL e sem trigger de guard.
-- ATENCAO: isto REABRE o furo da §4.1 (tenant_admin volta a poder auto-contratar
-- modulos pela API). Usar so para desfazer um deploy problematico, nunca como
-- estado final.

drop trigger if exists trg_tenant_tools_guard_colunas on public.tenant_tools;
drop function if exists public.tenant_tools_guard_colunas();

drop policy if exists p_tools_select on public.tenant_tools;
drop policy if exists p_tools_update on public.tenant_tools;
drop policy if exists p_tools_insert on public.tenant_tools;
drop policy if exists p_tools_delete on public.tenant_tools;

-- Recria a policy original (roles = public/all, como estava).
create policy p_tools_all on public.tenant_tools
  for all
  using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())
  with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());
