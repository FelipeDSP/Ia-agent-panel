-- =====================================================================
-- ROLLBACK da 56 — portao de venda afirmada
-- =====================================================================
--
-- ORDEM DE OPERACAO, E ELA IMPORTA: reverta o WORKFLOW no n8n ANTES de rodar
-- isto. O no `Estado do Pedido` chama `api_n8n_estado_pedido`; sem a funcao ele
-- estoura `42883` a cada mensagem, e o cliente para de receber resposta. O
-- caminho de saida inteiro passa por ali.
--
-- ---------------------------------------------------------------------
-- O QUE ESTE ROLLBACK DESFAZ
--
--   1. dropa `api_n8n_estado_pedido` PELA LISTA COMPLETA DE TIPOS. Nunca pelo
--      nome: com varias assinaturas vivas, dropar pelo nome erra ou derruba a
--      errada — a licao da familia 28/32/37/40/41;
--   2. devolve `api_n8n_registrar_mensagem` ao corpo anterior, SEM a extracao da
--      chave `portao`. Mesma assinatura, `create or replace`, entao os grants
--      dela continuam intactos e nao ha nada para reconceder;
--   3. dropa o indice parcial.
--
-- ---------------------------------------------------------------------
-- O QUE ELE NAO DESFAZ, DE PROPOSITO: A COLUNA `portao`
--
-- A coluna FICA. Tres razoes, na ordem em que pesam:
--
--   a) **e dado de fato acontecido.** Cada linha preenchida registra que uma
--      mensagem foi barrada ou passou, e com que estado de banco. Dropar a
--      coluna troca "rollback" por "perda de historico" — exatamente o que o
--      rollback da 52 recusou fazer com `metadados.notificacao`;
--   b) **e a unica evidencia de que o portao existiu.** Se ele for revertido
--      porque barrou demais, os vereditos sao o material para dimensionar o
--      excesso. Apaga-los e apagar a medicao junto com a coisa medida;
--   c) **coluna nullable sem uso nao custa nada.** `null` continua significando
--      "o portao nao rodou nesta linha", que passa a ser verdade para todas as
--      linhas novas.
--
-- Se um dia a remocao for mesmo necessaria, e passo MANUAL e separado:
--
--   alter table public.mensagens_log drop column portao;
--
-- rodado depois de conferir que ninguem le a coluna — o painel nao le hoje.
--
-- ---------------------------------------------------------------------
-- REEXECUTAVEL: `drop ... if exists` e `create or replace`. Rodar duas vezes da
-- o mesmo resultado, que e o que permite o teste replayar isto em transacao
-- abortada mesmo com a migracao ja em producao.
-- =====================================================================

begin;

drop function if exists public.api_n8n_estado_pedido(uuid, bigint, text);

drop index if exists public.idx_mensagens_log_portao;

-- Corpo anterior a 56, restaurado inteiro. A unica diferenca em relacao ao
-- arquivo da 56 e a ausencia de `v_portao` e da coluna `portao` no insert.
create or replace function public.api_n8n_registrar_mensagem(
  p_tenant_id uuid,
  p_conversation_id bigint,
  p_direcao text,
  p_conteudo text default null::text,
  p_tokens_entrada integer default null::integer,
  p_tokens_saida integer default null::integer,
  p_modelo text default null::text,
  p_audio_segundos numeric default null::numeric,
  p_execucao_id text default null::text,
  p_componentes jsonb default null::jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_id uuid;
  v_cortes jsonb;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_direcao not in ('entrada', 'saida') then
    raise exception 'api_n8n: direcao invalida: %', p_direcao using errcode = '22023';
  end if;

  if p_audio_segundos is not null and p_audio_segundos < 0 then
    raise exception 'api_n8n: audio_segundos negativo: %', p_audio_segundos using errcode = '22023';
  end if;

  v_cortes := case
    when jsonb_typeof(p_componentes -> 'saida_cortes') = 'array'
     and jsonb_array_length(p_componentes -> 'saida_cortes') > 0
    then p_componentes -> 'saida_cortes'
    else null
  end;

  insert into public.mensagens_log
    (tenant_id, conversation_id, direcao, conteudo, tokens_entrada, tokens_saida,
     modelo, audio_segundos, execucao_id,
     tokens_wrapper, tokens_system_prompt, tokens_schema_tools,
     tokens_mensagens, tokens_memoria, tokens_round_trip, chamadas, fonte_tokens,
     saida_cortes)
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
     nullif(p_componentes ->> 'fonte', ''),
     v_cortes)
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

commit;
