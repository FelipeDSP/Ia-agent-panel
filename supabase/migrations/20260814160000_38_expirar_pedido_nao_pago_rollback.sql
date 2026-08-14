-- Rollback da migracao 38
--
-- Devolve `pedido_aberto_da_conversa` e `api_n8n_tem_pedido_pendente` a
-- `stable`, `adicionar_item` a versao sem aviso, e dropa as duas funcoes novas.
--
-- ORDEM: as duas funcoes novas caem POR ULTIMO. `pedido_aberto_da_conversa`
-- chama `expirar_pedidos_vencidos`; dropar a chamada antes de trocar quem chama
-- passaria verde (corpo plpgsql e texto opaco para o pg_depend) e estouraria na
-- primeira mensagem de um cliente.
--
-- `drop function` explicito antes de cada `create or replace`: a volatilidade
-- muda, e `create or replace` NAO troca volatilidade de funcao existente em
-- todas as versoes — dropar e o unico jeito de garantir que volta a `stable`.
--
-- O QUE VOLTA JUNTO: pedido nao pago volta a travar a conversa para sempre. O
-- cliente que recebeu link e nao pagou nao consegue fazer outro pedido, e a
-- unica saida e pedir cancelamento ao agente. Era o estado ate 14/08/2026.
--
-- NAO desfaz expiracoes ja feitas: pedido que virou `expirado` fica assim. E
-- correto — o prazo passou mesmo, e "desexpirar" reintroduziria a trava com um
-- pedido que o cliente ja foi avisado de que caiu.

begin;

drop function if exists public.api_n8n_adicionar_item(uuid, bigint, uuid, integer, text);

create or replace function public.api_n8n_adicionar_item(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_produto_id      uuid,
  p_quantidade      integer,
  p_observacao      text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_prod    record;
  v_pedido  uuid;
  v_status  text;
  v_qtd     integer := coalesce(p_quantidade, 1);
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if v_qtd < 1 then
    return 'Quantidade precisa ser pelo menos 1.';
  end if;
  if v_qtd > 999 then
    return 'Quantidade acima do limite por item (999). Confirme com o cliente.';
  end if;

  select p.id, p.nome, p.preco_centavos into v_prod
  from public.produtos p
  where p.id = p_produto_id
    and p.tenant_id = p_tenant_id
    and p.deletado_em is null
    and p.disponivel
    and (p.estoque is null or p.estoque > 0)
  limit 1;

  if not found then
    return 'Esse item nao esta disponivel no catalogo. Consulte os produtos e confirme com o cliente.';
  end if;

  v_pedido := public.pedido_aberto_da_conversa(p_tenant_id, p_conversation_id);

  if v_pedido is null then
    insert into public.pedidos (tenant_id, conversation_id, status)
    values (p_tenant_id, p_conversation_id, 'rascunho')
    on conflict do nothing
    returning id into v_pedido;

    if v_pedido is null then
      v_pedido := public.pedido_aberto_da_conversa(p_tenant_id, p_conversation_id);
    end if;
  end if;

  select p.status into v_status from public.pedidos p where p.id = v_pedido;

  if v_status <> 'rascunho' then
    return 'O pedido ja foi fechado e nao aceita alteracao. Para mudar, e preciso cancelar e refazer.';
  end if;

  insert into public.pedido_itens
    (tenant_id, pedido_id, produto_id, nome_snapshot, preco_unit_centavos, quantidade, observacao)
  values
    (p_tenant_id, v_pedido, v_prod.id, v_prod.nome, v_prod.preco_centavos, v_qtd, nullif(btrim(coalesce(p_observacao,'')), ''))
  on conflict (pedido_id, produto_id) do update
    set quantidade = public.pedido_itens.quantidade + excluded.quantidade,
        observacao = coalesce(excluded.observacao, public.pedido_itens.observacao);

  return public.pedido_em_texto(v_pedido);
end;
$$;

drop function if exists public.api_n8n_tem_pedido_pendente(uuid, bigint);

create or replace function public.api_n8n_tem_pedido_pendente(
  p_tenant_id       uuid,
  p_conversation_id bigint
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_pedido uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  v_pedido := public.pedido_aberto_da_conversa(p_tenant_id, p_conversation_id);
  if v_pedido is null then
    return false;
  end if;

  return exists (select 1 from public.pedido_itens i where i.pedido_id = v_pedido);
end;
$$;

drop function if exists public.pedido_aberto_da_conversa(uuid, bigint);

create or replace function public.pedido_aberto_da_conversa(
  p_tenant_id       uuid,
  p_conversation_id bigint
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.pedidos p
  where p.tenant_id = p_tenant_id
    and p.conversation_id = p_conversation_id
    and p.status in ('rascunho', 'aguardando_pagamento')
    and p.deletado_em is null
  limit 1;
$$;

drop function if exists public.expirar_pedidos_vencidos(uuid, bigint);
drop function if exists public.pedido_horas_para_expirar(uuid);

commit;
