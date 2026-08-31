-- =====================================================================
-- ROLLBACK da 55 — volta a "um pedido aberto por conversa"
-- =====================================================================
--
-- LEIA ISTO ANTES DE RODAR: O ROLLBACK PODE SER IMPOSSIVEL, E DE PROPOSITO.
--
-- A 55 permite que uma conversa tenha um carrinho E uma venda fechada ao mesmo
-- tempo. O indice antigo (`uq_pedidos_conversa_aberta`) proibe exatamente isso.
-- Entao, se qualquer conversa tiver ganhado o segundo pedido depois da 55, o
-- indice antigo NAO PODE ser recriado, e este script ABORTA com a lista.
--
-- Isso nao e defeito do rollback: e a unica forma honesta. As saidas, se
-- acontecer, sao decisao de negocio e nao de migracao -- cancelar o carrinho
-- das conversas listadas, ou marcar as vendas antigas como `pago`/`expirado`.
-- Nenhuma delas cabe aqui, porque as duas MEXEM EM PEDIDO DE CLIENTE.
--
-- Por isso, a janela em que este rollback e trivial e curta: enquanto ninguem
-- tiver comprado duas vezes na mesma conversa. Depois disso, prefira consertar
-- para frente.
--
-- ---------------------------------------------------------------------
-- ORDEM INVERSA, E ELA IMPORTA
--
-- 1. `pedido_aberto_da_conversa` volta a existir ANTES de os chamadores
--    voltarem a cita-la -- nao por dependencia (plpgsql e late binding e nao
--    reclamaria), mas para que a janela dentro da transacao nunca tenha corpo
--    apontando para funcao ausente;
-- 2. os seis chamadores voltam ao corpo pre-55;
-- 3. `api_n8n_cancelar_pedido` volta a 2 argumentos -- com `drop` da assinatura
--    de 3 pela lista completa de tipos, senao as duas ficam vivas e a chamada
--    de 2 argumentos vira AMBIGUA (familia 28/32/37);
-- 4. os grants voltam: `DROP FUNCTION` apaga o ACL e o objeto recriado nasce
--    ABERTO. `revoke` antes do `grant`, sempre;
-- 5. os helpers novos saem;
-- 6. o indice volta -- e e aqui que pode abortar.
--
-- ---------------------------------------------------------------------
-- ESTE ROLLBACK TAMBEM NAO TOCA LINHA DE `pedidos`.
--
-- Mesma razao da migracao: `trg_pedidos_upd` recarimba `atualizado_em` e daria
-- 24h novas a todo pedido vencido. Quem roda um rollback ja esta num momento
-- ruim; ressuscitar pedido vencido junto nao ajuda.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. A checagem que decide se este rollback e possivel — ANTES de mexer
-- ---------------------------------------------------------------------
do $$
declare
  v_conflito text;
begin
  select string_agg(format('tenant %s / conversa %s (%s pedidos vivos)',
                           tenant_id, conversation_id, n), '; ')
    into v_conflito
  from (
    select p.tenant_id, p.conversation_id, count(*) n
    from public.pedidos p
    where p.status in ('rascunho', 'aguardando_pagamento')
      and p.deletado_em is null
    group by p.tenant_id, p.conversation_id
    having count(*) > 1
  ) s;

  if v_conflito is not null then
    raise exception
      'ROLLBACK DA 55 IMPOSSIVEL: ha conversa com mais de um pedido vivo, que e '
      'justamente o que a 55 passou a permitir e o indice antigo proibe. %. '
      'Resolver isso e decisao de negocio (cancelar o carrinho, ou marcar a venda '
      'como paga/expirada) e nao cabe num rollback -- as duas mexem em pedido de '
      'cliente. Considere consertar para frente.', v_conflito;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. O helper antigo volta
-- ---------------------------------------------------------------------
create or replace function public.pedido_aberto_da_conversa(
  p_tenant_id uuid,
  p_conversation_id bigint
) returns uuid
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
begin
  perform public.expirar_pedidos_vencidos(p_tenant_id, p_conversation_id);

  return (
    select p.id
    from public.pedidos p
    where p.tenant_id = p_tenant_id
      and p.conversation_id = p_conversation_id
      and p.status in ('rascunho', 'aguardando_pagamento')
      and p.deletado_em is null
    limit 1
  );
end;
$function$;

revoke all on function public.pedido_aberto_da_conversa(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.pedido_aberto_da_conversa(uuid, bigint) to service_role;

-- ---------------------------------------------------------------------
-- 2. Os chamadores voltam ao corpo pre-55
-- ---------------------------------------------------------------------
create or replace function public.api_n8n_adicionar_item(
  p_tenant_id uuid,
  p_conversation_id bigint,
  p_produto_id uuid,
  p_quantidade integer,
  p_observacao text default null
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
    (p_tenant_id, v_pedido, v_prod.id, v_prod.nome, v_prod.preco_centavos, v_qtd,
     nullif(btrim(coalesce(p_observacao,'')), ''))
  on conflict (pedido_id, produto_id) do update
    set quantidade = excluded.quantidade,
        observacao = coalesce(excluded.observacao, public.pedido_itens.observacao);

  return coalesce(v_aviso || E'\n\n', '') || public.pedido_em_texto(v_pedido);
end;
$function$;

create or replace function public.api_n8n_remover_item(
  p_tenant_id uuid,
  p_conversation_id bigint,
  p_produto_id uuid
) returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_pedido uuid;
  v_status text;
  v_n      integer;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  v_pedido := public.pedido_aberto_da_conversa(p_tenant_id, p_conversation_id);
  if v_pedido is null then
    return 'Nao ha pedido aberto nesta conversa.';
  end if;

  select p.status into v_status from public.pedidos p where p.id = v_pedido;
  if v_status <> 'rascunho' then
    return 'O pedido ja foi fechado e nao aceita alteracao. Para mudar, e preciso cancelar e refazer.';
  end if;

  delete from public.pedido_itens i
  where i.pedido_id = v_pedido and i.produto_id = p_produto_id;
  get diagnostics v_n = row_count;

  if v_n = 0 then
    return 'Esse item nao esta no pedido. ' || public.pedido_em_texto(v_pedido);
  end if;

  return public.pedido_em_texto(v_pedido);
end;
$function$;

create or replace function public.api_n8n_ver_pedido(
  p_tenant_id uuid,
  p_conversation_id bigint
) returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_pedido uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  v_pedido := public.pedido_aberto_da_conversa(p_tenant_id, p_conversation_id);
  if v_pedido is null then
    return 'Nao ha pedido aberto nesta conversa.';
  end if;

  return public.pedido_em_texto(v_pedido);
end;
$function$;

create or replace function public.api_n8n_fechar_pedido(
  p_tenant_id uuid,
  p_conversation_id bigint,
  p_metadados text default null
) returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_pedido uuid;
  v_status text;
  v_itens  integer;
  v_numero integer;
  v_bruto  text := btrim(coalesce(p_metadados, ''));
  v_meta   jsonb;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if v_bruto = '' then
    v_meta := '{}'::jsonb;
  else
    begin
      v_meta := v_bruto::jsonb;
      if jsonb_typeof(v_meta) <> 'object' then
        v_meta := jsonb_build_object('observacao', v_bruto);
      end if;
    exception when others then
      v_meta := jsonb_build_object('observacao', v_bruto);
    end;
  end if;

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
      metadados = p.metadados || v_meta
  where p.id = v_pedido;

  return format(E'Pedido nº %s fechado.\n%s', v_numero, public.pedido_em_texto(v_pedido));
end;
$function$;

create or replace function public.api_n8n_tem_pedido_pendente(
  p_tenant_id uuid,
  p_conversation_id bigint
) returns boolean
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
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
$function$;

-- ---------------------------------------------------------------------
-- 3. `cancelar_pedido` volta a 2 argumentos
-- ---------------------------------------------------------------------
-- DROP PELA LISTA COMPLETA DE TIPOS. Sem ele as duas aridades ficam vivas e a
-- chamada de 2 argumentos -- que e a que o n8n volta a fazer -- fica AMBIGUA.
drop function if exists public.api_n8n_cancelar_pedido(uuid, bigint, text);

create or replace function public.api_n8n_cancelar_pedido(
  p_tenant_id uuid,
  p_conversation_id bigint
) returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_pedido uuid;
  v_numero integer;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  v_pedido := public.pedido_aberto_da_conversa(p_tenant_id, p_conversation_id);
  if v_pedido is null then
    return 'Nao ha pedido aberto nesta conversa.';
  end if;

  update public.pedidos p
  set status = 'cancelado'
  where p.id = v_pedido
  returning p.numero into v_numero;

  return case when v_numero is null
              then 'Pedido cancelado. A conversa esta livre para um novo pedido.'
              else format('Pedido nº %s cancelado. A conversa esta livre para um novo pedido.', v_numero)
         end;
end;
$function$;

-- Os DOIS roles. `service_role` e o do PostgREST; o n8n conecta como
-- `n8n_agent` e e essa a linha que ele usa em toda mensagem. As migracoes 40 e
-- 41 sairam so com a primeira, e a 41 derrubou o catalogo do emporio na hora.
revoke all on function public.api_n8n_cancelar_pedido(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.api_n8n_cancelar_pedido(uuid, bigint) to service_role;
grant execute on function public.api_n8n_cancelar_pedido(uuid, bigint) to n8n_agent;

-- ---------------------------------------------------------------------
-- 4. Os helpers novos saem
-- ---------------------------------------------------------------------
drop function if exists public.pedido_rascunho_da_conversa(uuid, bigint);
drop function if exists public.pedido_fechado_da_conversa(uuid, bigint);

-- ---------------------------------------------------------------------
-- 5. O indice antigo volta
-- ---------------------------------------------------------------------
create unique index if not exists uq_pedidos_conversa_aberta
  on public.pedidos (tenant_id, conversation_id)
  where status in ('rascunho', 'aguardando_pagamento') and deletado_em is null;

drop index if exists public.uq_pedidos_conversa_rascunho;

-- ---------------------------------------------------------------------
-- 6. Conferencia — nenhum corpo pode ter sobrado apontando para os novos
-- ---------------------------------------------------------------------
do $$
declare
  v_orfas text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_orfas
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (p.prosrc ilike '%pedido\_rascunho\_da\_conversa%'
      or p.prosrc ilike '%pedido\_fechado\_da\_conversa%');

  if v_orfas is not null then
    raise exception
      'ROLLBACK DA 55 INCOMPLETO: ainda ha funcao chamando os helpers da 55: %. '
      'Late binding faz o drop passar calado e a falha aparecer em runtime.', v_orfas;
  end if;

  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'uq_pedidos_conversa_aberta') then
    raise exception 'ROLLBACK DA 55 INCOMPLETO: uq_pedidos_conversa_aberta nao voltou.';
  end if;
end;
$$;

commit;
