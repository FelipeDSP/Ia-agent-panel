-- =====================================================================
-- 52. Notificacao de venda: o dono e avisado quando um pedido fecha
-- =====================================================================
--
-- POR QUE DUAS FUNCOES NOVAS, E NAO UMA MUDANCA EM `fechar_pedido`
--
-- `api_n8n_fechar_pedido` e idempotente NA ESCRITA (a segunda chamada nao
-- duplica pedido), mas o retorno dela NAO distingue "fechei agora" de "ja
-- estava fechado" -- so o texto muda, e texto e destinado ao modelo, nao a um
-- parser. Se o n8n notificasse toda vez que a tool retorna, uma re-chamada
-- mandaria DOIS WhatsApps do mesmo pedido ao dono. E o modelo re-chama tool
-- quando acha que falhou: foi exatamente isso que produziu o pedido de R$ 75,00
-- (ver docs/PENDENCIA-CARRINHO-MULTI-ITEM.md secao 2b).
--
-- Ensinar `fechar_pedido` a devolver `fechou_agora` custaria mudanca de
-- assinatura -- `drop function`, aridade ambigua, grants apagados: a familia
-- 28/32/37/40/41 inteira, por um booleano. Funcao NOVA nao tem nada disso.
--
-- E, mais importante: a idempotencia fica NO BANCO, e nao na confianca de o n8n
-- chamar uma vez so.
--
-- ---------------------------------------------------------------------
-- O CLAIM E A ENTREGA SAO COISAS DIFERENTES, DE PROPOSITO
--
-- `api_n8n_notificar_venda` RESERVA a notificacao (grava `reservado_em`) e
-- devolve o texto pronto. Ela nao sabe nem promete que a mensagem chegou.
-- `api_n8n_confirmar_notificacao` e que grava `enviado_em` ou `falhou_em`,
-- depois que o WAHA respondeu.
--
-- A consequencia e a que interessa: **so `enviado_em` conta como notificado**.
-- Se o n8n morrer entre reservar e confirmar, a linha fica com `reservado_em`
-- sozinho, que e um estado visivel e distinto -- nao vira "notificado" por
-- omissao. O claim serve para nao duplicar, nunca para afirmar entrega.
--
-- E ha caminho de volta sem cron: passados `p_reclaim_minutos` (default 5, com
-- piso de 1) sem `enviado_em`, a reserva pode ser retomada. Uma reserva presa e
-- uma falha do WAHA sao, as duas, re-notificaveis; um envio bem-sucedido nao e.
--
-- ---------------------------------------------------------------------
-- ONDE MORA A CONFIGURACAO
--
-- `tenant_tools.config` da tool `vendas`, mesma forma do `transferir_humano`:
--
--   { "notificacao": { "canal": "waha", "sessao": "<sessao waha>",
--                      "destino": "55DDNNNNNNNNN@c.us" } }
--
-- O corte e o mesmo ja estabelecido: o CLIENTE edita `canal` e `destino`
-- (quem recebe), a AGENCIA edita `sessao` (infra). O destino e PROPRIO e nao
-- herda do `transferir_humano`: num emporio quem separa o pedido nao e
-- necessariamente quem atende o WhatsApp, e herdar por fallback implicito seria
-- acoplamento escondido entre duas tools.
--
-- CONSEQUENCIA ACEITA DE OLHO ABERTO: hoje os quatro tenants estao com
-- `vendas.config = {}`. **Enquanto ninguem preencher, nenhuma venda e
-- notificada** -- a funcao devolve zero linhas e NAO gasta o claim, entao
-- preencher depois passa a valer da proxima venda em diante. A tela precisa
-- dizer isso como ESTADO ("nenhum numero configurado; vendas nao serao
-- notificadas"), nao como erro.
--
-- ---------------------------------------------------------------------
-- UM EFEITO COLATERAL CONHECIDO, MEDIDO E ACEITO
--
-- O claim escreve em `public.pedidos`, e `trg_pedidos_upd` reescreve
-- `atualizado_em` -- que e justamente a coluna que `expirar_pedidos_vencidos`
-- le como "ha quanto tempo o cliente nao paga" (defeito 1 de
-- docs/PENDENCIA-EXPIRACAO-PEDIDO.md). Ou seja: notificar da 24 h novas ao
-- pedido.
--
-- Na pratica o desvio e de segundos: o claim roda logo depois do
-- `fechar_pedido`, que acabou de escrever a mesma linha. O teste mede o desvio
-- e reprova se ele passar de 5 s. A cura de verdade e a coluna propria
-- (`aguardando_desde`), que continua fora deste escopo.
--
-- SEGURANCA
--   - as duas sao SECURITY DEFINER e comecam por `n8n_assert_tenant`;
--   - todo `where` filtra `tenant_id` explicitamente (regra 6);
--   - grants nos DOIS roles: `service_role` (PostgREST) e `n8n_agent` (o role
--     com que o n8n conecta, e o que faltou nas migracoes 40 e 41).
--
-- ROLLBACK: 20260824120000_52_notificar_venda_rollback.sql
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. O nome que da para mostrar, ou nada
-- ---------------------------------------------------------------------
-- `contact_name` as vezes vem do Chatwoot como JID do WhatsApp
-- (`551123913685@c.us`) e nao como nome: 1 das 25 conversas do emporio esta
-- assim hoje. Nesse caso a linha do nome CAI -- nao vira substituicao. Repetir o
-- numero, um deles ilegivel, e ruido; o telefone tem linha propria e sai do
-- campo `phone`, que e a fonte certa.
--
-- Funcao propria e nao `if` embutido porque a migracao 53 (pausa por anomalia)
-- monta outra mensagem para o mesmo dono, com o mesmo problema. Regra em dois
-- lugares vira duas regras na primeira vez que alguem ajustar uma.
create or replace function public.contato_exibivel(p_nome text)
returns text
language sql
immutable
as $$
  select case
    when btrim(coalesce(p_nome, '')) = ''                then null
    when btrim(p_nome) ~ '^\+?[0-9]{6,}@'                then null
    else btrim(p_nome)
  end;
$$;

-- ---------------------------------------------------------------------
-- 1. Reserva a notificacao e devolve o texto pronto
-- ---------------------------------------------------------------------
-- Devolve ZERO LINHAS quando nao ha o que notificar: tool desligada, canal
-- diferente de waha, destino/sessao em branco, nenhum pedido recem-fechado, ou
-- notificacao ja reservada/enviada. O no do n8n simplesmente nao dispara.
create or replace function public.api_n8n_notificar_venda(
  p_tenant_id        uuid,
  p_conversation_id  bigint,
  p_reclaim_minutos  integer default 5
)
returns table (
  pedido_id  uuid,
  numero     integer,
  sessao     text,
  destino    text,
  mensagem   text
)
language plpgsql
security definer
set search_path to 'public'
as $$
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
$$;

-- ---------------------------------------------------------------------
-- 2. Confirma (ou nao) a entrega
-- ---------------------------------------------------------------------
-- Sucesso grava `enviado_em` e limpa `falhou_em`; falha grava `falhou_em` mais
-- o detalhe e limpa `enviado_em`. Assim "notificado" tem UMA leitura possivel,
-- em vez de duas chaves que podem se contradizer.
create or replace function public.api_n8n_confirmar_notificacao(
  p_tenant_id  uuid,
  p_pedido_id  uuid,
  p_ok         boolean,
  p_detalhe    text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_novo  jsonb;
  v_tirar text[];
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_pedido_id is null then
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
                || jsonb_build_object(
                     'notificacao',
                     (coalesce(p.metadados -> 'notificacao', '{}'::jsonb) - v_tirar) || v_novo
                   )
  where p.id        = p_pedido_id
    and p.tenant_id = p_tenant_id;

  return found;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. REVOKE antes do grant, e depois os DOIS roles
-- ---------------------------------------------------------------------
-- O `revoke` NAO e decoracao. Funcao nova nasce com EXECUTE para PUBLIC (padrao
-- do Postgres) e, neste projeto, com EXECUTE para `anon` e `authenticated`
-- tambem (o `ALTER DEFAULT PRIVILEGES` que ja mordeu na 51, do lado das views).
-- Medido nesta propria migracao: sem estas tres linhas o ACL saiu
-- `{=X/postgres, anon=X, authenticated=X, service_role=X, n8n_agent=X}` -- ou
-- seja, a chave anonima do navegador executando uma SECURITY DEFINER que
-- devolve nome, telefone e itens do cliente. Foi assim que a migracao 43
-- encontrou SETE funcoes expostas: nenhuma tinha `anon=` proprio, todas
-- passavam por PUBLIC.
--
-- As 19 `api_n8n_*` de producao tem exatamente `{postgres, service_role,
-- n8n_agent}`. Estas duas ficam iguais -- conferido por DIFF contra as irmas, e
-- nao contra a lista que eu esperava, que foi o erro da verificacao da 41.
revoke all on function public.api_n8n_notificar_venda(uuid, bigint, integer)
  from public, anon, authenticated;
revoke all on function public.api_n8n_confirmar_notificacao(uuid, uuid, boolean, text)
  from public, anon, authenticated;

-- `service_role` e o role do PostgREST/supabase-js. O n8n NAO passa por ali:
-- ele conecta como `n8n_agent`, e essa e a linha que o agente usa em toda
-- venda. Foi a que faltou nas migracoes 40 e 41 e derrubou o catalogo do
-- emporio. `npm run teste:grants-n8n` varre `api_n8n_*` por padrao, entao estas
-- duas entram na vigilancia sozinhas.
grant execute on function public.api_n8n_notificar_venda(uuid, bigint, integer) to service_role;
grant execute on function public.api_n8n_notificar_venda(uuid, bigint, integer) to n8n_agent;
grant execute on function public.api_n8n_confirmar_notificacao(uuid, uuid, boolean, text) to service_role;
grant execute on function public.api_n8n_confirmar_notificacao(uuid, uuid, boolean, text) to n8n_agent;

comment on function public.api_n8n_notificar_venda(uuid, bigint, integer) is
  'Reserva a notificacao de uma venda recem-fechada e devolve o texto pronto. '
  'Zero linhas = nao ha o que notificar (tool off, config vazia, sem pedido, ou ja reservada/enviada). '
  'Reservar NAO afirma entrega: so `metadados.notificacao.enviado_em` conta como notificado.';

comment on function public.api_n8n_confirmar_notificacao(uuid, uuid, boolean, text) is
  'Grava o desfecho do envio em pedidos.metadados.notificacao: enviado_em ou falhou_em+detalhe.';

commit;
