-- Rollback da 78 — aprendizado automático.
--
-- Devolve o guard à whitelist da 74, dropa as funções e a tabela.
--
-- O QUE ELE PERDE, e é deliberado: `kb_aprendizado` some com o histórico de
-- auditoria. Os CHUNKS já publicados na base ficam — eles são conteúdo do
-- cliente, aprovado por ele ao ligar o botão, e apagá-los seria destruir base
-- de conhecimento num rollback. Para removê-los é o caminho normal: excluir o
-- documento de origem `auto:<id>` pelo painel.
--
-- Idempotente: roda tendo a 78 sido aplicada ou não.

begin;

drop function if exists public.api_agente_aprendizado_ligado(uuid);
drop function if exists public.api_agente_aprendizado_dialogo(uuid, bigint, timestamptz, timestamptz);
drop function if exists public.api_agente_aprendizado_dialogo(uuid, uuid);
drop function if exists public.api_agente_kb_job_texto(uuid, text);
drop function if exists public.painel_aprendizado_recente(integer);
drop function if exists public.api_agente_aprendizado_concluir(uuid, bigint, uuid, text, text, text, text, text);
drop function if exists public.api_agente_aprendizado_pendentes(integer, integer);
drop table if exists public.kb_aprendizado;

-- O guard volta à whitelist da 74 (sem `aprendizado_auto`).
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

alter table public.tenants drop column if exists aprendizado_auto;

commit;
