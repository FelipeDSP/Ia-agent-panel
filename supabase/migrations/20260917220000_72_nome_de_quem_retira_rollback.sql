-- =====================================================================
-- ROLLBACK da 72 — volta os tres corpos anteriores, verbatim; dropa a coluna
-- =====================================================================
-- Dropar `retirada_nome` PERDE os nomes ja informados (dado que so existe
-- aqui). Nao aborta: nao e financeiro. Extensão: nenhuma. REEXECUTÁVEL.
-- =====================================================================

begin;

-- ---- api_n8n_fechar_pedido(uuid,bigint,text): corpo anterior à 72, verbatim (pg_get_functiondef em 17/09/2026) ----
CREATE OR REPLACE FUNCTION public.api_n8n_fechar_pedido(p_tenant_id uuid, p_conversation_id bigint, p_metadados text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pedido     uuid;
  v_fechado    uuid;
  v_itens      integer;
  v_numero     integer;
  v_bruto      text := btrim(coalesce(p_metadados, ''));
  v_meta       jsonb;
  v_pagamentos text[];
  v_entrega    text;
  v_pagamento  text;
  v_modalidade text;
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

  -- --- 69: modalidade e forma de pagar, validadas contra a oferta ---
  select o.pagamentos, o.entrega into v_pagamentos, v_entrega from public.vendas_oferta(p_tenant_id) o;
  -- tenant sem linha de `vendas`: a tool nem deveria ter chegado aqui; o
  -- comportamento de antes (link) é o mais seguro
  v_pagamentos := coalesce(v_pagamentos, array['link']);
  v_entrega    := coalesce(v_entrega, 'nao');

  v_modalidade := lower(btrim(coalesce(v_meta ->> 'modalidade', '')));
  -- a chave antiga `entrega` ("retirada"/"entrega") continua chegando do
  -- modelo; lê-se como modalidade quando bate com um dos dois valores
  if v_modalidade = '' and lower(btrim(coalesce(v_meta ->> 'entrega', ''))) in ('retirada', 'entrega') then
    v_modalidade := lower(btrim(v_meta ->> 'entrega'));
  end if;
  if v_modalidade = 'entrega' then
    if v_entrega = 'atendente' then
      return 'NADA FOI FECHADO: pedido para ENTREGA nao e fechado pelo agente. Chame '
          || 'transferir_humano informando no motivo que o cliente quer entrega e os itens '
          || 'do carrinho; um atendente combina a entrega e o valor.';
    end if;
    return 'NADA FOI FECHADO: este estabelecimento nao faz entrega pelo agente — so retirada '
        || 'no local. Pergunte ao cliente se quer retirar; se sim, feche com modalidade=retirada.';
  end if;
  if v_modalidade not in ('', 'retirada') then
    return format('NADA FOI FECHADO: modalidade "%s" nao existe. Use "retirada".', v_modalidade);
  end if;
  v_modalidade := 'retirada';

  v_pagamento := lower(btrim(coalesce(v_meta ->> 'pagamento', '')));
  if v_pagamento = '' then
    if array_length(v_pagamentos, 1) = 1 then
      v_pagamento := v_pagamentos[1];
    else
      return 'NADA FOI FECHADO: falta saber como o cliente prefere pagar. Pergunte: por link '
          || '(Pix/cartao, agora) ou na retirada (paga quando buscar)? Depois chame fechar de '
          || 'novo com pagamento="link" ou pagamento="na_retirada".';
    end if;
  elsif v_pagamento not in ('link', 'na_retirada') then
    return format('NADA FOI FECHADO: pagamento "%s" nao existe. Opcoes: %s.',
                  v_pagamento, array_to_string(v_pagamentos, ' ou '));
  elsif not (v_pagamento = any (v_pagamentos)) then
    return format('NADA FOI FECHADO: este estabelecimento nao aceita pagamento "%s". '
                  || 'Opcoes: %s. Confirme com o cliente e chame fechar de novo.',
                  v_pagamento, array_to_string(v_pagamentos, ' ou '));
  end if;

  select coalesce(max(p.numero), 0) + 1 into v_numero
  from public.pedidos p where p.tenant_id = p_tenant_id;

  update public.pedidos p
  set status         = 'aguardando_pagamento',
      numero         = v_numero,
      modalidade     = v_modalidade,
      pagamento_modo = v_pagamento,
      -- as duas chaves viraram coluna; o resto (observacao, entrega antiga…) fica
      metadados      = p.metadados || (v_meta - 'pagamento' - 'modalidade')
  where p.id = v_pedido;

  if v_pagamento = 'na_retirada' then
    return format(E'Pedido nº %s fechado — retirada no local, pagamento NA RETIRADA (nao gere link; '
                  || E'nao diga que esta pago).\n%s', v_numero, public.pedido_em_texto(v_pedido));
  end if;
  return format(E'Pedido nº %s fechado.\n%s', v_numero, public.pedido_em_texto(v_pedido));
end;
$function$
;

-- ---- api_n8n_notificar_venda(uuid,bigint,integer): corpo anterior à 72, verbatim (pg_get_functiondef em 17/09/2026) ----
CREATE OR REPLACE FUNCTION public.api_n8n_notificar_venda(p_tenant_id uuid, p_conversation_id bigint, p_reclaim_minutos integer DEFAULT 5)
 RETURNS TABLE(pedido_id uuid, numero integer, sessao text, destino text, mensagem text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ativa    boolean;
  v_cfg      jsonb;
  v_canal    text;
  v_sessao   text;
  v_destino  text;
  v_eventos  text[];
  v_nota     boolean;
  v_pedido   uuid;
  v_numero   integer;
  v_total    integer;
  v_meta     jsonb;
  v_modo     text;
  v_modal    text;
  v_nome     text;
  v_fone     text;
  v_itens    text;
  v_entrega  text;
  v_obs      text;
  v_msg      text;
  -- piso de 1 minuto: `p_reclaim_minutos => 0` desligaria a idempotencia, que e
  -- a unica razao de esta funcao existir. Parametro nao derruba invariante.
  v_janela   integer := greatest(coalesce(p_reclaim_minutos, 5), 1);
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  -- --- a tool tem de estar contratada (agencia) E ativa (cliente) ---
  select coalesce(tt.ativo and tt.contratado, false),
         coalesce(tt.config, '{}'::jsonb)
    into v_ativa, v_cfg
  from public.tenant_tools tt
  where tt.tenant_id = p_tenant_id
    and tt.tool_nome = 'vendas';

  if not coalesce(v_ativa, false) then
    return;
  end if;

  v_canal   := v_cfg #>> '{notificacao,canal}';
  v_sessao  := btrim(coalesce(v_cfg #>> '{notificacao,sessao}', ''));
  v_destino := btrim(coalesce(v_cfg #>> '{notificacao,destino}', ''));

  -- 69: o dono escolhe quais eventos avisam e se quer a nota no Chatwoot
  select o.eventos, o.nota_chatwoot into v_eventos, v_nota from public.vendas_oferta(p_tenant_id) o;
  v_nota := coalesce(v_nota, false);
  if v_eventos is not null and not ('pedido_fechado' = any (v_eventos)) then
    return;
  end if;

  -- Config vazia nao e erro, e estado. Sai sem gastar o claim, para que
  -- preencher o numero amanha passe a valer da proxima venda. 69: sem
  -- WhatsApp mas com a nota pedida, segue com sessao/destino nulos.
  -- 70: canal `chatwoot` (sem sessao) e `waha` sem sessao saem pela inbox do
  -- agente; `waha` com sessao continua no WAHA. O que decide e ter DESTINO.
  if coalesce(v_canal, 'nenhum') not in ('waha', 'chatwoot') or v_destino = '' then
    if not v_nota then
      return;
    end if;
    v_sessao := null; v_destino := null;
  else
    v_sessao := nullif(v_sessao, '');
  end if;

  -- --- o pedido recem-fechado desta conversa ---
  select p.id, p.numero, p.total_centavos, p.metadados, p.pagamento_modo, p.modalidade
    into v_pedido, v_numero, v_total, v_meta, v_modo, v_modal
  from public.pedidos p
  where p.tenant_id       = p_tenant_id
    and p.conversation_id = p_conversation_id
    and p.status          = 'aguardando_pagamento'
    and p.deletado_em is null
  order by p.criado_em desc
  limit 1;

  if v_pedido is null then
    return;
  end if;

  -- --- O CLAIM ---
  -- Atomico pelo `where`: sob concorrencia a segunda transacao espera o lock da
  -- linha, reavalia a condicao contra a versao ja atualizada (READ COMMITTED) e
  -- nao encontra nada para atualizar. `enviado_em` presente bloqueia para
  -- sempre; `reservado_em` sozinho bloqueia so ate a janela vencer.
  update public.pedidos p
  set metadados = p.metadados
                || jsonb_build_object(
                     'notificacao',
                     coalesce(p.metadados -> 'notificacao', '{}'::jsonb)
                       || jsonb_build_object('reservado_em', to_jsonb(now()))
                   )
  where p.id        = v_pedido
    and p.tenant_id = p_tenant_id
    and p.metadados #> '{notificacao,enviado_em}' is null
    and coalesce((p.metadados #>> '{notificacao,reservado_em}')::timestamptz,
                 '-infinity'::timestamptz) < now() - make_interval(mins => v_janela);

  if not found then
    return;
  end if;

  -- --- o texto ---
  select cv.contact_name, cv.phone
    into v_nome, v_fone
  from public.conversas cv
  where cv.tenant_id       = p_tenant_id
    and cv.conversation_id = p_conversation_id;

  select string_agg(
           format('- %sx %s — %s%s',
                  i.quantidade,
                  i.nome_snapshot,
                  public.centavos_brl((i.preco_unit_centavos * i.quantidade)::integer),
                  case when coalesce(btrim(i.observacao), '') <> ''
                       then ' (' || i.observacao || ')' else '' end),
           E'\n' order by i.criado_em)
    into v_itens
  from public.pedido_itens i
  where i.pedido_id = v_pedido
    and i.tenant_id = p_tenant_id;

  v_entrega := btrim(coalesce(v_meta ->> 'entrega', ''));
  v_obs     := btrim(coalesce(v_meta ->> 'observacao', ''));

  -- JID no lugar do nome cai fora; ver `contato_exibivel` no topo.
  v_nome := public.contato_exibivel(v_nome);

  v_msg :=
      format(E'🛒 *Venda fechada — pedido nº %s*\n', coalesce(v_numero::text, '?'))
    || case when coalesce(btrim(v_nome), '') <> ''
            then format(E'\n👤 %s', btrim(v_nome)) else '' end
    -- O `+` e o que faz o WhatsApp transformar o numero em link tocavel; sem
    -- ele o dono le o telefone e digita a mao.
    || case when coalesce(btrim(v_fone), '') <> ''
            then format(E'\n📱 %s%s',
                        case when btrim(v_fone) ~ '^[0-9]+$' then '+' else '' end,
                        btrim(v_fone))
            else '' end
    || format(E'\n\n%s', coalesce(v_itens, '(sem itens)'))
    || format(E'\n\n💰 *Total: %s*', public.centavos_brl(coalesce(v_total, 0)))
    -- 69: coluna primeiro; o texto solto antigo so quando a coluna e nula
    || case when v_modal = 'retirada' then E'\n\n📦 Retirada no local'
            when v_modal = 'entrega'  then E'\n\n📦 Entrega'
            when v_entrega <> ''      then format(E'\n\n📦 Entrega: %s', v_entrega)
            else '' end
    || case when v_modo = 'na_retirada' then E'\n💳 Pagamento: NA RETIRADA — marque como pago no painel quando receber'
            when v_modo = 'link'        then E'\n💳 Pagamento: por link (o agente cobra)'
            else '' end
    -- `observacao` nao estava na lista de campos pedida, e entra porque e
    -- instrucao do proprio cliente ("Retirada as 7h15" no pedido nº 2): perder
    -- isso e o dono separar o pedido na hora errada.
    || case when v_obs <> '' then format(E'\n📝 Obs.: %s', v_obs) else '' end;

  return query select v_pedido, v_numero, v_sessao, v_destino, v_msg;
end;
$function$
;

-- ---- api_agente_aviso_pedido(uuid,bigint,text,uuid,integer): corpo anterior à 72, verbatim (pg_get_functiondef em 17/09/2026) ----
CREATE OR REPLACE FUNCTION public.api_agente_aviso_pedido(p_tenant_id uuid, p_conversation_id bigint, p_evento text, p_pedido_id uuid DEFAULT NULL::uuid, p_reclaim_minutos integer DEFAULT 5)
 RETURNS TABLE(pedido_id uuid, numero integer, sessao text, destino text, nota_chatwoot boolean, mensagem text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ativa    boolean;
  v_cfg      jsonb;
  v_canal    text;
  v_sessao   text;
  v_destino  text;
  v_eventos  text[];
  v_nota     boolean;
  v_status   text;
  v_pedido   uuid;
  v_numero   integer;
  v_total    integer;
  v_modo     text;
  v_modal    text;
  v_nome     text;
  v_fone     text;
  v_msg      text;
  v_janela   integer := greatest(coalesce(p_reclaim_minutos, 5), 1);
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_evento not in ('pagamento_confirmado', 'pedido_cancelado') then
    return;
  end if;
  v_status := case p_evento when 'pagamento_confirmado' then 'pago' else 'cancelado' end;

  select coalesce(tt.ativo and tt.contratado, false), coalesce(tt.config, '{}'::jsonb)
    into v_ativa, v_cfg
  from public.tenant_tools tt
  where tt.tenant_id = p_tenant_id and tt.tool_nome = 'vendas';
  if not coalesce(v_ativa, false) then
    return;
  end if;

  select o.eventos, o.nota_chatwoot into v_eventos, v_nota from public.vendas_oferta(p_tenant_id) o;
  v_nota := coalesce(v_nota, false);
  if v_eventos is null or not (p_evento = any (v_eventos)) then
    return;
  end if;

  v_canal   := v_cfg #>> '{notificacao,canal}';
  v_sessao  := btrim(coalesce(v_cfg #>> '{notificacao,sessao}', ''));
  v_destino := btrim(coalesce(v_cfg #>> '{notificacao,destino}', ''));
  -- sem WhatsApp configurado, a nota no Chatwoot ainda pode ir sozinha.
  -- 70: canal `chatwoot` (sem sessao) sai pela inbox do agente; o que decide
  -- e ter DESTINO, e a sessao vazia vira nula (o servico escolhe o caminho).
  if (coalesce(v_canal, 'nenhum') not in ('waha', 'chatwoot') or v_destino = '')
     and not v_nota then
    return;
  end if;
  if coalesce(v_canal, 'nenhum') not in ('waha', 'chatwoot') or v_destino = '' then
    v_sessao := null; v_destino := null;
  else
    v_sessao := nullif(v_sessao, '');
  end if;

  select p.id, p.numero, p.total_centavos, p.pagamento_modo, p.modalidade
    into v_pedido, v_numero, v_total, v_modo, v_modal
  from public.pedidos p
  where p.tenant_id       = p_tenant_id
    and p.conversation_id = p_conversation_id
    and p.status          = v_status
    and p.deletado_em is null
    and (p_pedido_id is null or p.id = p_pedido_id)
  order by p.atualizado_em desc, p.criado_em desc
  limit 1;
  if v_pedido is null then
    return;
  end if;

  -- o claim, por evento
  update public.pedidos p
  set metadados = p.metadados
                || jsonb_build_object('avisos',
                     coalesce(p.metadados -> 'avisos', '{}'::jsonb)
                     || jsonb_build_object(p_evento,
                          coalesce(p.metadados -> 'avisos' -> p_evento, '{}'::jsonb)
                          || jsonb_build_object('reservado_em', to_jsonb(now()))))
  where p.id = v_pedido
    and p.tenant_id = p_tenant_id
    and p.metadados #> array['avisos', p_evento, 'enviado_em'] is null
    and coalesce((p.metadados #>> array['avisos', p_evento, 'reservado_em'])::timestamptz,
                 '-infinity'::timestamptz) < now() - make_interval(mins => v_janela);
  if not found then
    return;
  end if;

  select cv.contact_name, cv.phone into v_nome, v_fone
  from public.conversas cv
  where cv.tenant_id = p_tenant_id and cv.conversation_id = p_conversation_id;
  v_nome := public.contato_exibivel(v_nome);

  v_msg :=
      case p_evento
        when 'pagamento_confirmado' then format(E'✅ *Pagamento confirmado — pedido nº %s*\n', coalesce(v_numero::text, '?'))
        else format(E'❌ *Pedido nº %s cancelado*\n', coalesce(v_numero::text, '?'))
      end
    || case when coalesce(btrim(v_nome), '') <> '' then format(E'\n👤 %s', btrim(v_nome)) else '' end
    || case when coalesce(btrim(v_fone), '') <> ''
            then format(E'\n📱 %s%s', case when btrim(v_fone) ~ '^[0-9]+$' then '+' else '' end, btrim(v_fone))
            else '' end
    || format(E'\n\n💰 *Total: %s*', public.centavos_brl(coalesce(v_total, 0)))
    || case when v_modal = 'retirada' then E'\n📦 Retirada no local' else '' end
    || case when p_evento = 'pagamento_confirmado' and v_modo = 'na_retirada'
            then E'\n💳 Pago na retirada (marcado no painel)'
            when p_evento = 'pagamento_confirmado' then E'\n💳 Pago pelo link'
            else '' end;

  return query select v_pedido, v_numero, v_sessao, v_destino, v_nota, v_msg;
end;
$function$
;

alter table public.pedidos drop column if exists retirada_nome;

commit;
