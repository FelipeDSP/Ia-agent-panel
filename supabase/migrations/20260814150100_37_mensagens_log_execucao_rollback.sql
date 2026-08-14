-- Rollback da migracao 37
--
-- ORDEM IMPORTA, e a razao e a mesma que o CLAUDE.md registra sobre `drop
-- column`: corpo de funcao plpgsql e TEXTO OPACO para o `pg_depend`. Dropar a
-- coluna com a funcao de 9 argumentos viva passaria verde e a funcao so
-- estouraria na primeira mensagem de um cliente. Por isso:
--
--   1. dropa a funcao de 9;
--   2. recria a de 8 (o n8n volta a ter o que chamar);
--   3. so entao dropa indice e coluna.
--
-- ANTES DE RODAR: reverta o no `Registra Mensagem` no n8n para a query de 8
-- argumentos. Se o workflow ainda mandar 9, ele passa a receber 42883 (function
-- does not exist) a cada mensagem. O rollback do banco nao alcanca o n8n.
--
-- PERDA DE DADO: `execucao_id` das linhas gravadas depois da 37 se perde. E
-- metadado de auditoria, nao conteudo do cliente — nenhuma mensagem, token ou
-- conversa e afetada. O aviso abaixo diz quantas linhas perdem a marca, para a
-- decisao ser tomada com o numero na frente.

begin;

do $$
declare
  n integer;
begin
  select count(*) into n from public.mensagens_log where execucao_id is not null;
  if n > 0 then
    raise warning 'rollback 37: % linha(s) perdem o execucao_id (metadado de auditoria).', n;
  end if;
end $$;

drop function if exists public.api_n8n_registrar_mensagem(uuid, bigint, text, text, integer, integer, text, numeric, text);

create or replace function public.api_n8n_registrar_mensagem(
  p_tenant_id uuid,
  p_conversation_id bigint,
  p_direcao text,
  p_conteudo text default null::text,
  p_tokens_entrada integer default null::integer,
  p_tokens_saida integer default null::integer,
  p_modelo text default null::text,
  p_audio_segundos numeric default null::numeric
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
    (tenant_id, conversation_id, direcao, conteudo, tokens_entrada, tokens_saida, modelo, audio_segundos)
  values
    (p_tenant_id, p_conversation_id, p_direcao, p_conteudo, p_tokens_entrada, p_tokens_saida, p_modelo, p_audio_segundos)
  returning id into v_id;

  return v_id;
end;
$function$;

drop index if exists public.uq_mensagens_log_execucao;

alter table public.mensagens_log drop column if exists execucao_id;

commit;
