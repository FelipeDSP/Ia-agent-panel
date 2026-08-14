-- Migracao 38 — pedido nao pago expira na leitura e destrava a conversa
--
-- O PROBLEMA, com dado real: `uq_pedidos_conversa_aberta` (migracao 25) cobre
-- `rascunho` E `aguardando_pagamento`. Um pedido fechado que nunca foi pago
-- ocupa a vaga daquela conversa para sempre — e `api_n8n_adicionar_item`
-- responde "O pedido ja foi fechado e nao aceita alteracao", sem saida que o
-- cliente possa tomar sozinho. Em 14/08 havia exatamente um: nº 1, R$ 331,80,
-- parado ha 2,9 dias. Com meio de pagamento no fluxo, esse vira o caso comum —
-- cliente recebe o link e nao paga.
--
-- ===================== POR QUE NA LEITURA, SEM AGENDADOR =====================
--
-- O estado `expirado` existe na CHECK desde a 25 e NUNCA foi escrito por nada:
-- a funcao que faria isso ficou num rascunho e nao sobreviveu a migracao real.
-- Instalar `pg_cron` agora consertaria o sintoma e criaria o mesmo defeito um
-- nivel acima — falha de cron vai para `cron.job_run_details` e para o log do
-- Postgres, dois lugares que ninguem abre, e o agendamento nao entra em
-- `supabase/baseline/`, entao ambiente novo sobe sem ele, calado.
--
-- Expirar na leitura nao tem como apodrecer: a chamada E o disparo. E o momento
-- em que o pedido velho atrapalha e exatamente o momento em que o cliente tenta
-- pedir de novo — nao as 3h da manha.
--
-- O QUE ISSO NAO RESOLVE, e e limite honesto: nao ha aviso PROATIVO. Quem nunca
-- mais escrever nao sera avisado de nada; ele descobre quando voltar. "Avisamos
-- 1h antes de vencer" exige agir sobre quem NAO volta, e ai nao existe leitura
-- onde pendurar — ai sim precisaria de agendador. E outra fatia.
--
-- ========================= ESCOPO: SO `aguardando_pagamento` =================
--
-- `rascunho` NAO expira, e a omissao e deliberada. Ali o "bloqueio" e o carrinho
-- do proprio cliente: expirar destruiria trabalho dele para resolver um problema
-- que ele nao tem. O caso observado esta inteiro no outro estado.
--
-- ============================ O RELOGIO =====================================
--
-- `atualizado_em`, nao `criado_em`: para um pedido em `aguardando_pagamento` ele
-- e o instante do fechamento, que e quando a contagem deve comecar. Fora de
-- `rascunho` o pedido nao aceita alteracao de item, entao nada reinicia esse
-- relogio por acidente.
--
-- ROLLBACK: 20260814160000_38_expirar_pedido_nao_pago_rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. Quantas horas ate expirar — configuravel por cliente
-- ---------------------------------------------------------------------------
-- O prazo e do meio de pagamento, nao nosso: pix vence em minutos, boleto em
-- dias. Fica em `tenant_tools.config` da tool `vendas`, que e onde a config por
-- cliente ja mora. Valor invalido ou ausente cai no default de 24h em vez de
-- desligar a expiracao — configuracao errada nao deve travar conversa.
create or replace function public.pedido_horas_para_expirar(p_tenant_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(regexp_replace(
      coalesce((select t.config ->> 'horas_expirar_pagamento'
                  from public.tenant_tools t
                 where t.tenant_id = p_tenant_id and t.tool_nome = 'vendas'), ''),
      '[^0-9]', '', 'g'), '')::integer,
    24
  );
$$;

comment on function public.pedido_horas_para_expirar(uuid) is
  'Horas ate um pedido aguardando_pagamento expirar. tenant_tools.config -> '
  'horas_expirar_pagamento, default 24. Config invalida cai no default: '
  'configuracao errada nao pode travar a conversa do cliente.';

-- ---------------------------------------------------------------------------
-- 2. A expiracao, com o aviso que volta para o agente
-- ---------------------------------------------------------------------------
-- Devolve TEXTO (o aviso) ou NULL quando nao havia nada a expirar. E o que
-- permite o agente contar ao cliente na MESMA resposta em que abre o pedido
-- novo. Liberar em silencio faria o cliente seguir achando que o pedido antigo
-- esta de pe, e descobrir na entrega.
--
-- IDEMPOTENTE: a segunda chamada no mesmo turno nao acha nada e devolve NULL.
-- Isso importa porque `pedido_aberto_da_conversa` tambem chama — e as duas
-- chamadas acontecem no mesmo `adicionar_item`.
create or replace function public.expirar_pedidos_vencidos(
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
  v_numero integer;
  v_total  integer;
begin
  update public.pedidos p
     set status = 'expirado',
         atualizado_em = now()
   where p.tenant_id = p_tenant_id
     and p.conversation_id = p_conversation_id
     and p.status = 'aguardando_pagamento'
     and p.deletado_em is null
     and p.atualizado_em < now() - make_interval(hours => public.pedido_horas_para_expirar(p_tenant_id))
  returning p.numero, p.total_centavos into v_numero, v_total;

  if v_numero is null then
    return null;
  end if;

  return format(
    'O pedido anterior (nº %s, %s) expirou por falta de pagamento e foi liberado.',
    v_numero, public.centavos_brl(v_total)
  );
end;
$$;

comment on function public.expirar_pedidos_vencidos(uuid, bigint) is
  'Expira pedido aguardando_pagamento vencido daquela conversa e devolve o aviso '
  'para o agente repassar. NULL quando nao havia nada. Idempotente.';

-- ---------------------------------------------------------------------------
-- 3. `pedido_aberto_da_conversa` passa a expirar antes de responder
-- ---------------------------------------------------------------------------
-- UM SO PONTO. Toda funcao de pedido passa por aqui, entao expirar neste lugar
-- faz leitura e escrita concordarem sempre — em vez de as leituras ignorarem o
-- pedido vencido enquanto o banco ainda o chama de `aguardando_pagamento`. Duas
-- verdades sobre o mesmo pedido foi o defeito que a migracao 30 eliminou; nao
-- vale reintroduzir por outra porta.
--
-- DEIXA DE SER `stable` E VIRA `volatile`. Consequencia real, e nao obvia pelo
-- nome: leitura de pedido agora ESCREVE.
drop function if exists public.pedido_aberto_da_conversa(uuid, bigint);

create or replace function public.pedido_aberto_da_conversa(
  p_tenant_id       uuid,
  p_conversation_id bigint
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
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
$$;

comment on function public.pedido_aberto_da_conversa(uuid, bigint) is
  'Pedido aberto da conversa. VOLATILE desde a migracao 38: expira pedido '
  'aguardando_pagamento vencido ANTES de responder, para leitura e escrita nao '
  'divergirem.';

-- ---------------------------------------------------------------------------
-- 4. `tem_pedido_pendente` herda a volatilidade — e isso tem consequencia
-- ---------------------------------------------------------------------------
-- LEIA ANTES DE MEXER. Esta funcao e a GUARDA DO `resolver_conversa`: o
-- sub-workflow `Tool - Resolver Conversa (Multi-Tenant)` a chama para nao
-- encerrar conversa com pedido em aberto.
--
-- Desde a migracao 38 ela chama `pedido_aberto_da_conversa`, que e VOLATILE.
-- Entao: O AGENTE ENCERRANDO UMA CONVERSA PODE ALTERAR ESTADO DE PEDIDO como
-- efeito colateral. Um pedido vencido daquela conversa vira `expirado` no
-- momento em que o agente pergunta "posso encerrar?".
--
-- Isso e CORRETO — o pedido esta vencido de fato, e encerrar a conversa e
-- exatamente quando alguem deveria perceber. Mas ninguem espera escrita de uma
-- funcao chamada "tem_pedido_pendente", e essa surpresa e o que este comentario
-- existe para evitar. Ha asserçao no teste amarrando o comportamento, para nao
-- virar descoberta em producao.
drop function if exists public.api_n8n_tem_pedido_pendente(uuid, bigint);

create or replace function public.api_n8n_tem_pedido_pendente(
  p_tenant_id       uuid,
  p_conversation_id bigint
)
returns boolean
language plpgsql
volatile
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

comment on function public.api_n8n_tem_pedido_pendente(uuid, bigint) is
  'Guarda do resolver_conversa. VOLATILE desde a 38: encerrar conversa expira '
  'pedido vencido como efeito colateral. Correto, mas surpreendente pelo nome.';

-- ---------------------------------------------------------------------------
-- 5. `adicionar_item` conta ao cliente, na mesma resposta
-- ---------------------------------------------------------------------------
-- Chama a expiracao EXPLICITAMENTE para capturar o aviso — a chamada de dentro
-- do `pedido_aberto_da_conversa` tambem expiraria, mas descarta o texto, e sem o
-- texto o cliente nao fica sabendo.
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
$$;

commit;
