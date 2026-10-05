-- =====================================================================
-- Migração 79 — o portão enxerga o pedido que ACABOU de ser fechado
-- =====================================================================
-- DEFEITO, achado na conversa 39 do Empório em 05/10/2026, olhando a venda do
-- Douglas (02/10):
--
--   19:15:45.174  `fechar_pedido` -> pedido #6 em `aguardando_pagamento`
--   19:15:45.398  a tool manda o ENDEREÇO de retirada (migração 72) e o
--                 registra em `mensagens_log` como `saida`
--   19:15:47.285  o portão roda, calcula `v_limite` = 19:15:45.398 (a última
--                 saída), e o pedido — atualizado 224 ms ANTES disso — não é
--                 `> v_limite`. `tem_pedido: false`, `total: 0`.
--                 Veredito: `barrado_regra_1`.
--
-- O cliente, que acabara de fechar a compra, recebeu a substituta: "Ainda não
-- tenho nenhum item anotado no seu pedido aqui". A venda ESTAVA no banco.
--
-- Não é defeito do portão nem da 72 isoladamente: é a premissa da janela que
-- deixou de valer. Ela foi escrita quando `Registra Mensagem` só rodava DEPOIS
-- do portão — então a última saída era, por construção, o fim do turno
-- anterior. A 72 passou a escrever no MEIO do turno e a premissa caiu, sem
-- nada quebrar visivelmente: o portão continuou "funcionando", só que cego
-- exatamente no turno que mais importa, o do fechamento da venda.
--
-- A CORREÇÃO: a borda de baixo passa a ignorar as mensagens que uma tool
-- escreve no meio do turno (hoje só `endereco_retirada`). Nada mais muda —
-- mesma assinatura, mesmo retorno, `create or replace` (sem `drop`, então os
-- grants ficam; a armadilha das migrações 40/41 é o DROP).
--
-- Quem usa, e por isso a mudança é de comportamento e não de forma: o portão
-- (`n8n/aplica-portao.js`) e o fato de sistema do pagamento confirmado.
--
-- Rollback: 20261005120000_79_portao_ve_o_fechamento_rollback.sql
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
  --
  -- 05/10/2026 — A BORDA DE BAIXO IGNORA ESCRITA DE MEIO DE TURNO.
  --
  -- O comentario acima diz "`Registra Mensagem` roda DEPOIS do portao, entao
  -- ela e a do turno anterior". Isso deixou de ser verdade na migracao 72: ao
  -- fechar um pedido para retirada, a tool manda o endereco ao cliente E o
  -- registra em `mensagens_log` como saida — no MEIO do turno, antes do
  -- portao. A borda de baixo passou a ser essa mensagem, e o pedido que
  -- acabava de ser fechado ficava ABAIXO dela.
  --
  -- Medido na conversa 39 do Emporio (02/10/2026, venda do Douglas):
  --   19:15:45.174  pedido #6 fechado (aguardando_pagamento)
  --   19:15:45.398  endereco registrado como saida  <- virou o v_limite
  --   19:15:47.285  portao: tem_pedido=false, total=0 -> barrado_regra_1
  -- O cliente, que tinha acabado de fechar a compra, recebeu "Ainda nao tenho
  -- nenhum item anotado no seu pedido aqui". A venda existia; a frase que a
  -- confirmava foi barrada pela guarda que existe para proteger a venda.
  --
  -- A correcao e dizer o que a borda sempre quis dizer: o fim do turno
  -- ANTERIOR. Mensagem escrita por uma tool no meio do turno nao fecha turno.
  -- A lista sai do servico (`agente/src/tools/*`: hoje so `endereco_retirada`)
  -- e `teste:portao-fechamento` a deriva de la — tool nova que registrar
  -- mensagem no meio do turno e que nao entrar aqui reprova o teste, em vez de
  -- reabrir este defeito em silencio.
  v_limite := greatest(
    coalesce((select max(m.criado_em)
                from public.mensagens_log m
               where m.tenant_id = p_tenant_id
                 and m.conversation_id = p_conversation_id
                 and m.direcao = 'saida'
                 and coalesce(m.fonte_tokens, '') <> 'endereco_retirada'), '-infinity'::timestamptz),
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

comment on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) is
  'Estado do pedido para o portao de saida. A borda de baixo da janela ignora mensagem escrita por tool no meio do turno (endereco_retirada, migracao 72) — sem isso o pedido recem-fechado cai fora da janela e a confirmacao da venda e barrada (conversa 39 do Emporio, 02/10/2026).';

-- `create or replace` de mesma assinatura preserva o ACL; conferido pelo teste
-- com diff antes/depois, que e o que distingue "grants intactos" de
-- "reafirmei a lista que eu mesmo escrevi".
commit;
