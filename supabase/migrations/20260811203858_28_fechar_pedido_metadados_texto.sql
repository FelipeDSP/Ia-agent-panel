-- 28_fechar_pedido_metadados_texto
--
-- CONSERTO DE BUG EM PRODUCAO. Encontrado na primeira venda de ponta a ponta:
-- o fechamento falhava com `invalid input syntax for type json`.
--
-- O QUE ACONTECEU. `api_n8n_fechar_pedido` recebia `p_metadados jsonb`, e o
-- sub-workflow fazia `coalesce($3::jsonb, '{}'::jsonb)`. Mas o valor vem de
-- `$fromAI('metadados', ...)`, que devolve STRING — e quando o modelo nao tem
-- metadados para mandar, manda string VAZIA. `''::jsonb` nao e null: e um cast
-- invalido, que estoura antes de o coalesce ter chance de agir.
--
-- Execucao 3948825, parametros recebidos: ["<tenant>", 1864, ""].
--
-- POR QUE CONSERTAR NA FUNCAO E NAO SO NO WORKFLOW. Dava para resolver com um
-- `nullif` na query do n8n. Mas ai a proxima coisa que o modelo mandar fora do
-- formato — "retirada no balcao" em vez de {"entrega":"retirada"} — estoura de
-- novo, e o cliente ve "ocorreu um erro" no meio do pedido. A funcao e o lugar
-- onde a regra vale para qualquer chamador.
--
-- E o principio ja escrito na 26: ERRO E CONVERSA, NAO EXCECAO. Metadado
-- malformado nao pode derrubar um fechamento de pedido — ele e informacao
-- acessoria (endereco, retirada, observacao), nao o pedido em si.
--
-- COMPORTAMENTO NOVO, com p_metadados TEXT:
--   null ou vazio          -> {}
--   objeto JSON valido     -> usado como veio
--   JSON valido mas nao-objeto ("[1,2]", "\"x\"", "42")
--                          -> {"observacao": "<texto original>"}
--   texto qualquer         -> {"observacao": "<texto>"}
--
-- A ultima linha e a que importa na pratica: o modelo escrevendo em portugues
-- em vez de JSON vira uma observacao legivel no pedido, em vez de um erro.
--
-- A assinatura muda de (uuid, bigint, jsonb) para (uuid, bigint, text). A antiga
-- e removida para nao deixar duas versoes ambiguas — o Postgres escolheria por
-- tipo do argumento e o n8n manda string, o que resolveria para a nova de
-- qualquer forma, mas duas assinaturas vivas e armadilha para quem ler depois.
--
-- Rollback: 20260811203858_28_fechar_pedido_metadados_texto_rollback.sql

begin;

drop function if exists public.api_n8n_fechar_pedido(uuid, bigint, jsonb);

create or replace function public.api_n8n_fechar_pedido(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_metadados       text default null
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
  v_bruto  text := btrim(coalesce(p_metadados, ''));
  v_meta   jsonb;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  -- Normaliza o metadado ANTES de qualquer coisa: texto livre do modelo nunca
  -- deve chegar a um cast que possa estourar.
  if v_bruto = '' then
    v_meta := '{}'::jsonb;
  else
    begin
      v_meta := v_bruto::jsonb;
      -- JSON valido mas nao-objeto (array, numero, string solta) nao serve como
      -- metadado: o `||` da 26 exige objeto dos dois lados.
      if jsonb_typeof(v_meta) <> 'object' then
        v_meta := jsonb_build_object('observacao', v_bruto);
      end if;
    exception when others then
      -- O modelo escreveu em portugues em vez de JSON. Vira observacao.
      v_meta := jsonb_build_object('observacao', v_bruto);
    end;
  end if;

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

  select coalesce(max(p.numero), 0) + 1 into v_numero
  from public.pedidos p where p.tenant_id = p_tenant_id;

  update public.pedidos p
  set status    = 'aguardando_pagamento',
      numero    = v_numero,
      metadados = p.metadados || v_meta
  where p.id = v_pedido;

  return format(E'Pedido nº %s fechado.\n%s', v_numero, public.pedido_em_texto(v_pedido));
end;
$$;

comment on function public.api_n8n_fechar_pedido(uuid, bigint, text) is
  'Fecha o pedido em aberto. p_metadados e TEXT e nao jsonb: o valor vem do '
  '$fromAI, que manda string — inclusive vazia. Metadado malformado vira '
  '{"observacao": "<texto>"} em vez de derrubar o fechamento.';

revoke all on function public.api_n8n_fechar_pedido(uuid, bigint, text) from public;
revoke all on function public.api_n8n_fechar_pedido(uuid, bigint, text) from anon, authenticated;
grant execute on function public.api_n8n_fechar_pedido(uuid, bigint, text) to n8n_agent;

commit;
