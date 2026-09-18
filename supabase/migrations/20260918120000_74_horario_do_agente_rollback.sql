-- =====================================================================
-- ROLLBACK da 74 — tira o horário de atendimento do agente
-- =====================================================================
-- Dropar `horario_agente` PERDE o horário que os clientes configuraram
-- (voltam a "sempre aberto"); `aviso_fora_horario_em` é controle. Não é
-- financeiro: não aborta. O guard volta ao corpo anterior, verbatim
-- (pg_get_functiondef em 18/09/2026). REEXECUTÁVEL.
-- =====================================================================

begin;

drop function if exists public.api_agente_aviso_fora_horario(uuid, bigint, integer);
drop function if exists public.api_agente_horario(uuid);

CREATE OR REPLACE FUNCTION public.tenants_guard_colunas()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if public.auth_is_super_admin() then
    return new;
  end if;

  if (to_jsonb(new) - '{system_prompt,agente_ativo,debounce_segundos,msg_midia_nao_suportada,msg_fora_escopo,atualizado_em}'::text[])
     is distinct from
     (to_jsonb(old) - '{system_prompt,agente_ativo,debounce_segundos,msg_midia_nao_suportada,msg_fora_escopo,atualizado_em}'::text[])
  then
    raise exception
      'Sem permissao: tenant_admin so pode alterar prompt, mensagens, debounce e agente_ativo. Modelo, temperatura, tokens, slug, status e nome sao da agencia.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$
;

alter table public.conversas drop column if exists aviso_fora_horario_em;
alter table public.tenants drop constraint if exists tenants_horario_agente_objeto;
alter table public.tenants drop column if exists horario_agente;

commit;
