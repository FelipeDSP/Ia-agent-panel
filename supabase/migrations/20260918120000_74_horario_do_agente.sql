-- =====================================================================
-- 74 — Horário de atendimento do agente
-- =====================================================================
-- Conversa 39 do Empório (17/09, uma segunda-feira, dia em que não abrem): o
-- agente montou pedido e o dono respondeu à mão "não abrimos às segundas".
-- Só existia horário para a TRANSFERÊNCIA (quando há humano); faltava o do
-- estabelecimento, decidido pelo cliente.
--
--   * `tenants.horario_agente jsonb` — NULL = sempre aberto (o comportamento
--     de hoje). Forma (o painel valida; o serviço lê com defaults):
--       { timezone, dias_semana[], hora_inicio, hora_fim,
--         fechados: ['2026-12-25', …],           -- datas fechadas (feriados)
--         fora_horario: 'aviso' | 'silencio' | 'atender',
--         mensagem: 'texto do aviso' }
--     Entra na whitelist de `tenants_guard_colunas`: é do CLIENTE.
--   * `conversas.aviso_fora_horario_em` — quando a conversa recebeu o último
--     aviso de "estamos fechados"; o aviso é UM por conversa por período.
--   * `api_agente_horario(uuid)` — o jsonb, para o serviço.
--   * `api_agente_aviso_fora_horario(uuid, bigint, integer)` — o claim do
--     aviso: TRUE (e grava) se a conversa não foi avisada nas últimas N horas.
--
-- Só o serviço em código muda de comportamento; o n8n congelado não lê nada
-- disto. `create or replace` do guard de mesma assinatura. Extensão: nenhuma.
-- REEXECUTÁVEL.
-- =====================================================================

begin;

alter table public.tenants add column if not exists horario_agente jsonb;
alter table public.tenants drop constraint if exists tenants_horario_agente_objeto;
alter table public.tenants add constraint tenants_horario_agente_objeto
  check (horario_agente is null or jsonb_typeof(horario_agente) = 'object');
comment on column public.tenants.horario_agente is
  '74: horário de atendimento do AGENTE (do cliente). NULL = sempre aberto. {timezone, dias_semana, hora_inicio, hora_fim, fechados[], fora_horario: aviso|silencio|atender, mensagem}.';

alter table public.conversas add column if not exists aviso_fora_horario_em timestamptz;
comment on column public.conversas.aviso_fora_horario_em is
  '74: último aviso "estamos fechados" enviado nesta conversa (um por período).';

-- ---- o guard: horario_agente é do cliente --------------------------------
CREATE OR REPLACE FUNCTION public.tenants_guard_colunas()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if public.auth_is_super_admin() then
    return new;
  end if;

  if (to_jsonb(new) - '{system_prompt,agente_ativo,debounce_segundos,msg_midia_nao_suportada,msg_fora_escopo,horario_agente,atualizado_em}'::text[])
     is distinct from
     (to_jsonb(old) - '{system_prompt,agente_ativo,debounce_segundos,msg_midia_nao_suportada,msg_fora_escopo,horario_agente,atualizado_em}'::text[])
  then
    raise exception
      'Sem permissao: tenant_admin so pode alterar prompt, mensagens, debounce, agente_ativo e horario_agente. Modelo, temperatura, tokens, slug, status e nome sao da agencia.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$
;

-- ---- o que o serviço lê ----------------------------------------------------
create or replace function public.api_agente_horario(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select t.horario_agente from public.tenants t where t.id = p_tenant_id and t.deletado_em is null;
$function$;

-- Claim atômico pelo `where`: duas mensagens no mesmo debounce não geram dois
-- avisos; a janela (horas) é o que separa "fechado agora" de "fechado de novo
-- amanhã". Piso de 1 h para o parâmetro não desligar a idempotência.
create or replace function public.api_agente_aviso_fora_horario(
  p_tenant_id uuid, p_conversation_id bigint, p_janela_horas integer default 12)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_janela integer := greatest(coalesce(p_janela_horas, 12), 1);
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  update public.conversas c
     set aviso_fora_horario_em = now()
   where c.tenant_id = p_tenant_id
     and c.conversation_id = p_conversation_id
     and (c.aviso_fora_horario_em is null
          or c.aviso_fora_horario_em < now() - make_interval(hours => v_janela));
  return found;
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.api_agente_horario(uuid)',
    'public.api_agente_aviso_fora_horario(uuid, bigint, integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
    execute format('grant execute on function %s to n8n_agent', f);
  end loop;
end $$;

commit;
