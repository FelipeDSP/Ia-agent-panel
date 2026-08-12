-- Migracao 32 — `audio_segundos` em mensagens_log
--
-- POR QUE COLUNA E NAO TABELA. Um audio gera exatamente UMA linha de entrada em
-- `mensagens_log`. Tabela separada obrigaria join em todo relatorio de custo e
-- criaria duas verdades sobre a mesma mensagem — qual delas conta, a linha da
-- mensagem ou a linha do audio?
--
-- POR QUE FORA DO `tokens_entrada`. Whisper cobra por MINUTO de audio, nao por
-- token. O `Estima Tokens` esta calibrado a +-1,4% para uma unidade; somar outra
-- dentro do mesmo numero destruiria o significado dele e a calibracao junto.
-- Ficam lado a lado, cada um na sua unidade:
--
--   tokens_entrada | tokens_saida | audio_segundos
--
-- A DURACAO E EXATA, nao estimada. Vem do proprio retorno da transcricao
-- (`response_format=verbose_json` devolve `duration`), entao o rateio de audio
-- nao herda a incerteza que o rateio de token tem.
--
-- SOBRE A ASSINATURA. `api_n8n_registrar_mensagem` ganha um parametro. Como o
-- novo tem DEFAULT, um `CREATE OR REPLACE` deixaria as DUAS assinaturas vivas e
-- a chamada de 7 argumentos ficaria AMBIGUA — e a chamada de 7 argumentos e
-- exatamente a que o n8n faz hoje. Por isso a antiga e dropada explicitamente
-- antes. E a mesma armadilha que a migracao 28 criou com `fechar_pedido` e que
-- o rollback da 26 teve de consertar depois.
--
-- ROLLBACK: 20260812180100_32_mensagens_log_audio_segundos_rollback.sql

begin;

alter table public.mensagens_log
  add column if not exists audio_segundos numeric(8,2);

comment on column public.mensagens_log.audio_segundos is
  'Duracao do audio transcrito, em segundos, do retorno da API de transcricao. NULL em mensagem de texto. Unidade de cobranca propria — nao somar com tokens.';

-- Relatorio de custo de audio e sempre "deste tenant, neste periodo". O
-- tenant_id vem primeiro, como toda regra de indice composto do projeto.
create index if not exists idx_mensagens_log_audio
  on public.mensagens_log (tenant_id, criado_em)
  where audio_segundos is not null;

drop function if exists public.api_n8n_registrar_mensagem(uuid, bigint, text, text, integer, integer, text);

create function public.api_n8n_registrar_mensagem(
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

  -- Duracao negativa so pode vir de erro de leitura do retorno da transcricao.
  -- Barrar aqui evita rateio negativo, que ninguem olharia duas vezes.
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

commit;
