-- =====================================================================
-- 71 — O fato "pagamento confirmado" tem fim
-- =====================================================================
-- `api_n8n_estado_pedido` (mesma assinatura; o portão e o serviço leem a
-- mesma linha) so devolve `pagamento_confirmado = true` enquanto o ultimo
-- pedido da conversa esta PAGO, NAO RETIRADO e pago ha menos de 24 h. Antes
-- era "pago" e pronto, para sempre: com a 69 (pago/retirado no balcao) o
-- pedido nº 5 do sendbox ficou pago, e todo turno seguinte injetava no
-- modelo "o pagamento desta conversa esta confirmado" — ele nao montava
-- pedido novo nem depois de a memoria ser limpa (17/09).
--
-- `pago_em` so existe desde a 69 (painel); o webhook do Asaas nao o grava.
-- Por isso `coalesce(pago_em, atualizado_em)`: para o pago pelo link, vale a
-- ultima escrita (o proprio `pago`, ou o claim do aviso logo depois).
--
-- `create or replace` de mesma assinatura: ACL preservado. Extensão: nenhuma.
-- REEXECUTÁVEL.
-- =====================================================================

begin;

CREATE OR REPLACE FUNCTION public.api_n8n_estado_pedido(p_tenant_id uuid, p_conversation_id bigint, p_perfil text DEFAULT 'vendas'::text, p_teto_segundos integer DEFAULT 300)
 RETURNS TABLE(tem_pedido boolean, pedido_id uuid, pedido_status text, pedido_numero integer, total_centavos integer, itens jsonb, escreveu_neste_turno boolean, barrou_anterior boolean, pagamento_confirmado boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_limite     timestamptz;
  v_tocado     uuid;
  v_ref        uuid;
  v_status     text;
  v_numero     integer;
  v_total      integer;
  v_itens      jsonb;
  v_barrou     boolean;
  v_pago       boolean;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if coalesce(p_perfil, '') <> 'vendas' then
    return query select false, null::uuid, null::text, null::integer, 0, '[]'::jsonb,
                        false, false, false;
    return;
  end if;

  -- ------------------------------------------------------------------
  -- O LIMITE DA JANELA — DUAS BORDAS, E A DE CIMA NAO E ENFEITE
  -- ------------------------------------------------------------------
  -- A borda de baixo e a ultima saida ja registrada: `Registra Mensagem` roda
  -- DEPOIS do portao, entao ela e a do turno anterior, e "mutou depois dela"
  -- cobre o turno inteiro, inclusive as tool calls.
  --
  -- Sozinha, ela e larga demais. Medido em 2026-09-09 sobre `mensagens_log`:
  -- o intervalo entre saidas consecutivas tem MEDIANA de 41 s, mas p95 de
  -- 103.898 s (28,9 h) e MAXIMO de 18 DIAS. Sem teto, uma conversa que ficou
  -- parada duas semanas leria qualquer mutacao daquele periodo como "escreveu
  -- neste turno" — e passaria uma fabricacao por isso.
  --
  -- O teto sai da outra ponta da mesma medicao: a distancia entre a escrita e o
  -- turno que a narrou, nas 22 escritas do historico, e de 1,3 s (minimo),
  -- 2,3 s (mediana), 7,3 s (p95) e 10,0 s (MAXIMO). O default de 300 s e 30x o
  -- maximo observado e ainda assim corta a janela de 18 dias para 5 minutos.
  v_limite := greatest(
    coalesce((select max(m.criado_em)
                from public.mensagens_log m
               where m.tenant_id = p_tenant_id
                 and m.conversation_id = p_conversation_id
                 and m.direcao = 'saida'), '-infinity'::timestamptz),
    now() - make_interval(secs => greatest(coalesce(p_teto_segundos, 300), 1))
  );

  -- ------------------------------------------------------------------
  -- A REFERENCIA: O PEDIDO TOCADO NO TURNO, E SO ENTAO O RASCUNHO
  -- ------------------------------------------------------------------
  -- MUDANCA DA 61: `pedido_cobrancas` entra no `greatest`. Gerar o link E
  -- escrita do turno, e nenhuma linha de `pedidos` se mexe quando isso
  -- acontece — sem esta parte, a mensagem que ENTREGA o link ("Prontinho! aqui
  -- esta o link de pagamento") cai na regra 1 do portao, que barra afirmacao de
  -- efeito consumado sem escrita no turno. Seria o portao barrando exatamente o
  -- passo que a fase de pagamento existe para dar.
  select p.id into v_tocado
    from public.pedidos p
   where p.tenant_id = p_tenant_id
     and p.conversation_id = p_conversation_id
     and p.deletado_em is null
     and greatest(
           p.atualizado_em,
           coalesce((select max(i.atualizado_em)
                       from public.pedido_itens i
                      where i.pedido_id = p.id
                        and i.tenant_id = p_tenant_id), p.atualizado_em),
           coalesce((select max(c.atualizado_em)
                       from public.pedido_cobrancas c
                      where c.pedido_id = p.id
                        and c.tenant_id = p_tenant_id), p.atualizado_em)
         ) > v_limite
   order by p.atualizado_em desc
   limit 1;

  if v_tocado is null then
    select p.id into v_ref
      from public.pedidos p
     where p.tenant_id = p_tenant_id
       and p.conversation_id = p_conversation_id
       and p.status = 'rascunho'
       and p.deletado_em is null
     limit 1;
  else
    v_ref := v_tocado;
  end if;

  select coalesce((m.portao ->> 'veredito') like 'barrado%', false)
    into v_barrou
    from public.mensagens_log m
   where m.tenant_id = p_tenant_id
     and m.conversation_id = p_conversation_id
     and m.direcao = 'saida'
   order by m.criado_em desc
   limit 1;

  -- ------------------------------------------------------------------
  -- `pagamento_confirmado` — FORA DA JANELA, DE PROPOSITO
  -- ------------------------------------------------------------------
  -- O pedido MAIS RECENTE da conversa esta `pago`? Fora da janela porque a
  -- pergunta "caiu?" chega quando o cliente quiser, e a regra 3 do portao
  -- precisa distinguir "afirmou pagamento que nao existe" de "confirmou um
  -- pagamento que existe, meia hora depois".
  --
  -- MAIS RECENTE, e nao "existe algum pago": um cliente que pagou ontem e
  -- comecou um carrinho novo hoje nao tem pagamento confirmado para o carrinho
  -- de hoje, e afirmar que tem seria a mesma falha com outra roupa.
  --
  -- O RASCUNHO E VERIFICADO A PARTE, e nao por `order by criado_em desc`, e a
  -- razao e concreta: `now()` e o instante da TRANSACAO, entao dois pedidos
  -- criados na mesma transacao tem `criado_em` IDENTICO e a ordenacao vira
  -- moeda. Foi assim que a §12 do teste pegou este trecho errado na primeira
  -- execucao — carrinho novo depois de pagar continuava dando `true`.
  --
  -- `uq_pedidos_conversa_rascunho` garante no maximo um rascunho vivo, entao o
  -- `exists` e exato. E a semantica fica dita em vez de emergir da ordenacao:
  -- havendo carrinho aberto, o pagamento de antes nao vale para ele.
  if exists (select 1 from public.pedidos p
              where p.tenant_id = p_tenant_id
                and p.conversation_id = p_conversation_id
                and p.status = 'rascunho'
                and p.deletado_em is null) then
    v_pago := false;
  else
    -- 71: o fato "pagamento confirmado" tem FIM. Pedido retirado encerrou o
    -- ciclo (nada mais a confirmar); pago sem retirada vale por 24 h — o
    -- "caiu?" de meia hora depois continua coberto, e a conversa da semana
    -- seguinte comeca limpa. Sem isto, um pedido pago no balcao (69) fazia
    -- TODO turno seguinte dizer ao modelo que a venda ja estava paga, e ele
    -- nao montava pedido novo (sendbox, 17/09).
    select coalesce(p.status = 'pago'
                    and p.retirado_em is null
                    and coalesce(p.pago_em, p.atualizado_em) > now() - interval '24 hours', false)
      into v_pago
      from public.pedidos p
     where p.tenant_id = p_tenant_id
       and p.conversation_id = p_conversation_id
       and p.deletado_em is null
     -- `id desc` como desempate: nao tem significado, tem DETERMINISMO. Sem
     -- ele, empate de `criado_em` faz esta funcao responder coisas diferentes
     -- para a mesma pergunta.
     order by p.criado_em desc, p.id desc
     limit 1;
  end if;

  if v_ref is null then
    return query select false, null::uuid, null::text, null::integer, 0, '[]'::jsonb,
                        false, coalesce(v_barrou, false), coalesce(v_pago, false);
    return;
  end if;

  select p.status, p.numero, coalesce(p.total_centavos, 0)
    into v_status, v_numero, v_total
    from public.pedidos p
   where p.id = v_ref and p.tenant_id = p_tenant_id;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'nome',                i.nome_snapshot,
             'quantidade',          i.quantidade,
             'preco_unit_centavos', i.preco_unit_centavos,
             'subtotal_centavos',   (i.preco_unit_centavos::bigint * i.quantidade)::integer
           ) order by i.criado_em
         ), '[]'::jsonb)
    into v_itens
    from public.pedido_itens i
   where i.pedido_id = v_ref
     and i.tenant_id = p_tenant_id;

  return query
    select true, v_ref, v_status, v_numero, v_total, v_itens,
           v_tocado is not null,
           coalesce(v_barrou, false),
           coalesce(v_pago, false);
end;
$function$
;

commit;
