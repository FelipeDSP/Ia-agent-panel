-- Migracao 33 — api_n8n_pode_transcrever
--
-- Uma funcao, uma linha, quatro perguntas que o ramo de audio faz ANTES de
-- gastar: o tenant contratou? a conversa esta pausada? qual a credencial do
-- Chatwoot para baixar o anexo e responder? qual a config do modulo?
--
-- POR QUE JUNTAS. O no que ela substitui (`Credencial (midia)`) ja faz uma query
-- no caminho de TODA midia, inclusive da Acqua. Perguntar em quatro nos seria
-- quatro round-trips; perguntar em um mantem o caminho dela do mesmo tamanho de
-- hoje. Ela cai em `tool_ativa = false` e segue para o mesmo aviso de sempre.
--
-- POR QUE A PAUSA IMPORTA. Enquanto um humano atende, o cliente continua
-- mandando audio. Sem esta checagem cada um seria baixado e transcrito para ser
-- descartado logo depois, no `Nao Pausado?`. E o unico desperdicio real de
-- transcricao no desenho -- a mensagem que morre no `Ultima Mensagem?` NAO e
-- desperdicio, porque o texto dela ja esta no acumulador e vai ser respondido.
--
-- CONFIG POR TENANT vem de `tenant_tools.config`, o mesmo canal que o
-- `transferir_humano` ja usa. Evita coluna nova em `tenants` para cada texto.
--
-- ROLLBACK: 20260812183000_33_api_n8n_pode_transcrever_rollback.sql

begin;

create or replace function public.api_n8n_pode_transcrever(
  p_tenant_id uuid,
  p_conversation_id bigint
)
returns table(
  tool_ativa boolean,
  conversa_pausada boolean,
  chatwoot_url text,
  chatwoot_token text,
  limite_bytes integer,
  msg_audio_longo text,
  msg_audio_falhou text
)
language plpgsql
stable security definer
set search_path to 'public', 'extensions'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  return query
  select
    -- Mesma regra das outras duas portas: contratado E ativo. A migracao 30
    -- existiu porque `api_n8n_config_tool` discordava disso.
    coalesce(tt.ativo and tt.contratado, false),
    coalesce(cv.status, 'ativo') = 'pausado',
    t.chatwoot_url,
    c.chatwoot_token,
    -- ~270 KB ~= 3 min de nota de voz do WhatsApp (Opus ~1,5 KB/s). E PROXY, nao
    -- medida: a duracao exata so existe depois de transcrever. O par
    -- (file_size, duration) fica registrado em mensagens_log justamente para
    -- calibrar este numero com dado real em vez de aritmetica de bitrate.
    coalesce((tt.config ->> 'limite_bytes')::integer, 270000),
    coalesce(tt.config ->> 'msg_audio_longo',
             'Seu áudio é longo demais para eu ouvir. Pode resumir por escrito?'),
    coalesce(tt.config ->> 'msg_audio_falhou',
             'Não consegui entender seu áudio. Pode repetir ou escrever?')
  from public.tenants t
  left join public.tenant_credenciais c
         on c.tenant_id = t.id
  left join public.tenant_tools tt
         on tt.tenant_id = t.id and tt.tool_nome = 'transcricao_audio'
  left join public.conversas cv
         on cv.tenant_id = t.id and cv.conversation_id = p_conversation_id
  where t.id = p_tenant_id;
end;
$function$;

commit;
