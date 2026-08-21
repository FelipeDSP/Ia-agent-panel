-- Migracao 49 — `api_n8n_adicionar_item` DEFINE a quantidade, nao soma
--
-- NAO APLICADA EM PRODUCAO. Ao aplicar fora do CLI: escolha a versao ANTES,
-- renomeie ESTE arquivo e o rollback para ela, e grave a linha do ledger na
-- MESMA transacao — foi assim que a 47 e a 48 entraram, e por isso o nome delas
-- bate com `supabase_migrations.schema_migrations` (CLAUDE.md, Migracoes). O
-- topo do ledger e `20260821180500` (48).
--
-- ============================== A MUDANCA, INTEIRA =========================
--
--   do update set quantidade = public.pedido_itens.quantidade + excluded.quantidade   -- antes
--   do update set quantidade = excluded.quantidade                                    -- agora
--
-- Uma linha. Todo o resto do corpo e identico ao que a migracao 38 deixou.
--
-- ===================== O MOTIVO E IDEMPOTENCIA, NAO "SOMAR ERA ERRADO" =====
--
-- Somar era decisao de desenho, e estava TESTADA (`tests/migracao-vendas.mjs`
-- afirmava "dois adicionar_item do mesmo produto SOMAM"). O que mudou nao foi a
-- opiniao sobre somar: foi a descoberta de que o re-envio acontece.
--
-- Em 20/08, no `emporio`, o modelo inventou uma falha que nao houve, re-adicionou
-- dois itens no turno seguinte, e a soma DOBROU o pedido: o cliente pediu
-- R$ 45,00 e o pedido fechou em R$ 75,00, em `aguardando_pagamento`. O dado foi
-- corrigido a mao em 21/08; o defeito e este. Ver
-- docs/PENDENCIA-CARRINHO-MULTI-ITEM.md.
--
-- Somar faz re-envio DOBRAR. Definir faz re-envio virar NO-OP. A confusao do
-- modelo deixa de custar dinheiro.
--
-- E o modelo tem o que precisa para operar assim: a funcao devolve o carrinho
-- INTEIRO a cada chamada, entao "poe mais um" e ele mandar o total novo.
--
-- ===================== O CUSTO, EXPLICITO E COM UM AGRAVANTE ===============
--
-- Se o cliente diz "mais um" e o modelo manda `1` em vez de `4`, o carrinho CAI
-- para 1. Tambem e erro — mas e um erro VISIVEL: o carrinho volta menor, e a
-- proxima linha do resumo mostra. Dobrar era invisivel, e foi por isso que
-- passou por uma demonstracao inteira sem ninguem notar.
--
-- O AGRAVANTE, que nao estava no desenho e vale escrever: o no `Adiciona Item`
-- do `tool-gerenciar-pedido` passa
-- `coalesce(nullif(btrim($4::text), '')::int, 1)`. Ou seja, **modelo que OMITE a
-- quantidade manda 1**. Sob a soma antiga isso era "some mais um"; sob esta
-- migracao e "a linha inteira vira 1". Omitir parametro e mais facil que errar
-- numero, entao a falha aceita acima e mais provavel do que parece — e continua
-- sendo a falha barulhenta, que e o lado certo do balanco.
--
-- ===================== A `observacao` NAO MUDA, E E ASSIMETRIA DE PROPOSITO =
--
--   observacao = coalesce(excluded.observacao, public.pedido_itens.observacao)
--
-- Fica como esta. Quantidade passa a ser DECLARATIVA e observacao continua
-- PRESERVADA, e sim, isso e uma assimetria — escrita aqui porque alguem vai
-- querer "consistencia" e trocar por `excluded.observacao`. O motivo de nao:
--
-- Sob `definir`, TODA correcao de quantidade re-envia a linha, e o modelo nao
-- tem por que repetir a observacao a cada ajuste. Com `excluded.observacao`, um
-- "na verdade sao 3" apagaria o "sem cebola" que o cliente pediu — uma falha
-- NOVA e de alta frequencia, criada pela propria mudanca. Com o coalesce, a
-- falha que sobra e o oposto: observacao velha que sobrevive quando o cliente
-- QUER tira-la, que e mais raro e tem saida — `remover` e `adicionar` de novo
-- limpa a linha.
--
-- Trocar uma falha rara com saida por uma frequente sem saida nao paga.
--
-- ===================== POR QUE NAO HA `drop function` =====================
--
-- Assinatura IDENTICA — `(uuid, bigint, uuid, integer, text)`, com o mesmo
-- default no ultimo parametro. Sem `drop`:
--
--   - nao ha aridade ambigua (28, 32, 37);
--   - NENHUM grant e apagado, entao nao ha nada para reconceder (40, 41). O ACL
--     atravessa intacto, e `npm run teste:migracao-vendas` confere isso por DIFF
--     antes/depois em vez de contra a lista escrita a mao, que foi como a 41
--     passou verde sem `n8n_agent`;
--   - `create or replace` de mesma aridade e reexecutavel.
--
-- Os dois `grant` no fim ficam mesmo assim, idempotentes: se alguem acrescentar
-- um `drop` aqui um dia, eles evitam que a 49 vire a sexta da familia.
--
-- ===================== ORDEM DE IMPLANTACAO ================================
--
-- SQL sozinho. Nao ha mudanca de workflow, de prompt, nem de codigo do painel —
-- o unico consumidor em runtime e o no `Adiciona Item` do
-- `tool-gerenciar-pedido`, e ele nao muda: a mesma chamada passa a ter outro
-- significado. Nao existe janela de quebra em nenhuma ordem.
--
-- ROLLBACK: devolve a soma. E devolve tambem o risco de dobrar — leia o
-- cabecalho do arquivo de rollback antes.

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

  -- NOTA, e nao e o escopo desta migracao: com `v_pedido` nulo, `v_status` fica
  -- nulo, `null <> 'rascunho'` e NULL, e este `if` NAO dispara. O statement
  -- seguinte entao insere com `pedido_id` nulo e levanta `23503` — medido. Ou
  -- seja, o buraco existe mas produz execucao vermelha, nao gravacao silenciosa.
  -- Fica registrado em docs/PENDENCIA-CARRINHO-MULTI-ITEM.md, secao 4.
  if v_status <> 'rascunho' then
    return 'O pedido ja foi fechado e nao aceita alteracao. Para mudar, e preciso cancelar e refazer.';
  end if;

  insert into public.pedido_itens
    (tenant_id, pedido_id, produto_id, nome_snapshot, preco_unit_centavos, quantidade, observacao)
  values
    (p_tenant_id, v_pedido, v_prod.id, v_prod.nome, v_prod.preco_centavos, v_qtd, nullif(btrim(coalesce(p_observacao,'')), ''))
  on conflict (pedido_id, produto_id) do update
    -- DEFINE. Era `pedido_itens.quantidade + excluded.quantidade`, e a soma fez
    -- um re-envio do modelo dobrar um pedido real. Definir torna a chamada
    -- IDEMPOTENTE: repetir a mesma chamada nao muda nada.
    set quantidade = excluded.quantidade,
        -- PRESERVA, de proposito, e assimetrico em relacao a linha de cima. Ver
        -- o cabecalho: sob `definir`, toda correcao de quantidade re-envia a
        -- linha, e trocar por `excluded.observacao` apagaria o "sem cebola" do
        -- cliente a cada ajuste de quantidade.
        observacao = coalesce(excluded.observacao, public.pedido_itens.observacao);

  return coalesce(v_aviso || E'\n\n', '') || public.pedido_em_texto(v_pedido);
end;
$function$;

comment on function public.api_n8n_adicionar_item(uuid, bigint, uuid, integer, text) is
  'Poe um item no carrinho. A quantidade e DEFINIDA, nao somada (migracao 49): '
  'chamar duas vezes com 3 deixa 3, nao 6. E idempotencia — a soma fez um re-envio '
  'do modelo dobrar um pedido real em 20/08. A observacao continua PRESERVADA '
  'quando a nova e nula, assimetria deliberada. Ver docs/PENDENCIA-CARRINHO-MULTI-ITEM.md.';

-- Sem `drop function` acima, o ACL nunca foi apagado e nao ha nada para
-- reconceder. As linhas ficam por seguranca e sao idempotentes. `n8n_agent` e o
-- role pelo qual o agente conecta — nao e `service_role`, e era essa a que
-- faltava na 40 e na 41.
grant execute on function public.api_n8n_adicionar_item(uuid, bigint, uuid, integer, text) to service_role;
grant execute on function public.api_n8n_adicionar_item(uuid, bigint, uuid, integer, text) to n8n_agent;

commit;
