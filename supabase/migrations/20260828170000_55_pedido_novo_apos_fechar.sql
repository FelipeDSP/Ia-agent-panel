-- =====================================================================
-- 55. Pedido novo depois de fechar: o indice guarda CARRINHO, nao VENDA
-- =====================================================================
--
-- POR QUE. Em 28/08 um cliente comprou, o pedido fechou, e no turno seguinte
-- pediu outro curso. Nao havia caminho: `uq_pedidos_conversa_aberta` cobria
-- `rascunho` E `aguardando_pagamento`, entao a conversa nao podia ter um
-- segundo pedido, e `adicionar_item` recusava com "e preciso cancelar e
-- refazer" -- instrucao que, seguida, CANCELA A VENDA JA FEITA. O agente nao
-- seguiu: inventou o item e afirmou uma venda que nao existe.
-- Ver docs/PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md, secoes 9 e 11.
--
-- A saida escolhida (secao 10, aprovada em 28/08) e narrar o indice. `pago`
-- esta no check constraint e NADA no repositorio inteiro jamais o escreve, e o
-- painel de pedidos nao tem Server Action -- entao as unicas saidas de
-- `aguardando_pagamento` sao expirar (24h, preguicoso) e cancelar. Com o
-- indice guardando so `rascunho`, venda fechada deixa de ocupar a vaga e
-- `adicionar_item` cria carrinho novo PELO CAMINHO QUE JA EXISTE
-- (`v_pedido is null -> insert`).
--
-- E o argumento decisivo: **sem decisao nova para o modelo**. Sem tool nova,
-- sem acao nova, sem regra de prompt. O que falhou naquele turno nao foi
-- julgamento, foi nao chamar ferramenta nenhuma -- acrescentar um ponto de
-- decisao a quem ja pulou o anterior piora.
--
-- ---------------------------------------------------------------------
-- O QUE ISTO OBRIGA, E POR QUE NAO CABIA UMA LINHA SO
--
-- `pedido_aberto_da_conversa` faz `limit 1` SEM `order by` sobre os dois
-- status. Enquanto o indice garantia um so, isso era determinista de graca.
-- Com rascunho e venda fechada convivendo, a mesma funcao passaria a devolver
-- QUALQUER UM DOS DOIS, e ela e usada por seis chamadores -- inclusive os que
-- ESCREVEM. Por isso ela e substituida por duas, cada uma com um alvo unico:
--
--   pedido_rascunho_da_conversa  -> o carrinho (o indice garante <= 1)
--   pedido_fechado_da_conversa   -> a venda mais recente ainda nao paga,
--                                   com `order by` EXPLICITO, porque aqui
--                                   nenhum indice garante unicidade
--
-- Sao SEIS chamadores, contados no catalogo e nao de memoria
-- (`prosrc ilike '%pedido_aberto_da_conversa%'`); `api_n8n_adicionar_item`
-- chama duas vezes -- a segunda e o fallback do `on conflict do nothing`.
--
-- ---------------------------------------------------------------------
-- LATE BINDING: O `DROP` NAO AVISA QUEM ESQUECEU
--
-- plpgsql resolve o corpo na EXECUCAO, entao `pg_depend` fica vazio e
-- `drop function` passa sem reclamar de nenhuma funcao que a chame. O
-- esquecimento nao aparece aqui: aparece em runtime, no primeiro cliente, com
-- `42883`. E a mesma nota do CLAUDE.md sobre extensoes, com outro objeto.
--
-- Por isso esta migracao TEM uma conferencia por `prosrc` no fim, que ABORTA se
-- sobrar qualquer referencia ao nome antigo. A varredura tem de alcancar onde a
-- referencia de fato mora, e no plpgsql ela mora no texto do corpo.
--
-- ---------------------------------------------------------------------
-- INVARIANTE: `api_n8n_tem_pedido_pendente` NAO MUDA DE COMPORTAMENTO
--
-- Ela e a guarda do `resolver_conversa` (o sub-workflow chama antes de
-- encerrar). Hoje devolve `true` para carrinho com itens E para venda fechada
-- nao paga. Se o split a levasse para "so o carrinho", conversa com venda
-- pendente viraria encerravel pelo agente -- ninguem pediu, nada quebra, e o
-- sintoma (conversas sumindo da fila antes do pagamento) apareceria semanas
-- depois. Por isso ela sai da lista de consumidores do helper de vez e passa a
-- perguntar EXISTENCIA direto, com os dois status na clausula.
--
--   Para toda conversa com pedido em `rascunho` com itens OU em
--   `aguardando_pagamento`, ela devolve `true` -- antes e depois, igual.
--
-- ---------------------------------------------------------------------
-- ESTA MIGRACAO NAO TOCA NENHUMA LINHA DE `pedidos`. E CONDICAO, NAO ESTILO.
--
-- `trg_pedidos_upd` e BEFORE UPDATE e recarimba `atualizado_em`, e a expiracao
-- compara justamente essa coluna. Em 28/08 ha QUATRO pedidos em
-- `aguardando_pagamento` ja vencidos (parados 6 a 7 dias contra limite de 24h),
-- que so nao viraram `expirado` porque a expiracao e preguicosa. Qualquer
-- `update` neles daria 24h NOVAS a cada um -- e ressuscitar pedido vencido por
-- efeito colateral ja aconteceu uma vez, numa correcao de dado
-- (docs/PENDENCIA-EXPIRACAO-PEDIDO.md, defeito 1).
--
-- `create index` e `drop index` nao tocam linha. Qualquer "aproveitar e
-- arrumar" junto, toca. Nao aproveite.
--
-- Consequencia boa e vale saber: para o estoque de hoje esta migracao quase nao
-- muda nada -- na proxima mensagem daquelas conversas, quatro dos cinco expiram
-- e liberam a vaga sozinhos. O que ela muda e o futuro, e a janela de 24h em
-- que o cliente que acabou de comprar nao consegue comprar de novo.
--
-- ---------------------------------------------------------------------
-- POR QUE NAO `CONCURRENTLY`
--
-- `create index concurrently` nao roda dentro de transacao, e aqui a
-- transacao e o que torna a troca dos dois indices ATOMICA -- em nenhum
-- instante existe uma janela com garantia diferente. `pedidos` tem 12 linhas no
-- banco inteiro, entao a construcao e instantanea e o lock nao e observavel.
-- Numa tabela grande a escolha se inverteria.
--
-- ---------------------------------------------------------------------
-- ACL: DUAS FORMAS, E CONFUNDI-LAS E O ERRO FACIL
--
-- Medido em 28/08 nas 34 SECURITY DEFINER de `public`, e as tres formas cobrem
-- todas:
--
--   n8n_agent+postgres+service_role      22  -- a superficie api_n8n_*
--   postgres+service_role                 8  -- helper interno
--   authenticated+postgres+service_role   4  -- RPC do painel
--
-- Os helpers NAO levam `n8n_agent`: quem os chama e uma SECURITY DEFINER que
-- roda como `postgres`. Dar o grant "por simetria" alarga a superficie a toa.
-- Esquece-lo em `api_n8n_cancelar_pedido` derruba o cancelamento no primeiro
-- cliente -- foi o que a 41 fez com o catalogo do emporio.
--
-- `DROP FUNCTION` apaga o ACL inteiro e o objeto recriado NASCE ABERTO (as
-- ALTER DEFAULT PRIVILEGES deste projeto dao EXECUTE a PUBLIC), entao o
-- `revoke` vem ANTES do `grant` e nao e redundancia.
--
-- `npm run teste:grants-n8n` foi ampliado em 28/08 -- ANTES desta migracao,
-- porque e ele que a confere -- para varrer FORMA de ACL em vez de prefixo, e
-- para exigir que grant explicito a `n8n_agent` fora de `api_n8n_*` esteja
-- declarado. Sem isso, um helper que copiasse o bloco de grants da irma passava
-- batido: verificado por sabotagem.
--
-- ROLLBACK: 20260828170000_55_pedido_novo_apos_fechar_rollback.sql
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. O indice: guarda carrinho, nao venda
-- ---------------------------------------------------------------------
create unique index if not exists uq_pedidos_conversa_rascunho
  on public.pedidos (tenant_id, conversation_id)
  where status = 'rascunho' and deletado_em is null;

drop index if exists public.uq_pedidos_conversa_aberta;

comment on index public.uq_pedidos_conversa_rascunho is
  'UM CARRINHO por conversa. Nao cobre `aguardando_pagamento` de proposito: '
  'venda fechada e venda, nao carrinho, e travar a vaga com ela impedia o '
  'cliente de comprar de novo por ate 24h. Ver migracao 55.';

-- ---------------------------------------------------------------------
-- 2. As duas funcoes de alvo unico
-- ---------------------------------------------------------------------

-- O carrinho. `limit 1` sem `order by` e seguro AQUI, e so aqui: o indice
-- acima garante no maximo uma linha.
create or replace function public.pedido_rascunho_da_conversa(
  p_tenant_id uuid,
  p_conversation_id bigint
) returns uuid
language plpgsql
volatile              -- escreve, via expirar_pedidos_vencidos
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
      and p.status = 'rascunho'
      and p.deletado_em is null
    limit 1
  );
end;
$function$;

-- A venda fechada e ainda nao paga, MAIS RECENTE. O `order by` e explicito e
-- nao e enfeite: aqui podem existir varias, e um `limit 1` solto devolveria
-- qualquer uma -- que e exatamente o defeito que motivou dividir a funcao.
create or replace function public.pedido_fechado_da_conversa(
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
      and p.status = 'aguardando_pagamento'
      and p.deletado_em is null
    order by p.criado_em desc, p.id desc
    limit 1
  );
end;
$function$;

comment on function public.pedido_rascunho_da_conversa(uuid, bigint) is
  'O carrinho da conversa (status rascunho). Substitui metade de '
  'pedido_aberto_da_conversa, que a migracao 55 removeu por ambiguidade.';
comment on function public.pedido_fechado_da_conversa(uuid, bigint) is
  'A venda fechada e nao paga mais recente da conversa. `order by` explicito: '
  'pode haver mais de uma depois da migracao 55.';

-- ---------------------------------------------------------------------
-- 3. Os chamadores, um a um
-- ---------------------------------------------------------------------

-- 3.1 adicionar_item: MESMA assinatura, entao `create or replace` sem drop e
-- sem grant para reconceder. A recusa "e preciso cancelar e refazer" some: com
-- o carrinho como alvo, `v_pedido` nulo agora significa "cria um novo".
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
  v_nota    text := '';
  v_fechado uuid;
  v_num     integer;
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

  v_pedido := public.pedido_rascunho_da_conversa(p_tenant_id, p_conversation_id);

  if v_pedido is null then
    -- ANTES de criar: havia venda fechada? Entao o que comeca aqui e um pedido
    -- NOVO, e o modelo precisa dizer isso ao cliente. O texto sai do BANCO, com
    -- o numero real -- e a informacao que faltava no caso que motivou a 55, em
    -- que o cliente achou estar somando ao pedido que ja tinha comprado.
    v_fechado := public.pedido_fechado_da_conversa(p_tenant_id, p_conversation_id);
    if v_fechado is not null then
      select p.numero into v_num from public.pedidos p where p.id = v_fechado;
      v_nota := format(
        E'Comecando um pedido NOVO. O pedido nº %s ja foi fechado, segue valendo e nao foi alterado.\n\n',
        coalesce(v_num::text, '?'));
    end if;

    insert into public.pedidos (tenant_id, conversation_id, status)
    values (p_tenant_id, p_conversation_id, 'rascunho')
    on conflict do nothing
    returning id into v_pedido;

    if v_pedido is null then
      v_pedido := public.pedido_rascunho_da_conversa(p_tenant_id, p_conversation_id);
    end if;
  end if;

  select p.status into v_status from public.pedidos p where p.id = v_pedido;

  -- REDE, e redundante DE PROPOSITO: `pedido_rascunho_da_conversa` so devolve
  -- rascunho, entao este `if` nao dispara hoje. Fica porque custa nada e e o
  -- que segura o dia em que alguem mexer na funcao de baixo. O texto foi
  -- reescrito para nao ensinar errado se um dia voltar a ser alcancavel.
  if v_status is distinct from 'rascunho' then
    return 'Nao consegui abrir o carrinho desta conversa. Nao afirme que adicionou; '
        || 'peca para o cliente repetir o item.';
  end if;

  insert into public.pedido_itens
    (tenant_id, pedido_id, produto_id, nome_snapshot, preco_unit_centavos, quantidade, observacao)
  values
    (p_tenant_id, v_pedido, v_prod.id, v_prod.nome, v_prod.preco_centavos, v_qtd,
     nullif(btrim(coalesce(p_observacao,'')), ''))
  on conflict (pedido_id, produto_id) do update
    -- DEFINE (migracao 49): repetir a mesma chamada e no-op, em vez de dobrar.
    set quantidade = excluded.quantidade,
        -- PRESERVA, assimetrico de proposito: sob `definir`, toda correcao de
        -- quantidade re-envia a linha, e `excluded.observacao` apagaria o
        -- "sem cebola" a cada ajuste.
        observacao = coalesce(excluded.observacao, public.pedido_itens.observacao);

  return v_nota || coalesce(v_aviso || E'\n\n', '') || public.pedido_em_texto(v_pedido);
end;
$function$;

-- 3.2 remover_item: mesma assinatura. So o alvo e a mensagem mudam.
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
  v_pedido  uuid;
  v_fechado uuid;
  v_num     integer;
  v_n       integer;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  v_pedido := public.pedido_rascunho_da_conversa(p_tenant_id, p_conversation_id);

  if v_pedido is null then
    -- Sem carrinho: pode ser que o cliente queira mexer numa venda ja fechada.
    -- A resposta nomeia o caso e NAO manda cancelar -- era o que a mensagem
    -- antiga fazia, e segui-la destruiria a venda.
    v_fechado := public.pedido_fechado_da_conversa(p_tenant_id, p_conversation_id);
    if v_fechado is not null then
      select p.numero into v_num from public.pedidos p where p.id = v_fechado;
      return format(
        'Nao ha carrinho aberto. O pedido nº %s ja foi fechado e nao aceita alteracao. '
        || 'Se o cliente quer TIRAR um item dele, isso e um caso para atendente humano; '
        || 'se ele quer comprar OUTRA coisa, basta adicionar que abre um pedido novo.',
        coalesce(v_num::text, '?'));
    end if;
    return 'Nao ha carrinho aberto nesta conversa.';
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

-- 3.3 ver_pedido: carrinho se houver, SENAO a ultima venda fechada.
--
-- E o unico dos seis com fallback, e a assimetria e deliberada: `ver` nao
-- escreve, entao errar o alvo custa uma frase. A opcao 2 do `cancelar` -- mesmo
-- formato de fallback -- foi RECUSADA justamente porque la o alvo errado
-- destroi uma venda. Fallback em leitura e conveniencia; fallback em escrita e
-- a faca.
--
-- Sem isto, o cliente que acabou de comprar e pergunta "como ficou meu pedido?"
-- ouviria "nao ha pedido aberto nesta conversa" -- regressao visivel, e do tipo
-- que teste de migracao nao pega sozinho.
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

  v_pedido := public.pedido_rascunho_da_conversa(p_tenant_id, p_conversation_id);

  if v_pedido is null then
    v_pedido := public.pedido_fechado_da_conversa(p_tenant_id, p_conversation_id);
  end if;

  if v_pedido is null then
    return 'Nao ha pedido nesta conversa.';
  end if;

  return public.pedido_em_texto(v_pedido);
end;
$function$;

-- 3.4 fechar_pedido: fecha o CARRINHO. Mesma assinatura.
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
  v_pedido  uuid;
  v_fechado uuid;
  v_itens   integer;
  v_numero  integer;
  v_bruto   text := btrim(coalesce(p_metadados, ''));
  v_meta    jsonb;
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

  v_pedido := public.pedido_rascunho_da_conversa(p_tenant_id, p_conversation_id);

  if v_pedido is null then
    -- ANTES: devolvia "O pedido nº 1 ja foi fechado" + o pedido inteiro, o que
    -- e parafraseavel como "Pedido fechado com sucesso!" -- e foi. Agora a
    -- primeira palavra e a negativa, e a frase diz o que fazer.
    v_fechado := public.pedido_fechado_da_conversa(p_tenant_id, p_conversation_id);
    if v_fechado is not null then
      select p.numero into v_numero from public.pedidos p where p.id = v_fechado;
      return format(
        'NADA FOI FECHADO: nao ha carrinho aberto. O pedido nº %s ja estava fechado antes '
        || 'desta chamada. NAO diga ao cliente que fechou um pedido agora. Se ele quer '
        || 'comprar mais, adicione um item que abre um pedido novo.',
        coalesce(v_numero::text, '?'));
    end if;
    return 'NADA FOI FECHADO: nao ha carrinho nesta conversa. Nao afirme que fechou.';
  end if;

  select count(*) into v_itens from public.pedido_itens i where i.pedido_id = v_pedido;
  if v_itens = 0 then
    return 'NADA FOI FECHADO: o carrinho esta vazio — adicione itens antes de fechar.';
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

-- 3.5 tem_pedido_pendente: a INVARIANTE. Sai da lista de consumidores do
-- helper e pergunta existencia direto, com os DOIS status. O comportamento
-- observavel e identico ao de antes da 55, e tem de continuar sendo.
create or replace function public.api_n8n_tem_pedido_pendente(
  p_tenant_id uuid,
  p_conversation_id bigint
) returns boolean
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  -- A expiracao continua rodando aqui: antes vinha de dentro do helper, e
  -- perde-la faria conversa com pedido vencido seguir "pendente" para sempre
  -- neste caminho -- e este caminho e a guarda do `resolver_conversa`.
  perform public.expirar_pedidos_vencidos(p_tenant_id, p_conversation_id);

  return exists (
    select 1
    from public.pedidos p
    where p.tenant_id = p_tenant_id
      and p.conversation_id = p_conversation_id
      and p.deletado_em is null
      and (
        -- venda fechada e nao paga conta SEMPRE
        p.status = 'aguardando_pagamento'
        -- carrinho conta so se tiver item, igual a antes
        or (p.status = 'rascunho'
            and exists (select 1 from public.pedido_itens i where i.pedido_id = p.id))
      )
  );
end;
$function$;

-- 3.6 cancelar_pedido: ALVO EXPLICITO, default carrinho.
--
-- ASSINATURA NOVA -> `drop function` pela lista completa de tipos ANTES do
-- `create or replace`. Sem o drop, as duas aridades ficam vivas e a chamada de
-- 2 argumentos que o n8n faz hoje vira AMBIGUA -- falha em runtime, no primeiro
-- cliente, e nao aqui. Familia 28/32/37.
drop function if exists public.api_n8n_cancelar_pedido(uuid, bigint);

create or replace function public.api_n8n_cancelar_pedido(
  p_tenant_id uuid,
  p_conversation_id bigint,
  p_alvo text default null
) returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_bruto  text := btrim(coalesce(p_alvo, ''));
  v_num    integer;
  v_pedido uuid;
  v_total  integer;
  v_feito  integer;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  -- O ALVO SO E UMA VENDA SE O TEXTO INTEIRO FOR UM NUMERO (com "pedido"/"nº"
  -- opcionais). Qualquer outra coisa -- inclusive vazio, "carrinho", ou frase
  -- solta -- cai no CARRINHO.
  --
  -- Extrair digitos de qualquer lugar seria mais permissivo e errado: "1 item"
  -- viraria "cancele o pedido nº 1". O default seguro e o que sustenta a opcao
  -- escolhida -- a falha mais provavel do modelo e OMITIR o parametro, medida na
  -- 49, nao errar o valor.
  if v_bruto ~ '^(pedido[[:space:]]*)?(n[[:alpha:]º°.]*[[:space:]]*)?[0-9]+$' then
    v_num := nullif(regexp_replace(v_bruto, '[^0-9]', '', 'g'), '')::integer;
  end if;

  if v_num is not null then
    select p.id, p.total_centavos into v_pedido, v_total
    from public.pedidos p
    where p.tenant_id = p_tenant_id
      and p.conversation_id = p_conversation_id
      and p.numero = v_num
      and p.status = 'aguardando_pagamento'
      and p.deletado_em is null;

    if v_pedido is null then
      return format(
        'NADA FOI CANCELADO: nao ha pedido nº %s em aberto nesta conversa. '
        || 'Confirme o numero com o cliente.', v_num);
    end if;

    update public.pedidos p set status = 'cancelado' where p.id = v_pedido;
    get diagnostics v_feito = row_count;
    if v_feito = 0 then
      return 'NADA FOI CANCELADO: tente de novo.';
    end if;

    return format('Pedido nº %s (%s) cancelado.', v_num, public.centavos_brl(v_total));
  end if;

  v_pedido := public.pedido_rascunho_da_conversa(p_tenant_id, p_conversation_id);
  if v_pedido is null then
    return 'NADA FOI CANCELADO: nao ha carrinho aberto nesta conversa. '
        || 'Para cancelar uma venda ja fechada, informe o numero dela.';
  end if;

  update public.pedidos p set status = 'cancelado' where p.id = v_pedido;

  -- A frase antiga terminava em "A conversa esta livre para um novo pedido".
  -- Depois desta migracao isso descreve comportamento que nao existe mais: a
  -- conversa ja estava livre, porque venda fechada nao ocupa a vaga. Mensagem
  -- que descreve comportamento inexistente e como esta pendencia comecou.
  return 'Carrinho descartado. Nenhum pedido ja fechado foi afetado.';
end;
$function$;

comment on function public.api_n8n_cancelar_pedido(uuid, bigint, text) is
  'Cancela o CARRINHO por default. Para cancelar uma venda fechada, p_alvo tem '
  'de ser o numero dela. Ver migracao 55: o default seguro e o desenho.';

-- ---------------------------------------------------------------------
-- 4. Grants — o `drop` do 3.6 apagou o ACL inteiro
-- ---------------------------------------------------------------------
-- `revoke` ANTES do `grant`, e nao e redundancia: o objeto recriado nasce com
-- EXECUTE para PUBLIC/anon/authenticated pelas ALTER DEFAULT PRIVILEGES deste
-- projeto. Sem o revoke, o `grant` seria decoracao sobre um objeto ja aberto.
revoke all on function public.api_n8n_cancelar_pedido(uuid, bigint, text)
  from public, anon, authenticated;
grant execute on function public.api_n8n_cancelar_pedido(uuid, bigint, text) to service_role;
grant execute on function public.api_n8n_cancelar_pedido(uuid, bigint, text) to n8n_agent;

-- Os helpers NOVOS seguem a forma de helper: SEM `n8n_agent`. Quem os chama e
-- uma SECURITY DEFINER que roda como `postgres`.
revoke all on function public.pedido_rascunho_da_conversa(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.pedido_rascunho_da_conversa(uuid, bigint) to service_role;

revoke all on function public.pedido_fechado_da_conversa(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.pedido_fechado_da_conversa(uuid, bigint) to service_role;

-- ---------------------------------------------------------------------
-- 5. O helper antigo sai — DEPOIS de todo mundo ser repontado
-- ---------------------------------------------------------------------
drop function if exists public.pedido_aberto_da_conversa(uuid, bigint);

-- ---------------------------------------------------------------------
-- 6. CONFERENCIA QUE ABORTA — porque o `drop` acima nao reclama de ninguem
-- ---------------------------------------------------------------------
-- plpgsql e late binding: `pg_depend` fica vazio e o drop passa mesmo com
-- chamadores vivos. O unico lugar onde a referencia existe e o texto do corpo.
do $$
declare
  v_orfas text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_orfas
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosrc ilike '%pedido\_aberto\_da\_conversa%';

  if v_orfas is not null then
    raise exception
      'MIGRACAO 55 ABORTADA: ainda ha funcao chamando pedido_aberto_da_conversa: %. '
      'Late binding faz o drop passar calado e a falha aparecer em runtime, no '
      'primeiro cliente, com 42883.', v_orfas;
  end if;
end;
$$;

-- E a contraprova da invariante do indice, no mesmo lugar: se a troca de
-- indices nao entrou, nada aqui adianta.
do $$
begin
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'uq_pedidos_conversa_rascunho') then
    raise exception 'MIGRACAO 55 ABORTADA: uq_pedidos_conversa_rascunho nao foi criado.';
  end if;
  if exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'uq_pedidos_conversa_aberta') then
    raise exception 'MIGRACAO 55 ABORTADA: uq_pedidos_conversa_aberta ainda existe.';
  end if;
end;
$$;

commit;
