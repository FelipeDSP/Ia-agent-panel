-- Rollback de 15_billing
--
-- Remove funcoes e tabelas de billing. uso_ingestao e precos_modelo sao novas
-- desta fase; dropar nao afeta conversa nem o agente em producao.

drop function if exists public.conversa_historico(bigint);
drop function if exists public.billing_volume_mensal();
drop function if exists public.billing_consumo_mensal();

-- Restaura o acesso de linha do tenant a mensagens_log (estado anterior).
-- Atencao: reabre a leitura de tokens_entrada/saida por SELECT direto do tenant.
drop policy if exists p_log_super on public.mensagens_log;
create policy p_log_all on public.mensagens_log
  for all to public
  using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id()))
  with check (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id()));

drop table if exists public.uso_ingestao;
drop table if exists public.precos_modelo;
