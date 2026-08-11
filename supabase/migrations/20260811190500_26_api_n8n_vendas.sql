-- 26_api_n8n_vendas
--
-- Fatia 2 de vendas, parte 2: as funcoes que o agente chama. Tabelas na 25.
-- Separada de proposito: corrigir uma funcao com bug nao passa perto dos dados
-- de pedido.
--
-- AS DUAS TRAVAS (docs/VENDAS-ESTADO.md), aqui viradas em codigo:
--
-- 1. PRECO E TOTAL NUNCA VEM DE FORA. `adicionar_item` recebe produto e
--    quantidade, e busca o preco no catalogo do tenant. `fechar_pedido` nao tem
--    parametro de valor: o total ja esta somado pelo trigger da 25. Se o LLM
--    pudesse informar preco, um cliente insistente conseguiria desconto — o
--    modelo cede para ser prestativo.
--
-- 2. TODA TOOL QUE MEXE NO PEDIDO DEVOLVE O CARRINHO INTEIRO EM TEXTO. A memoria
--    Redis tem janela curta; sem reinjetar o estado a cada turno, o carrinho
--    evapora em quatro trocas e o agente passa a inventar o que tinha nele.
--
-- ERRO E CONVERSA, NAO EXCECAO. Produto inexistente, pedido ja fechado, carrinho
-- vazio: tudo volta como TEXTO que o agente repassa ao cliente, nao como
-- exception. Exception no meio de uma conversa vira "desculpe, ocorreu um erro"
-- — e o cliente fica sem saber o que fazer. Exception fica so para o que e falha
-- de verdade: tenant invalido, parametro ausente.
--
-- Todas SECURITY DEFINER, search_path = public, p_tenant_id primeiro, grant so
-- para n8n_agent. Sem grant de tabela: e por aqui ou nao e.
--
-- Rollback: 20260811190500_26_api_n8n_vendas_rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- 0. Formatacao de dinheiro para o texto que o agente le em voz alta
-- ---------------------------------------------------------------------------
-- Nao usa to_char: os simbolos G e D dele saem do lc_numeric do servidor, que
-- aqui e en_US — daria "R$ 1,234.50" para o cliente brasileiro. Montado a mao
-- com aritmetica inteira, pela mesma razao de o banco guardar centavos: nenhum
-- float no caminho do dinheiro.

create or replace function public.centavos_brl(p_centavos integer)
returns text
language sql
immutable
set search_path = public
as $$
  select 'R$ ' ||
         -- separador de milhar: inverte, agrupa de 3, tira o ponto sobrando,
         -- desinverte. regexp do Postgres nao tem lookahead, dai o vaivem.
         reverse(regexp_replace(
           regexp_replace(reverse((abs(coalesce(p_centavos, 0)) / 100)::text), '(\d{3})', '\1.', 'g'),
           '\.$', ''
         )) || ',' ||
         lpad((abs(coalesce(p_centavos, 0)) % 100)::text, 2, '0');
$$;

comment on function public.centavos_brl(integer) is
  'Centavos -> "R$ 1.234,50". Aritmetica inteira, sem to_char (lc_numeric do '
  'servidor e en_US) e sem float.';

-- ---------------------------------------------------------------------------
-- 0b. Carrinho em texto — o retorno da trava 2
-- ---------------------------------------------------------------------------

create or replace function public.pedido_em_texto(p_pedido_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ped   record;
  v_linhas text;
  v_itens  integer;
begin
  select p.numero, p.status, p.total_centavos into v_ped
  from public.pedidos p where p.id = p_pedido_id;

  if not found then
    return 'Nenhum pedido aberto nesta conversa.';
  end if;

  select string_agg(
           format('- %sx %s — %s%s',
                  i.quantidade,
                  i.nome_snapshot,
                  public.centavos_brl((i.preco_unit_centavos * i.quantidade)::integer),
                  case when coalesce(btrim(i.observacao), '') <> ''
                       then ' (' || i.observacao || ')' else '' end),
           E'\n' order by i.criado_em),
         count(*)
    into v_linhas, v_itens
  from public.pedido_itens i
  where i.pedido_id = p_pedido_id;

  if coalesce(v_itens, 0) = 0 then
    return 'O pedido esta vazio.';
  end if;

  return format(
    E'%sPedido atual:\n%s\nTotal: %s',
    case when v_ped.numero is not null
         then format('Pedido nº %s. ', v_ped.numero) else '' end,
    v_linhas,
    public.centavos_brl(v_ped.total_centavos)
  );
end;
$$;

comment on function public.pedido_em_texto(uuid) is
  'Carrinho inteiro em texto. Toda tool que mexe no pedido devolve isto — e o '
  'que reinjeta o estado na memoria curta do agente a cada turno (trava 2).';

-- ---------------------------------------------------------------------------
-- 0c. Localiza o pedido ABERTO da conversa
-- ---------------------------------------------------------------------------
-- Aberto = rascunho ou aguardando_pagamento. O indice unico da 25 garante que
-- ha no maximo um.

create or replace function public.pedido_aberto_da_conversa(
  p_tenant_id uuid,
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

-- ---------------------------------------------------------------------------
-- 1. buscar_produtos
-- ---------------------------------------------------------------------------
-- Mesma regra de visibilidade que adicionar_item usa: o agente nunca oferece o
-- que nao poderia vender. Divergir as duas seria o agente prometer um item e a
-- adicao recusar — pior que nao encontrar.
--
-- LIMIT 10 porque o retorno entra no contexto do modelo a cada busca. Catalogo
-- de 200 itens sem limite entope a janela e empurra o carrinho para fora dela.

create or replace function public.api_n8n_buscar_produtos(
  p_tenant_id uuid,
  p_termo     text
)
returns table (
  produto_id     uuid,
  nome           text,
  preco_centavos integer,
  preco          text,
  unidade        text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_termo text := btrim(coalesce(p_termo, ''));
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  return query
  select p.id, p.nome, p.preco_centavos, public.centavos_brl(p.preco_centavos), p.unidade
  from public.produtos p
  where p.tenant_id = p_tenant_id
    and p.deletado_em is null
    and p.disponivel
    and (p.estoque is null or p.estoque > 0)
    and (
      v_termo = ''
      or p.nome ilike '%' || v_termo || '%'
      or to_tsvector('portuguese', p.nome || ' ' || coalesce(p.descricao, ''))
         @@ plainto_tsquery('portuguese', v_termo)
    )
  order by
    -- casamento no nome antes de casamento so na descricao: quem pede "pudim"
    -- quer o pudim, nao o prato cuja descricao menciona pudim.
    (p.nome ilike '%' || v_termo || '%') desc,
    p.nome
  limit 10;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. adicionar_item
-- ---------------------------------------------------------------------------

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

  -- PRODUTO DAQUELE TENANT E VISIVEL. O filtro por tenant_id e o que impede um
  -- produto_id alheio (alucinado ou vazado) de entrar no pedido: nao ha
  -- correspondencia, e a resposta e a mesma de produto inexistente — nao
  -- confirma que o id existe noutro cliente.
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

  -- Pedido aberto, ou cria um rascunho. O insert corre com o indice unico da 25:
  -- se duas chamadas simultaneas tentarem abrir, uma perde e reaproveita a
  -- outra em vez de criar carrinho paralelo.
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

  -- SNAPSHOT do nome e do preco no momento da entrada. No conflito soma a
  -- quantidade e MANTEM o preco da primeira adicao: reajuste no meio da conversa
  -- nao muda o que ja estava no carrinho.
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

-- ---------------------------------------------------------------------------
-- 3. remover_item
-- ---------------------------------------------------------------------------

create or replace function public.api_n8n_remover_item(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_produto_id      uuid
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
$$;

-- ---------------------------------------------------------------------------
-- 4. ver_pedido
-- ---------------------------------------------------------------------------

create or replace function public.api_n8n_ver_pedido(
  p_tenant_id       uuid,
  p_conversation_id bigint
)
returns text
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
    return 'Nao ha pedido aberto nesta conversa.';
  end if;

  return public.pedido_em_texto(v_pedido);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. fechar_pedido
-- ---------------------------------------------------------------------------
-- SEM PARAMETRO DE VALOR, de proposito: o total ja esta somado pelo trigger da
-- 25 a partir dos itens. E a trava 1 na sua forma mais direta.

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

  -- Numero legivel por tenant. A corrida do max()+1 e coberta pelo indice unico
  -- (tenant_id, numero) da 25: duas transacoes simultaneas nao geram numeros
  -- iguais em silencio.
  select coalesce(max(p.numero), 0) + 1 into v_numero
  from public.pedidos p where p.tenant_id = p_tenant_id;

  update public.pedidos p
  set status    = 'aguardando_pagamento',
      numero    = v_numero,
      -- merge: preserva o que ja houvesse em metadados
      metadados = p.metadados || coalesce(p_metadados, '{}'::jsonb)
  where p.id = v_pedido;

  return format(E'Pedido nº %s fechado.\n%s', v_numero, public.pedido_em_texto(v_pedido));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. cancelar_pedido
-- ---------------------------------------------------------------------------
-- Cancela tanto rascunho quanto ja fechado. Se so cancelasse rascunho, um
-- pedido fechado prenderia a conversa para sempre: o indice unico impede abrir
-- outro, e nao haveria como sair do estado.

create or replace function public.api_n8n_cancelar_pedido(
  p_tenant_id       uuid,
  p_conversation_id bigint
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
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
$$;

-- ---------------------------------------------------------------------------
-- 7. tem_pedido_pendente
-- ---------------------------------------------------------------------------
-- Guarda do resolver_conversa: nao encerrar atendimento com pedido no ar.
--
-- EXIGE PELO MENOS UM ITEM. Um rascunho vazio — criado por um adicionar_item que
-- falhou depois, ou por engano — prenderia a conversa para sempre, impedindo o
-- agente de finalizar mesmo sem nada pendente de verdade.

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

-- ---------------------------------------------------------------------------
-- 8. Fechamento de permissoes
-- ---------------------------------------------------------------------------
-- O Postgres da EXECUTE a PUBLIC em toda funcao nova, e estas sao SECURITY
-- DEFINER: sem o revoke, anon chamaria passando qualquer tenant_id.

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'api\_n8n\_%'
           or p.proname in ('pedido_em_texto', 'pedido_aberto_da_conversa'))
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon, authenticated', f.sig);
  end loop;

  -- Grant so para as api_n8n_*: os dois auxiliares sao internos.
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'api\_n8n\_%'
  loop
    execute format('grant execute on function %s to n8n_agent', f.sig);
  end loop;
end $$;

commit;
