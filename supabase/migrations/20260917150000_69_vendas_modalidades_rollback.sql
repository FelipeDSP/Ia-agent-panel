-- =====================================================================
-- ROLLBACK da 69 — tira modalidade / pagamento na retirada / avisos
-- =====================================================================
-- O que se PERDE ao dropar as colunas: `pago_em`, `retirado_em` (datas que
-- só existem aqui) e `pagamento_modo`. Pedido fechado "na retirada" volta a
-- ser lido como link: passa a expirar em 24 h a partir do `atualizado_em` e a
-- travar o `resolver_conversa` — o status em si (`aguardando_pagamento` /
-- `pago`) NÃO muda, e dinheiro nenhum é tocado. Por isso NÃO aborta; o aviso
-- fica aqui para quem rodar saber o que está trocando.
--
-- Os quatro corpos abaixo são os anteriores à 69, verbatim
-- (`pg_get_functiondef` em 17/09/2026) — não reescritos de memória.
-- Extensão: nenhuma. REEXECUTÁVEL.
-- =====================================================================

begin;

drop function if exists public.painel_marcar_pedido(uuid, text);
drop function if exists public.api_agente_confirmar_aviso(uuid, uuid, text, boolean, text);
drop function if exists public.api_agente_aviso_pedido(uuid, bigint, text, uuid, integer);

-- ---- api_n8n_fechar_pedido(uuid,bigint,text): corpo anterior à 69, verbatim (pg_get_functiondef em 17/09/2026) ----
CREATE OR REPLACE FUNCTION public.api_n8n_fechar_pedido(p_tenant_id uuid, p_conversation_id bigint, p_metadados text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

-- ---- expirar_pedidos_vencidos(uuid,bigint): corpo anterior à 69, verbatim (pg_get_functiondef em 17/09/2026) ----
CREATE OR REPLACE FUNCTION public.expirar_pedidos_vencidos(p_tenant_id uuid, p_conversation_id bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

-- ---- api_n8n_tem_pedido_pendente(uuid,bigint): corpo anterior à 69, verbatim (pg_get_functiondef em 17/09/2026) ----
CREATE OR REPLACE FUNCTION public.api_n8n_tem_pedido_pendente(p_tenant_id uuid, p_conversation_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

-- ---- api_n8n_notificar_venda(uuid,bigint,integer): corpo anterior à 69, verbatim (pg_get_functiondef em 17/09/2026) ----
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
  v_pedido   uuid;
  v_numero   integer;
  v_total    integer;
  v_meta     jsonb;
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

  -- Config vazia nao e erro, e estado. Sai sem gastar o claim, para que
  -- preencher o numero amanha passe a valer da proxima venda.
  if coalesce(v_canal, 'nenhum') <> 'waha' or v_sessao = '' or v_destino = '' then
    return;
  end if;

  -- --- o pedido recem-fechado desta conversa ---
  -- `uq_pedidos_conversa_aberta` garante no maximo um aberto por conversa.
  select p.id, p.numero, p.total_centavos, p.metadados
    into v_pedido, v_numero, v_total, v_meta
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
    || case when v_entrega <> '' then format(E'\n\n📦 Entrega: %s', v_entrega) else '' end
    -- `observacao` nao estava na lista de campos pedida, e entra porque e
    -- instrucao do proprio cliente ("Retirada as 7h15" no pedido nº 2): perder
    -- isso e o dono separar o pedido na hora errada.
    || case when v_obs <> '' then format(E'\n📝 Obs.: %s', v_obs) else '' end;

  return query select v_pedido, v_numero, v_sessao, v_destino, v_msg;
end;
$function$
;


-- `vendas_oferta` só depois dos corpos antigos estarem no lugar: nenhum deles
-- a chama, mas a ordem deixa o arquivo reexecutável em qualquer ponto.
drop function if exists public.vendas_oferta(uuid);

alter table public.pedidos drop constraint if exists pedidos_modalidade_valida;
alter table public.pedidos drop constraint if exists pedidos_pagamento_modo_valido;
alter table public.pedidos
  drop column if exists modalidade,
  drop column if exists pagamento_modo,
  drop column if exists pago_em,
  drop column if exists retirado_em;

commit;
