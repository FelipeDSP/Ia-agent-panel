-- Rollback da migracao 49 — devolve a SOMA ao `api_n8n_adicionar_item`
--
-- LEIA ANTES DE RODAR. Isto nao e neutro: devolver a soma devolve o defeito que
-- a 49 fechou. Com `quantidade = quantidade + excluded.quantidade`, um re-envio
-- do modelo DOBRA a linha — foi o que aconteceu em 20/08 no `emporio`, onde o
-- cliente pediu R$ 45,00 e o pedido fechou em R$ 75,00, em
-- `aguardando_pagamento`, sem que o texto que ele leu permitisse notar. O dado
-- foi corrigido a mao em 21/08 (ver `pedidos.metadados -> 'correcao_manual'`).
--
-- Se voce esta rodando isto porque `definir` causou um problema, o problema
-- esperado e o OPOSTO e e barulhento: o carrinho CAI (modelo manda 1, ou omite
-- a quantidade e o no manda 1 por default). Antes de voltar a soma, confirme que
-- e isso — trocar uma falha visivel por uma invisivel e o pior dos dois mundos,
-- e foi exatamente o estado anterior.
--
-- SEM PERDA DE DADO. So o corpo da funcao volta; nenhuma linha de `pedidos` ou
-- `pedido_itens` e tocada. Os pedidos que existirem seguem como estao.
--
-- SEM `drop function`: a assinatura nunca mudou, entao o ACL (postgres,
-- service_role, n8n_agent) atravessa este rollback intacto. Se acrescentar um
-- `drop` aqui, acrescente os dois `grant` — e confira por diff de ACL, nao
-- contra a lista que voce escreveu.

begin;

create or replace function public.api_n8n_adicionar_item(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_produto_id      uuid,
  p_quantidade      integer,
  p_observacao      text default null
) returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_prod    record;
  v_pedido  uuid;
  v_status  text;
  v_qtd     integer := coalesce(p_quantidade, 1);
  v_aviso   text;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if v_qtd < 1 then
    return 'Quantidade precisa ser pelo menos 1.';
  end if;
  if v_qtd > 999 then
    return 'Quantidade acima do limite por item (999). Confirme com o cliente.';
  end if;

  -- ANTES de qualquer coisa que dependa da vaga da conversa. O cliente que
  -- volta depois do prazo abre pedido novo NA MESMA MENSAGEM: o indice unico
  -- libera no mesmo comando, sem espera nenhuma para ele.
  v_aviso := public.expirar_pedidos_vencidos(p_tenant_id, p_conversation_id);

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

  return coalesce(v_aviso || E'\n\n', '') || public.pedido_em_texto(v_pedido);
end;
$function$;

comment on function public.api_n8n_adicionar_item(uuid, bigint, uuid, integer, text) is
  'Poe um item no carrinho. A quantidade e SOMADA a que ja existe na linha. '
  'ATENCAO: e a forma anterior a migracao 49, e um re-envio do modelo dobra o item. '
  'Ver docs/PENDENCIA-CARRINHO-MULTI-ITEM.md.';

grant execute on function public.api_n8n_adicionar_item(uuid, bigint, uuid, integer, text) to service_role;
grant execute on function public.api_n8n_adicionar_item(uuid, bigint, uuid, integer, text) to n8n_agent;

commit;
