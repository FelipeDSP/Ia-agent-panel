CREATE OR REPLACE FUNCTION public.painel_marcar_pedido(p_pedido_id uuid, p_acao text)
 RETURNS TABLE(ok boolean, motivo text, status text, pago_em timestamp with time zone, retirado_em timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_p record;
begin
  if p_acao not in ('pago', 'retirado') then
    return query select false, 'acao_invalida', null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select p.* into v_p
  from public.pedidos p
  where p.id = p_pedido_id
    and p.deletado_em is null
    and (public.auth_is_super_admin() or p.tenant_id = public.auth_tenant_id())
  for update;

  if v_p.id is null then
    return query select false, 'nao_encontrado', null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if p_acao = 'pago' then
    if v_p.status <> 'aguardando_pagamento' then
      return query select false, 'nao_esta_aguardando', v_p.status, v_p.pago_em, v_p.retirado_em;
      return;
    end if;
    update public.pedidos p
       set status      = 'pago',
           pago_em     = now(),
           -- quem paga na retirada esta retirando: os dois de uma vez
           retirado_em = case when coalesce(p.pagamento_modo, 'link') = 'na_retirada'
                              then now() else p.retirado_em end,
           atualizado_em = now()
     where p.id = v_p.id;
    -- cobrancas abertas deste pedido deixam de ser "a encerrar": o dono
    -- recebeu no balcao, o cliente nao pode ouvir que o link expirou
    update public.pedido_cobrancas c
       set encerrada_em = now(),
           encerramento_detalhe = 'pago no painel (69)'
     where c.pedido_id = v_p.id
       and c.tenant_id = v_p.tenant_id
       and c.pago_em is null and c.falhou_em is null and c.encerrada_em is null;
  else
    if v_p.status <> 'pago' then
      return query select false, 'nao_esta_pago', v_p.status, v_p.pago_em, v_p.retirado_em;
      return;
    end if;
    if v_p.retirado_em is not null then
      return query select false, 'ja_retirado', v_p.status, v_p.pago_em, v_p.retirado_em;
      return;
    end if;
    update public.pedidos p
       set retirado_em = now(), atualizado_em = now()
     where p.id = v_p.id;
  end if;

  return query
    select true, p_acao, p.status, p.pago_em, p.retirado_em
      from public.pedidos p where p.id = v_p.id;
end;
$function$
