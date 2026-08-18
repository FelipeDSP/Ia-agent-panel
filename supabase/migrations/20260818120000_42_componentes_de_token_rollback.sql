-- Rollback da migracao 42 — decomposicao dos tokens em `mensagens_log`
--
-- Volta ao estado EXATO de antes, e isso inclui o ACL. Ver o aviso no fim: o
-- rollback REABRE `anon` de proposito, porque rollback que muda semantica junto
-- nao e rollback.
--
-- PERDA DE DADO: os `drop column` apagam a decomposicao ja gravada. Isso e o que
-- rollback significa aqui — as colunas nao existiam antes. Os totais
-- (`tokens_entrada`, `tokens_saida`) NAO sao tocados, entao billing continua
-- funcionando como antes da 42.

begin;

-- ---------------------------------------------------------------------------
-- 1. A funcao volta para 10 -> 9 argumentos. Drop pela lista COMPLETA de tipos,
--    incluindo o jsonb: dropar pelo nome com duas assinaturas vivas erra ou
--    derruba a errada.
-- ---------------------------------------------------------------------------
drop function if exists public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb
);

create or replace function public.api_n8n_registrar_mensagem(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_direcao         text,
  p_conteudo        text    default null,
  p_tokens_entrada  integer default null,
  p_tokens_saida    integer default null,
  p_modelo          text    default null,
  p_audio_segundos  numeric default null,
  p_execucao_id     text    default null
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

  if p_audio_segundos is not null and p_audio_segundos < 0 then
    raise exception 'api_n8n: audio_segundos negativo: %', p_audio_segundos using errcode = '22023';
  end if;

  insert into public.mensagens_log
    (tenant_id, conversation_id, direcao, conteudo, tokens_entrada, tokens_saida, modelo, audio_segundos, execucao_id)
  values
    (p_tenant_id, p_conversation_id, p_direcao, p_conteudo, p_tokens_entrada, p_tokens_saida, p_modelo, p_audio_segundos, p_execucao_id)
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

-- ---------------------------------------------------------------------------
-- 2. ACL restaurado COMO ESTAVA — inclusive o que a 42 fechou.
--
--    AVISO: as tres linhas de `grant ... to public/anon/authenticated` abaixo
--    reabrem uma funcao SECURITY DEFINER que ESCREVE em `mensagens_log` para a
--    chave anonima que vai no navegador. Elas estao aqui porque um rollback tem
--    de devolver o estado anterior, e nao um estado novo que ninguem reviu.
--
--    SE VOCE ESTA ROLANDO PARA TRAS POR OUTRO MOTIVO e quer MANTER o
--    fechamento, comente as tres linhas marcadas. O agente continua funcionando
--    pelo grant a n8n_agent, que fica de qualquer jeito.
-- ---------------------------------------------------------------------------
grant execute on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text
) to public;        -- <-- comente para manter o fechamento da 42
grant execute on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text
) to anon;          -- <-- comente para manter o fechamento da 42
grant execute on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text
) to authenticated; -- <-- comente para manter o fechamento da 42

grant execute on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text
) to service_role;

-- Nao existia antes da 42 (o agente herdava de PUBLIC), mas fica: e inofensivo,
-- e sem ele o rollback dependeria do grant a PUBLIC acima para o agente rodar —
-- o que faria comentar aquelas linhas derrubar producao em silencio.
grant execute on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text
) to n8n_agent;

-- ---------------------------------------------------------------------------
-- 3. Colunas e helper.
-- ---------------------------------------------------------------------------
alter table public.mensagens_log
  drop column if exists tokens_wrapper,
  drop column if exists tokens_system_prompt,
  drop column if exists tokens_schema_tools,
  drop column if exists tokens_mensagens,
  drop column if exists tokens_memoria,
  drop column if exists tokens_round_trip,
  drop column if exists chamadas,
  drop column if exists fonte_tokens;

drop function if exists public.n8n_json_int(jsonb, text);

commit;
