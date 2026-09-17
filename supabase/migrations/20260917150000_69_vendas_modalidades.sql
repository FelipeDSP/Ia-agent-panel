-- =====================================================================
-- 69 — Vendas: modalidade (retirada), pagamento na retirada, aviso ao dono
-- =====================================================================
-- Desenho: docs/DESENHO-VENDAS-MODALIDADES.md (decisões do Felipe, 17/09).
--
-- O que muda, e por quê:
--
--   * `pedidos` ganha `modalidade`, `pagamento_modo`, `pago_em`, `retirado_em`.
--     Hoje "retirada"/"entrega" vive como texto solto em `metadados` — o painel
--     não filtra por isso e o agente não é obrigado a informar. Vira coluna.
--     Linha antiga fica NULL, e NULL em `pagamento_modo` é lido como 'link' em
--     todo lugar: é exatamente o comportamento que ela tinha.
--
--   * `api_n8n_fechar_pedido` (MESMA assinatura — o n8n congelado a chama)
--     passa a ler chaves novas do jsonb que já recebia: `pagamento`
--     ('link' | 'na_retirada') e `modalidade`. Valida contra o que o tenant
--     oferece em `tenant_tools.config` da tool `vendas`:
--       pagamentos: ["link", "na_retirada"]   (ausente = ["link"], que é hoje)
--       entrega:    "atendente" | "nao"        (ausente = "nao")
--     Oferece um só → usa esse sem perguntar. Oferece os dois e o modelo não
--     disse → NÃO fecha e manda perguntar. Pediu o que não é oferecido → NÃO
--     fecha e diz o que há. Pediu entrega → NÃO fecha e manda transferir ou
--     diz que só há retirada. "NADA FOI FECHADO" continua sendo a primeira
--     palavra em toda recusa — é o que o portão e o modelo já conhecem.
--
--   * Pagar na retirada NÃO expira em 24 h nem trava o encerramento:
--     `expirar_pedidos_vencidos` e `api_n8n_tem_pedido_pendente` só contam
--     `pagamento_modo = 'link'`. O status continua 'aguardando_pagamento'
--     (é verdade: falta pagar), então nenhuma outra função muda de filtro.
--
--   * `api_n8n_notificar_venda` (mesma assinatura) escreve a modalidade e a
--     forma de pagar no aviso, e respeita `config.eventos` (ausente = todos).
--     Com `notificacao.nota_chatwoot` e sem WhatsApp, devolve a linha com
--     `sessao`/`destino` NULOS — o serviço posta só a nota; o n8n congelado
--     (que testa "tem destino") ignora a linha, e o claim expira em 5 min.
--
--   * NOVAS: `api_agente_aviso_pedido` / `api_agente_confirmar_aviso` — o
--     aviso ao dono para os OUTROS eventos (`pagamento_confirmado`,
--     `pedido_cancelado`), com o mesmo claim idempotente da venda fechada,
--     por evento. Só o serviço chama (n8n_agent/service_role).
--
--   * NOVA: `painel_marcar_pedido(p_pedido_id, p_acao)` — o usuário da conta
--     marca 'pago' / 'retirado' em Pedidos. Tenant vem do JWT
--     (`auth_tenant_id()`), nunca do argumento. Marcar pago também encerra
--     no banco as cobranças abertas daquele pedido, para a varredura de
--     encerramento não mandar "link expirou" a quem já pagou no balcão.
--
-- Extensão: nenhuma. Sem drop de função viva (só `create or replace` de
-- mesma assinatura — ACL preservado; o teste confere por diff). REEXECUTÁVEL.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Colunas
-- ---------------------------------------------------------------------
alter table public.pedidos
  add column if not exists modalidade     text,
  add column if not exists pagamento_modo text,
  add column if not exists pago_em        timestamptz,
  add column if not exists retirado_em    timestamptz;

-- `entrega` entra no CHECK para a gaveta abrir sem migração de estrutura; o
-- validador do painel e o `fechar` recusam até existir de verdade.
alter table public.pedidos drop constraint if exists pedidos_modalidade_valida;
alter table public.pedidos add constraint pedidos_modalidade_valida
  check (modalidade is null or modalidade in ('retirada', 'entrega'));

alter table public.pedidos drop constraint if exists pedidos_pagamento_modo_valido;
alter table public.pedidos add constraint pedidos_pagamento_modo_valido
  check (pagamento_modo is null or pagamento_modo in ('link', 'na_retirada'));

comment on column public.pedidos.modalidade is
  '69: retirada | entrega. NULL = pedido anterior à 69 (texto solto em metadados.entrega).';
comment on column public.pedidos.pagamento_modo is
  '69: link (24 h para pagar, cobrança pelo agente) | na_retirada (sem prazo; o dono marca pago no painel). NULL lê-se como link.';
comment on column public.pedidos.pago_em is
  '69: quando ficou pago — webhook do Asaas ou painel_marcar_pedido.';
comment on column public.pedidos.retirado_em is
  '69: quando o cliente retirou — painel_marcar_pedido.';

-- ---------------------------------------------------------------------
-- 2. O que o tenant oferece (helper interno, sem grant — só as SECURITY
--    DEFINER daqui a chamam)
-- ---------------------------------------------------------------------
create or replace function public.vendas_oferta(p_tenant_id uuid)
returns table(pagamentos text[], entrega text, eventos text[], nota_chatwoot boolean)
language sql
stable
security definer
set search_path = public
as $function$
  select
    -- ausente/vazio/inválido = ['link'] (o comportamento de antes da 69)
    coalesce(
      nullif(array(
        select distinct x
          from jsonb_array_elements_text(
                 case when jsonb_typeof(tt.config -> 'pagamentos') = 'array'
                      then tt.config -> 'pagamentos' else '[]'::jsonb end) x
         where x in ('link', 'na_retirada')),
        '{}'::text[]),
      array['link']),
    case when tt.config ->> 'entrega' = 'atendente' then 'atendente' else 'nao' end,
    -- ausente = todos os eventos
    coalesce(
      nullif(array(
        select distinct x
          from jsonb_array_elements_text(
                 case when jsonb_typeof(tt.config -> 'eventos') = 'array'
                      then tt.config -> 'eventos' else '[]'::jsonb end) x
         where x in ('pedido_fechado', 'pagamento_confirmado', 'pedido_cancelado')),
        '{}'::text[]),
      array['pedido_fechado', 'pagamento_confirmado', 'pedido_cancelado']),
    coalesce((tt.config #>> '{notificacao,nota_chatwoot}')::boolean, false)
  from public.tenant_tools tt
  where tt.tenant_id = p_tenant_id
    and tt.tool_nome = 'vendas';
$function$;

-- ---------------------------------------------------------------------
-- 3. fechar_pedido — mesma assinatura, chaves novas no jsonb
-- ---------------------------------------------------------------------
create or replace function public.api_n8n_fechar_pedido(
  p_tenant_id uuid, p_conversation_id bigint, p_metadados text default null)
returns text
language plpgsql
security definer
set search_path = public
as $function$
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
$function$;

-- ---------------------------------------------------------------------
-- 4. Prazo de 24 h e "pedido pendente": só para quem paga por link
-- ---------------------------------------------------------------------
create or replace function public.expirar_pedidos_vencidos(p_tenant_id uuid, p_conversation_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $function$
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
     -- 69: pagar na retirada nao tem prazo — quem fecha e o dono, no painel
     and coalesce(p.pagamento_modo, 'link') = 'link'
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
$function$;

create or replace function public.api_n8n_tem_pedido_pendente(p_tenant_id uuid, p_conversation_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
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
        -- venda fechada e nao paga conta SEMPRE — quando o pagamento e pelo
        -- agente. 69: na retirada nao ha o que esperar nesta conversa; quem
        -- fecha o ciclo e o dono, no painel
        (p.status = 'aguardando_pagamento' and coalesce(p.pagamento_modo, 'link') = 'link')
        -- carrinho conta so se tiver item, igual a antes
        or (p.status = 'rascunho'
            and exists (select 1 from public.pedido_itens i where i.pedido_id = p.id))
      )
  );
end;
$function$;

-- ---------------------------------------------------------------------
-- 5. notificar_venda — mesma assinatura; texto com modalidade e pagamento;
--    respeita `eventos`
-- ---------------------------------------------------------------------
create or replace function public.api_n8n_notificar_venda(
  p_tenant_id uuid, p_conversation_id bigint, p_reclaim_minutos integer default 5)
returns table(pedido_id uuid, numero integer, sessao text, destino text, mensagem text)
language plpgsql
security definer
set search_path = public
as $function$
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
  if coalesce(v_canal, 'nenhum') <> 'waha' or v_sessao = '' or v_destino = '' then
    if not v_nota then
      return;
    end if;
    v_sessao := null; v_destino := null;
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
$function$;

-- ---------------------------------------------------------------------
-- 6. Aviso ao dono para os outros eventos (só o serviço chama)
-- ---------------------------------------------------------------------
-- `p_pedido_id` nulo: pega o pedido mais recente da conversa no status do
-- evento (pago / cancelado). O claim e por evento, em
-- `metadados.avisos.<evento>.{reservado_em, enviado_em, falhou_em}` — chave
-- separada da `notificacao` da venda fechada, que o n8n congelado ainda usa.
create or replace function public.api_agente_aviso_pedido(
  p_tenant_id uuid, p_conversation_id bigint, p_evento text,
  p_pedido_id uuid default null, p_reclaim_minutos integer default 5)
returns table(pedido_id uuid, numero integer, sessao text, destino text,
              nota_chatwoot boolean, mensagem text)
language plpgsql
security definer
set search_path = public
as $function$
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
  -- sem WhatsApp configurado, a nota no Chatwoot ainda pode ir sozinha
  if (coalesce(v_canal, 'nenhum') <> 'waha' or v_sessao = '' or v_destino = '')
     and not v_nota then
    return;
  end if;
  if coalesce(v_canal, 'nenhum') <> 'waha' or v_sessao = '' or v_destino = '' then
    v_sessao := null; v_destino := null;
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
$function$;

create or replace function public.api_agente_confirmar_aviso(
  p_tenant_id uuid, p_pedido_id uuid, p_evento text, p_ok boolean, p_detalhe text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_novo  jsonb;
  v_tirar text[];
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  if p_pedido_id is null or p_evento is null then
    return false;
  end if;
  if coalesce(p_ok, false) then
    v_novo  := jsonb_build_object('enviado_em', to_jsonb(now()));
    v_tirar := array['falhou_em', 'detalhe'];
  else
    v_novo  := jsonb_build_object('falhou_em', to_jsonb(now()),
                                  'detalhe', left(coalesce(p_detalhe, ''), 500));
    v_tirar := array['enviado_em'];
  end if;
  update public.pedidos p
  set metadados = p.metadados
                || jsonb_build_object('avisos',
                     coalesce(p.metadados -> 'avisos', '{}'::jsonb)
                     || jsonb_build_object(p_evento,
                          (coalesce(p.metadados -> 'avisos' -> p_evento, '{}'::jsonb) - v_tirar) || v_novo))
  where p.id = p_pedido_id
    and p.tenant_id = p_tenant_id;
  return found;
end;
$function$;

-- ---------------------------------------------------------------------
-- 7. O painel marca pago / retirado — tenant do JWT
-- ---------------------------------------------------------------------
-- Devolve o status resultante e as datas. Recusa com mensagem quando a
-- transição não vale (marcar retirado sem estar pago; pagar o que não está
-- aguardando). Sem argumento de tenant: `auth_tenant_id()` decide, e
-- super_admin passa (a agência olha o pedido do cliente pela tela dele).
create or replace function public.painel_marcar_pedido(p_pedido_id uuid, p_acao text)
returns table(ok boolean, motivo text, status text, pago_em timestamptz, retirado_em timestamptz)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_p record;
begin
  if p_acao not in ('pago', 'retirado') then
    return query select false, 'acao_invalida', null::text, null::timestamptz, null::timestamptz;
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
           -- quem paga na retirada esta retirando: os dois de uma vez
           retirado_em = case when coalesce(p.pagamento_modo, 'link') = 'na_retirada'
                              then now() else p.retirado_em end,
           atualizado_em = now()
     where p.id = v_p.id;
    -- cobrancas abertas deste pedido deixam de ser "a encerrar": o dono
    -- recebeu no balcao, o cliente nao pode ouvir que o link expirou
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
$function$;

-- ---------------------------------------------------------------------
-- 8. GRANTS — revoke ANTES do grant, pela lista de tipos
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  -- só o serviço (e o n8n congelado, por herança do role)
  foreach f in array array[
    'public.api_agente_aviso_pedido(uuid, bigint, text, uuid, integer)',
    'public.api_agente_confirmar_aviso(uuid, uuid, text, boolean, text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
    execute format('grant execute on function %s to n8n_agent', f);
  end loop;

  -- helper interno, na forma das irmãs (pedido_em_texto): postgres + service_role
  f := 'public.vendas_oferta(uuid)';
  execute format('revoke all on function %s from public', f);
  execute format('revoke all on function %s from anon', f);
  execute format('revoke all on function %s from authenticated', f);
  execute format('grant execute on function %s to service_role', f);

  -- o painel: authenticated (tenant do JWT) e service_role, como conversa_historico
  f := 'public.painel_marcar_pedido(uuid, text)';
  execute format('revoke all on function %s from public', f);
  execute format('revoke all on function %s from anon', f);
  execute format('grant execute on function %s to authenticated', f);
  execute format('grant execute on function %s to service_role', f);
end $$;

commit;
