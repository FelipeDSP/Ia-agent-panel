-- Rollback da migracao 47 — retomada da pausa
--
-- O QUE SE PERDE. `motivo_pausa` e `pausa_expira_minutos` sao dropadas: quem
-- pausou cada conversa e a janela de cada tenant deixam de existir. E o que
-- rollback significa aqui — as colunas nao existiam antes. `status` e
-- `pausado_em` NAO sao tocados, entao as conversas continuam pausadas
-- exatamente como estavam, e voltam a nao ter retomada nenhuma a nao ser o
-- toggle. Que era o problema.
--
-- SE VOCE RODAR ISTO DEPOIS DA 48, RODE A 48 PRIMEIRO. A view
-- `conversas_painel` depende de `pausa_vigente`, `conversa_status_efetivo` e
-- `motivo_pausa`; com ela viva, os `drop` da secao 3 falham em cascata (ou,
-- pior, alguem acrescenta um `cascade` e leva a view junto sem perceber).
--
-- ORDEM INVERSA DA MIGRACAO, e ela e obrigatoria: as tres `api_n8n_*` voltam ao
-- corpo antigo ANTES de as colunas e os predicados caírem. Na ordem contraria,
-- `api_n8n_conversa_sync` ficaria por alguns comandos referenciando
-- `conversa_status_efetivo` inexistente, e a proxima mensagem de qualquer
-- cliente estouraria no caminho quente. E a mesma nota do rollback da 46.
--
-- COMO NA 46 E NA 47, NAO HA `drop function` das `api_n8n_*`: a assinatura nunca
-- mudou, entao o ACL (postgres, service_role, n8n_agent) atravessa este rollback
-- intacto. Se voce acrescentar um `drop` aqui, acrescente tambem os dois
-- `grant` — e nao confira o resultado contra a lista que voce escreveu, que foi
-- como a 41 passou: compare o ACL de antes com o de depois, ou rode
-- `npm run teste:grants-n8n`.

begin;

-- ---------------------------------------------------------------------------
-- 1. As tres `api_n8n_*` voltam ao corpo de antes da 47.
-- ---------------------------------------------------------------------------
create or replace function public.api_n8n_definir_status_conversa(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_status          text
) returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_status text;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_status not in ('ativo', 'pausado', 'resolvido') then
    raise exception 'api_n8n: status invalido: %', p_status using errcode = '22023';
  end if;

  update public.conversas
     set status = p_status,
         pausado_em = case when p_status = 'pausado' then now() else null end,
         atualizado_em = now()
   where tenant_id = p_tenant_id and conversation_id = p_conversation_id
  returning status into v_status;

  if v_status is null then
    raise exception 'api_n8n: conversa % nao encontrada no tenant', p_conversation_id
      using errcode = '02000';
  end if;

  return v_status;
end;
$function$;

create or replace function public.api_n8n_conversa_sync(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_contact_name    text default null,
  p_phone           text default null
) returns table(status text, pausado_em timestamptz, historico_chars integer)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_historico integer;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_conversation_id is null then
    raise exception 'api_n8n: p_conversation_id e obrigatorio' using errcode = '22023';
  end if;

  -- Calculado ANTES do insert: o registro da mensagem atual so acontece depois
  -- da resposta, entao aqui o historico e exatamente o dos turnos anteriores.
  select coalesce(sum(length(m.conteudo)), 0)::integer
    into v_historico
  from (
    select l.conteudo
    from public.mensagens_log l
    where l.tenant_id = p_tenant_id
      and l.conversation_id = p_conversation_id
    order by l.criado_em desc
    limit 20
  ) m;

  return query
  insert into public.conversas as c (tenant_id, conversation_id, contact_name, phone)
  values (p_tenant_id, p_conversation_id, p_contact_name, p_phone)
  on conflict (tenant_id, conversation_id) do update
    set contact_name  = coalesce(excluded.contact_name, c.contact_name),
        phone         = coalesce(excluded.phone, c.phone),
        atualizado_em = now()
  returning c.status, c.pausado_em, v_historico;
end;
$function$;

create or replace function public.api_n8n_pode_transcrever(
  p_tenant_id       uuid,
  p_conversation_id bigint
) returns table(
  tool_ativa       boolean,
  conversa_pausada boolean,
  chatwoot_url     text,
  chatwoot_token   text,
  limite_bytes     integer,
  msg_audio_longo  text,
  msg_audio_falhou text
)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  return query
  select
    -- Mesma regra das outras portas: contratado E ativo. A migracao 30 existiu
    -- porque `api_n8n_config_tool` discordava disso.
    coalesce(tt.ativo and tt.contratado, false),
    coalesce(cv.status, 'ativo') = 'pausado',
    t.chatwoot_url,
    c.chatwoot_token,
    -- ~270 KB ~= 3 min de nota de voz do WhatsApp (Opus ~1,5 KB/s). E PROXY, nao
    -- medida: a duracao exata so existe depois de transcrever.
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

grant execute on function public.api_n8n_definir_status_conversa(uuid, bigint, text) to service_role;
grant execute on function public.api_n8n_definir_status_conversa(uuid, bigint, text) to n8n_agent;
grant execute on function public.api_n8n_conversa_sync(uuid, bigint, text, text) to service_role;
grant execute on function public.api_n8n_conversa_sync(uuid, bigint, text, text) to n8n_agent;
grant execute on function public.api_n8n_pode_transcrever(uuid, bigint) to service_role;
grant execute on function public.api_n8n_pode_transcrever(uuid, bigint) to n8n_agent;

-- ---------------------------------------------------------------------------
-- 2. Os comentarios de coluna voltam a nao existir (era o estado antes da 47:
--    `col_description` era NULL nas nove colunas de `conversas`, verificado).
-- ---------------------------------------------------------------------------
comment on column public.conversas.status is null;

-- ---------------------------------------------------------------------------
-- 3. Constraints, predicados e colunas — nesta ordem.
--
--    As constraints saem antes das colunas porque `drop column` levaria a
--    constraint junto em silencio; explicito e melhor de ler no diff.
-- ---------------------------------------------------------------------------
alter table public.conversas
  drop constraint if exists conversas_pausa_tem_motivo;
alter table public.conversas
  drop constraint if exists conversas_motivo_pausa_check;

drop function if exists public.conversa_status_efetivo(text, timestamptz, text, integer);
drop function if exists public.pausa_vigente(text, timestamptz, text, integer);

alter table public.conversas
  drop column if exists motivo_pausa;

alter table public.tenants
  drop constraint if exists tenants_pausa_expira_positiva;
alter table public.tenants
  drop column if exists pausa_expira_minutos;

commit;
