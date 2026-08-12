-- Rollback da migracao 32
--
-- RECUSA rodar se ja houver duracao de audio registrada: dropar a coluna
-- apagaria a base do rateio de audio, e isso nao volta. Se o objetivo e mesmo
-- desfazer, exporte antes.
--
-- Dropa as DUAS assinaturas antes de recriar a antiga, pelo mesmo motivo que a
-- 32 dropou a de 7: com DEFAULT no ultimo parametro, deixar as duas vivas torna
-- a chamada de 7 argumentos ambigua — e e a que o n8n faz.

begin;

do $$
declare
  n integer;
begin
  select count(*) into n from public.mensagens_log where audio_segundos is not null;
  if n > 0 then
    raise exception
      'rollback 32 recusado: % linha(s) com audio_segundos. Exporte antes de perder o rateio de audio.', n
      using errcode = '55000';
  end if;
end $$;

drop function if exists public.api_n8n_registrar_mensagem(uuid, bigint, text, text, integer, integer, text, numeric);
drop function if exists public.api_n8n_registrar_mensagem(uuid, bigint, text, text, integer, integer, text);

create function public.api_n8n_registrar_mensagem(
  p_tenant_id uuid,
  p_conversation_id bigint,
  p_direcao text,
  p_conteudo text default null::text,
  p_tokens_entrada integer default null::integer,
  p_tokens_saida integer default null::integer,
  p_modelo text default null::text
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_id uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_direcao not in ('entrada', 'saida') then
    raise exception 'api_n8n: direcao invalida: %', p_direcao using errcode = '22023';
  end if;

  insert into public.mensagens_log
    (tenant_id, conversation_id, direcao, conteudo, tokens_entrada, tokens_saida, modelo)
  values
    (p_tenant_id, p_conversation_id, p_direcao, p_conteudo, p_tokens_entrada, p_tokens_saida, p_modelo)
  returning id into v_id;

  return v_id;
end;
$function$;

drop index if exists public.idx_mensagens_log_audio;
alter table public.mensagens_log drop column if exists audio_segundos;

commit;
