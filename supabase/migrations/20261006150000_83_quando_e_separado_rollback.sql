-- =====================================================================
-- Rollback da migração 83 — hora e separação do pedido
-- =====================================================================
-- Sempre replayável: a 83 ACRESCENTA colunas e uma ação; nada do que ela
-- permite impede o rollback de rodar (ao contrário da 80, cujo estado novo é
-- gente).
--
-- PERDE DADO, e é bom dizer qual: `quando_em` e `separado_em` dos pedidos
-- somem. `quando_em` se reconstrói — a origem continua em `metadados.quando_em`
-- e o trigger a recalcularia ao reaplicar. `separado_em` NÃO: ele só existe na
-- coluna, e quem já tinha separado um pedido veria o trabalho voltar para a
-- fila. Rodar isto com a equipe no meio do expediente custa duas pessoas
-- separando o mesmo pedido de novo.
-- =====================================================================

begin;

drop trigger if exists trg_pedidos_quando on public.pedidos;
drop function if exists public.pedidos_extrai_quando();
drop index if exists public.idx_pedidos_fila;

alter table public.pedidos drop column if exists quando_em;
alter table public.pedidos drop column if exists separado_em;

-- `painel_marcar_pedido` volta ao corpo da 80 (sem `separado`), verbatim.
create or replace function public.painel_marcar_pedido(p_pedido_id uuid, p_acao text)
returns table(ok boolean, motivo text, status text, pago_em timestamptz, retirado_em timestamptz)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_p record;
begin
  if p_acao not in ('pago', 'retirado') then
    return query select false, 'acao_invalida', null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if not public.auth_pode('marcar_pedido') then
    return query select false, 'sem_permissao', null::text, null::timestamptz, null::timestamptz;
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
           retirado_em = case when coalesce(p.pagamento_modo, 'link') = 'na_retirada'
                              then now() else p.retirado_em end,
           atualizado_em = now()
     where p.id = v_p.id;
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
$fn$;

commit;
