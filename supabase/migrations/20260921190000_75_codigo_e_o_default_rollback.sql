-- Rollback da 75: o default volta a 'n8n' (o da migração 62).
--
-- Os tenants que a 75 passou de 'n8n' para 'codigo' NÃO voltam: a migração
-- não guardou quais eram, e devolver todo mundo a 'n8n' emudeceria os
-- clientes reais (o serviço descarta tenant fora de 'codigo'). Se um dia
-- precisar, é `update` à mão, tenant a tenant.
--
-- Idempotente: pode rodar tendo a 75 sido aplicada ou não.

begin;

alter table public.tenants
  alter column agente_runtime set default 'n8n';

comment on column public.tenants.agente_runtime is
  'Quem atende as mensagens deste tenant: n8n (o workflow) ou codigo (o servico agente/). Agencia-only pelo guard; o painel usa para chamar o "limpar memoria" certo e o alarme de agente mudo usa para saber quem vigiar.';

commit;
