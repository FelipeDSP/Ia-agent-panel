-- Migracao 37 — `execucao_id` em mensagens_log: um turno cobra uma vez
--
-- O ACHADO (auditoria de confiabilidade, item I1): `api_n8n_registrar_mensagem`
-- faz INSERT puro, sem chave. Um retry duplica a linha e conta o token 2x no
-- billing, que deriva de `mensagens_log`.
--
-- POR QUE NAO E O ID DA MENSAGEM DO CHATWOOT, que era a sugestao da auditoria.
-- Duas razoes independentes, as duas medidas contra producao em 14/08:
--
--   1. A LINHA DE `entrada` NAO E UMA MENSAGEM. O debounce colapsa N mensagens
--      numa linha so: o `conteudo` real e `{oi,"tudo bem?"}` — a lista do Redis
--      serializada. Nao existe um `body.id` que a identifique. O id da mensagem
--      que DISPAROU a execucao seria chave sobre a coisa errada: se o cliente
--      manda 3 mensagens, 3 execucoes acumulam e so a ultima registra.
--
--   2. A LINHA DE `saida` TEM id do Chatwoot, e ele nao deduplica. O
--      `Registra Mensagem` roda depois do `Envia Mensagem Chatwoot`, entao a
--      resposta com o id esta disponivel — mas se o fluxo re-executa, ele ENVIA
--      UMA MENSAGEM NOVA e recebe um id NOVO. A chave nao colidiria, e o cliente
--      recebeu duas respostas de qualquer jeito.
--
-- POR QUE NAO HASH DE CONTEUDO. Os dados refutam: `"vocês entregam?"` aparece
-- legitimamente duas vezes com 18 minutos de intervalo, e
-- `"Olá! Como posso ajudar você hoje?"` em dias diferentes. Chave por conteudo
-- engoliria repeticao legitima — sub-cobranca silenciosa, pior que a
-- super-cobranca que ela evitaria.
--
-- A CHAVE E A EXECUCAO, porque a unidade de cobranca e o TURNO, nao a mensagem.
-- Uma execucao que passa pelo `Volta a Um Item` (maxItems: 1) = uma chamada a
-- OpenAI = uma cobranca = exatamente um par de linhas. `$execution.id` e
-- identificador do proprio n8n, nao inventado aqui.
--
-- CONFIRMADO EM EXECUCAO REAL (14/08, execucao 3966582): `$execution.id`
-- resolve para a string "3966582", bate com o ID# da lista de execucoes, e
-- resolve tambem DENTRO de expressao de array — que e a forma do
-- `queryReplacement` do no Postgres. Detalhe que so a execucao mostra: no editor
-- a expressao NAO resolve, exibe `[filled at execution time]`. Conferir pelo
-- preview teria dado falso negativo.
--
-- ================= O QUE ESTA CHAVE NAO COBRE =================
--
-- WEBHOOK REENTREGUE PELO CHATWOOT gera execucao NOVA, id NOVO, e a chave NAO
-- colide: o billing dobra. Esta escrito aqui de proposito, porque daqui a seis
-- meses alguem le "chave de idempotencia" e assume que cobre retry em geral.
--
-- Cobre: retry de NO (`retryOnFail`), "retry from here" na UI sobre uma execucao
-- que falhou depois do envio, e resume do `Wait Debounce` — todos mantem o mesmo
-- `$execution.id`. Sao os casos INVISIVEIS: dobram o billing sem dobrar nada que
-- alguem veja.
--
-- Nao cobre: reentrega de webhook. Esse caso manda DUAS RESPOSTAS ao cliente,
-- entao nao e silencioso, e nao e problema que chave de log resolva — o conserto
-- dele seria dedupe na entrada do webhook, que e outra fatia.
--
-- ==============================================================
--
-- BACKFILL: nenhum. As 70 linhas existentes ficam com `execucao_id` nulo e o
-- indice unico e PARCIAL (`where execucao_id is not null`), entao so restringe
-- linha que carrega a chave. Nao invento id para o passado.
--
-- COMPATIBILIDADE: `p_execucao_id` tem DEFAULT null. Uma chamada de 8 argumentos
-- (o n8n antes do ajuste do no) continua funcionando e se comporta exatamente
-- como hoje — sem chave, sem conflito possivel, insert direto. Isso torna a
-- ordem migracao-antes-do-n8n segura.
--
-- SOBRE A ASSINATURA. Hoje sao 8 parametros (a 32 acrescentou `audio_segundos`;
-- a auditoria fala em 7 porque e de 04/08, anterior a ela). O nono tem DEFAULT,
-- entao `create or replace` deixaria as DUAS vivas e a chamada de 8 argumentos —
-- que e a que o n8n faz hoje — ficaria AMBIGUA (42725). Por isso o `drop
-- function` explicito da assinatura de 8 vem antes. Terceira vez que a armadilha
-- aparece (28, 32, esta); virou linha no CLAUDE.md e checagem em
-- `npm run teste:assinaturas`.
--
-- ROLLBACK: 20260814150100_37_mensagens_log_execucao_rollback.sql

begin;

alter table public.mensagens_log
  add column if not exists execucao_id text;

comment on column public.mensagens_log.execucao_id is
  'Id da execucao do n8n que produziu esta linha. Chave de idempotencia do '
  'billing: um turno (uma chamada a OpenAI) cobra uma vez. NULL nas linhas '
  'anteriores a migracao 37 e em qualquer escrita que nao venha do n8n.';

-- PARCIAL de proposito: so restringe linha que tem a chave. `tenant_id` vem
-- primeiro pela regra de indice composto do projeto — e alem da unicidade o
-- indice serve "linhas do tenant X desta execucao".
create unique index if not exists uq_mensagens_log_execucao
  on public.mensagens_log (tenant_id, execucao_id, direcao)
  where execucao_id is not null;

comment on index public.uq_mensagens_log_execucao is
  'Um turno grava no maximo uma entrada e uma saida. Nao cobre webhook '
  'reentregue (execucao nova, id novo) — ver comentario da migracao 37.';

-- `drop` da assinatura de 8 + `create or replace` da de 9. O drop desfaz a
-- ambiguidade; o `or replace` mantem a migracao reexecutavel, sem o que o teste
-- que aplica em transacao abortada para de rodar depois dela entrar em producao.
drop function if exists public.api_n8n_registrar_mensagem(uuid, bigint, text, text, integer, integer, text, numeric);

create or replace function public.api_n8n_registrar_mensagem(
  p_tenant_id uuid,
  p_conversation_id bigint,
  p_direcao text,
  p_conteudo text default null::text,
  p_tokens_entrada integer default null::integer,
  p_tokens_saida integer default null::integer,
  p_modelo text default null::text,
  p_audio_segundos numeric default null::numeric,
  p_execucao_id text default null::text
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

  -- O `where` do ON CONFLICT tem de repetir o predicado do indice parcial para
  -- o Postgres inferir qual indice usar. Com `p_execucao_id` nulo a linha nem
  -- entra no indice, entao nao ha conflito possivel e o insert e o de sempre —
  -- e por isso que a chamada antiga de 8 argumentos segue se comportando como
  -- antes.
  insert into public.mensagens_log
    (tenant_id, conversation_id, direcao, conteudo, tokens_entrada, tokens_saida, modelo, audio_segundos, execucao_id)
  values
    (p_tenant_id, p_conversation_id, p_direcao, p_conteudo, p_tokens_entrada, p_tokens_saida, p_modelo, p_audio_segundos, p_execucao_id)
  on conflict (tenant_id, execucao_id, direcao) where execucao_id is not null
    do nothing
  returning id into v_id;

  -- DO NOTHING nao devolve linha no conflito, e `returning` deixa v_id nulo. Sem
  -- este bloco o no do n8n receberia null e leria como falha. Devolver o id que
  -- JA existe e o que faz a funcao ser idempotente de verdade: mesma chamada,
  -- mesma resposta.
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
