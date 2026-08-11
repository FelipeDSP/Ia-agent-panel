-- Rollback de 28_fechar_pedido_metadados_texto
--
-- Volta `api_n8n_fechar_pedido` a assinatura (uuid, bigint, jsonb) da migracao 26.
--
-- ATENCAO: isto REINTRODUZ o bug que a 28 consertou. Com a assinatura jsonb, o
-- sub-workflow `Tool - Fechar Pedido` volta a estourar `invalid input syntax for
-- type json` sempre que o modelo mandar metadados vazio — que e o caso comum,
-- porque o cliente raramente informa endereco ou retirada.
--
-- Se reverter, reverta TAMBEM a query do sub-workflow no n8n, que passou a
-- mandar `$3::text`. Deixar os dois fora de sincronia da erro de tipo na
-- primeira chamada.
--
-- Nao ha dado a preservar: `metadados` dos pedidos ja fechados fica como esta.

begin;

drop function if exists public.api_n8n_fechar_pedido(uuid, bigint, text);

create or replace function public.api_n8n_fechar_pedido(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_metadados       jsonb default '{}'::jsonb
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_pedido uuid;
  v_status text;
  v_itens  integer;
  v_numero integer;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  v_pedido := public.pedido_aberto_da_conversa(p_tenant_id, p_conversation_id);
  if v_pedido is null then
    return 'Nao ha pedido aberto nesta conversa para fechar.';
  end if;

  select p.status, p.numero into v_status, v_numero
  from public.pedidos p where p.id = v_pedido;

  if v_status <> 'rascunho' then
    return format('O pedido nº %s ja foi fechado. %s',
                  coalesce(v_numero::text, '?'), public.pedido_em_texto(v_pedido));
  end if;

  select count(*) into v_itens from public.pedido_itens i where i.pedido_id = v_pedido;
  if v_itens = 0 then
    return 'O pedido esta vazio — adicione itens antes de fechar.';
  end if;

  select coalesce(max(p.numero), 0) + 1 into v_numero
  from public.pedidos p where p.tenant_id = p_tenant_id;

  update public.pedidos p
  set status    = 'aguardando_pagamento',
      numero    = v_numero,
      metadados = p.metadados || coalesce(p_metadados, '{}'::jsonb)
  where p.id = v_pedido;

  return format(E'Pedido nº %s fechado.\n%s', v_numero, public.pedido_em_texto(v_pedido));
end;
$$;

revoke all on function public.api_n8n_fechar_pedido(uuid, bigint, jsonb) from public;
revoke all on function public.api_n8n_fechar_pedido(uuid, bigint, jsonb) from anon, authenticated;
grant execute on function public.api_n8n_fechar_pedido(uuid, bigint, jsonb) to n8n_agent;

commit;
