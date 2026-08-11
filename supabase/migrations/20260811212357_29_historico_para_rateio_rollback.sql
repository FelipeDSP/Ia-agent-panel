-- Rollback de 29_historico_para_rateio
--
-- Volta `api_n8n_conversa_sync` ao corpo de producao anterior, com duas colunas.
--
-- ORDEM: reverta ANTES o no `Sync Conversa` no n8n, que passou a fazer
-- `SELECT status, pausado_em, historico_chars`. Com a funcao de duas colunas e a
-- query pedindo tres, o no falha com 42703 na primeira mensagem — e este e o
-- caminho de TODA conversa, de TODO cliente. Reverter na ordem errada derruba o
-- agente inteiro, nao so o rateio.
--
-- O `Estima Tokens` nao precisa ser revertido junto: ele le
-- `historico_chars ?? 0`, entao a ausencia da coluna so o faz voltar a
-- subestimar — que era o comportamento anterior.
--
-- O corpo abaixo e byte a byte o que estava em producao antes da 29, tirado de
-- pg_get_functiondef.

begin;

drop function if exists public.api_n8n_conversa_sync(uuid, bigint, text, text);

create or replace function public.api_n8n_conversa_sync(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_contact_name    text default null::text,
  p_phone           text default null::text
)
returns table (
  status     text,
  pausado_em timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_conversation_id is null then
    raise exception 'api_n8n: p_conversation_id e obrigatorio' using errcode = '22023';
  end if;

  return query
  insert into public.conversas as c (tenant_id, conversation_id, contact_name, phone)
  values (p_tenant_id, p_conversation_id, p_contact_name, p_phone)
  on conflict (tenant_id, conversation_id) do update
    set contact_name  = coalesce(excluded.contact_name, c.contact_name),
        phone         = coalesce(excluded.phone, c.phone),
        atualizado_em = now()
  returning c.status, c.pausado_em;
end;
$function$;

revoke all on function public.api_n8n_conversa_sync(uuid, bigint, text, text) from public;
revoke all on function public.api_n8n_conversa_sync(uuid, bigint, text, text) from anon, authenticated;
grant execute on function public.api_n8n_conversa_sync(uuid, bigint, text, text) to n8n_agent;

commit;
