-- =====================================================================
-- 66. Duas configurações do agente por tenant: silêncio da memória e
--     formas de pagamento do link
-- =====================================================================
--
-- `memoria_silencio_minutos` — quantos minutos de silêncio na conversa fazem
-- o agente ESQUECER (a memória vem de `mensagens_log`; passado o silêncio, a
-- próxima mensagem começa do zero). Era 40 cravado no código
-- (`api_agente_memoria(…, 40, 20)`, decisão do commit 5e717f4: "esquecer é
-- mais seguro"). O Felipe perguntou por 2 h em 16/09; um curso on-line e uma
-- padaria não têm o mesmo ritmo, então vira coluna, default 40.
--
-- `pagamento_formas` — o que o link de pagamento oferece. A tool mandava
-- `billingType: 'PIX'` cravado; o Asaas aceita PIX, CREDIT_CARD, BOLETO — e
-- `UNDEFINED` (o cliente escolhe entre o que a CONTA tem habilitado). Aqui:
-- uma forma -> vai ela; mais de uma -> `UNDEFINED`. Default `{PIX}`, que é o
-- comportamento de hoje. BOLETO fica permitido no CHECK mas a janela de 30 min
-- não combina com ele (docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md) — decisão de
-- quem ligar.
--
-- As duas nascem AGÊNCIA-ONLY de graça: `tenants_guard_colunas` compara
-- `to_jsonb(new) - <lista branca>`, coluna fora da lista é 42501 para
-- `tenant_admin`. O teste afirma que não estão na lista.
--
-- `api_agente_config(uuid)` — o serviço lê as duas numa chamada; NÃO mexe em
-- `api_n8n_tenant_por_chatwoot` (que o n8n congelado ainda chama) para não
-- trocar tipo de retorno de função viva. Grants: revoke antes, os DOIS roles.
-- Extensão: nenhuma. REEXECUTÁVEL. Rollback ao lado.
-- =====================================================================

begin;

alter table public.tenants
  add column if not exists memoria_silencio_minutos integer not null default 40,
  add column if not exists pagamento_formas text[] not null default '{PIX}';

alter table public.tenants drop constraint if exists tenants_memoria_silencio_minutos_check;
alter table public.tenants add constraint tenants_memoria_silencio_minutos_check
  check (memoria_silencio_minutos between 1 and 1440);

alter table public.tenants drop constraint if exists tenants_pagamento_formas_check;
alter table public.tenants add constraint tenants_pagamento_formas_check
  check (cardinality(pagamento_formas) >= 1 and pagamento_formas <@ array['PIX','CREDIT_CARD','BOLETO']::text[]);

comment on column public.tenants.memoria_silencio_minutos is
  'Minutos de silencio na conversa apos os quais o agente esquece o historico (66). Agencia-only. Era 40 cravado.';
comment on column public.tenants.pagamento_formas is
  'Formas do link de pagamento (Asaas): subconjunto de {PIX, CREDIT_CARD, BOLETO}. Uma -> billingType dela; varias -> UNDEFINED (cliente escolhe). Agencia-only.';

drop function if exists public.api_agente_config(uuid);
create or replace function public.api_agente_config(p_tenant_id uuid)
returns table(memoria_silencio_minutos integer, memoria_janela_pares integer, pagamento_formas text[])
language sql
stable
security definer
set search_path to 'public'
as $function$
  select t.memoria_silencio_minutos, 20, t.pagamento_formas
    from public.tenants t
   where t.id = p_tenant_id and t.deletado_em is null;
$function$;

do $$
declare f text;
begin
  foreach f in array array['public.api_agente_config(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
    execute format('grant execute on function %s to n8n_agent', f);
  end loop;
end $$;

commit;
