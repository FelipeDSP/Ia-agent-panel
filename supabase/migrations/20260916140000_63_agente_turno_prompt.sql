-- =====================================================================
-- 63. O cabeçalho do turno passa a saber qual prompt o atendeu
-- =====================================================================
--
-- Medido no primeiro turno real com modelo (16/09/2026, turno 8aa3265b):
-- `agente_turnos.perfil` e `prompt_hash` saíram NULOS, embora o passo 6
-- (`prompt`) e `agente_prompts` tivessem os dois. O turno é aberto ANTES de
-- o perfil ser resolvido (o sync, o portão de entrada e a mídia rodam
-- primeiro e precisam de turno para gravar passo), e `api_agente_turno_fechar`
-- não recebe perfil nem hash. O desenho §6 diz que o hash no turno é o que
-- torna um experimento atribuível a uma versão do prompt — ficar no passo
-- obriga a varrer `agente_passos` para responder "quantos turnos usaram o
-- prompt X", que é a pergunta inteira.
--
-- Escolha: uma função NOVA, chamada no instante em que o prompt existe,
-- em vez de acrescentar parâmetros ao `turno_fechar`. Dois motivos:
--   1. o prompt é conhecido no meio do turno; gravá-lo ali registra também
--      o turno que FALHA depois (erro do modelo) — que é justamente o que se
--      quer atribuir a uma versão de prompt;
--   2. `turno_fechar` fica com a assinatura da 62 — sem `drop` de assinatura
--      antiga, sem o par de armadilhas (aridade ambígua, grants apagados).
--
-- Só mexe em turno `aberto` do próprio tenant: turno de OUTRO tenant é
-- 22023 (como `api_agente_passo`); turno já fechado devolve `false` sem erro
-- (como `turno_fechar`). Não cria tabela, não cria coluna, não toca em extensão.
--
-- Grants: `revoke` ANTES do `grant`, os DOIS roles (`service_role` e
-- `n8n_agent`), pela lista de tipos — a nota das 40/41 no CLAUDE.md.
-- REEXECUTÁVEL: `drop if exists` + `create or replace`.
-- Rollback: `20260916140000_63_agente_turno_prompt_rollback.sql`.
-- =====================================================================

begin;

drop function if exists public.api_agente_turno_prompt(uuid, uuid, text, text);
create or replace function public.api_agente_turno_prompt(
  p_tenant_id uuid, p_turno_id uuid, p_perfil text, p_prompt_hash text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  if coalesce(btrim(p_prompt_hash), '') = '' then
    raise exception 'api_agente: p_prompt_hash e obrigatorio' using errcode = '22023';
  end if;
  -- como `api_agente_passo`: turno de outro tenant e erro de programa, nao `false`.
  if not exists (select 1 from public.agente_turnos t where t.id = p_turno_id and t.tenant_id = p_tenant_id) then
    raise exception 'api_agente: turno % nao e deste tenant', p_turno_id using errcode = '22023';
  end if;
  update public.agente_turnos t
     set perfil = p_perfil, prompt_hash = p_prompt_hash
   where t.id = p_turno_id and t.tenant_id = p_tenant_id and t.status = 'aberto';
  return found;
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.api_agente_turno_prompt(uuid, uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
    execute format('grant execute on function %s to n8n_agent', f);
  end loop;
end $$;

commit;
