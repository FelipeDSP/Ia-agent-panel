-- Rollback da migracao 46 — `saida_cortes` em `mensagens_log`
--
-- PERDA DE DADO: o `drop column` apaga os cortes ja gravados. E o que rollback
-- significa aqui — a coluna nao existia antes. Nada de billing e tocado: os
-- totais e os componentes de token ficam onde estao.
--
-- ORDEM INVERSA da migracao: funcao primeiro, depois indice, depois coluna. Se
-- a coluna caisse antes, a funcao ficaria referenciando coluna inexistente e a
-- proxima mensagem de qualquer cliente estouraria — no caminho quente, entre um
-- comando e o outro.
--
-- COMO NA 46, NAO HA `drop function`: a assinatura nunca mudou, entao o ACL
-- (postgres, service_role, n8n_agent) atravessa este rollback intacto. Se voce
-- acrescentar um `drop` aqui, acrescente tambem os dois `grant` — e nao confira
-- o resultado contra a lista que voce escreveu, que foi como a 41 passou:
-- compare o ACL de antes com o de depois, ou rode `npm run teste:grants-n8n`.

begin;

-- ---------------------------------------------------------------------------
-- 1. A funcao volta ao corpo de antes: mesmo insert, sem `saida_cortes`.
-- ---------------------------------------------------------------------------
create or replace function public.api_n8n_registrar_mensagem(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_direcao         text,
  p_conteudo        text    default null,
  p_tokens_entrada  integer default null,
  p_tokens_saida    integer default null,
  p_modelo          text    default null,
  p_audio_segundos  numeric default null,
  p_execucao_id     text    default null,
  p_componentes     jsonb   default null
) returns uuid
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

  if p_audio_segundos is not null and p_audio_segundos < 0 then
    raise exception 'api_n8n: audio_segundos negativo: %', p_audio_segundos using errcode = '22023';
  end if;

  insert into public.mensagens_log
    (tenant_id, conversation_id, direcao, conteudo, tokens_entrada, tokens_saida,
     modelo, audio_segundos, execucao_id,
     tokens_wrapper, tokens_system_prompt, tokens_schema_tools,
     tokens_mensagens, tokens_memoria, tokens_round_trip, chamadas, fonte_tokens)
  values
    (p_tenant_id, p_conversation_id, p_direcao, p_conteudo, p_tokens_entrada, p_tokens_saida,
     p_modelo, p_audio_segundos, p_execucao_id,
     public.n8n_json_int(p_componentes, 'wrapper'),
     public.n8n_json_int(p_componentes, 'system_prompt'),
     public.n8n_json_int(p_componentes, 'schema_tools'),
     public.n8n_json_int(p_componentes, 'mensagens'),
     public.n8n_json_int(p_componentes, 'memoria'),
     public.n8n_json_int(p_componentes, 'round_trip'),
     public.n8n_json_int(p_componentes, 'chamadas'),
     nullif(p_componentes ->> 'fonte', ''))
  on conflict (tenant_id, execucao_id, direcao) where execucao_id is not null
    do nothing
  returning id into v_id;

  if v_id is null and p_execucao_id is not null then
    select m.id into v_id
      from public.mensagens_log m
     where m.tenant_id = p_tenant_id
       and m.execucao_id = p_execucao_id
       and m.direcao = p_direcao;
  end if;

  return v_id;
end;
$function$;

grant execute on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb
) to service_role;
grant execute on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb
) to n8n_agent;

-- ---------------------------------------------------------------------------
-- 2. Indice e coluna, nesta ordem.
-- ---------------------------------------------------------------------------
drop index if exists public.idx_mensagens_log_saida_cortes;

alter table public.mensagens_log
  drop column if exists saida_cortes;

commit;
