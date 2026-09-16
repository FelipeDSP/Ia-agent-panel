-- =====================================================================
-- ROLLBACK da 66 — tira a função e as duas colunas.
-- Perde o que a agência tiver configurado (volta ao 40 e ao PIX cravados no
-- código, que continuam sendo os defaults do serviço quando a função não
-- existe). Extensão: nenhuma. REEXECUTÁVEL.
-- =====================================================================

begin;

drop function if exists public.api_agente_config(uuid);
alter table public.tenants drop constraint if exists tenants_memoria_silencio_minutos_check;
alter table public.tenants drop constraint if exists tenants_pagamento_formas_check;
alter table public.tenants
  drop column if exists memoria_silencio_minutos,
  drop column if exists pagamento_formas;

commit;
