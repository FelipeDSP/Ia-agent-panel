-- Rollback de 41_buscar_produtos_total
--
-- Devolve `api_n8n_buscar_produtos` ao formato da migracao 26: `setof` de
-- produtos, `limit 10`, sem total.
--
-- ATENCAO — ROLLBACK EXIGE REIMPORTAR O SUB-WORKFLOW. A query do no
-- "Busca Produtos" em `Tool - Consultar Catalogo (Multi-Tenant)` passa a ser
--
--     SELECT texto AS resultado FROM public.api_n8n_buscar_produtos(...)
--
-- e a versao antiga NAO TEM a coluna `texto`. Rolar so o banco quebra a tool de
-- catalogo em runtime, no primeiro cliente, com "column texto does not exist".
-- A ordem correta e: reimportar o workflow anterior no n8n E DEPOIS rodar isto.
--
-- Com a tool quebrada, o agente perde catalogo, e sem catalogo ele nao tem
-- produto_id — o que derruba junto gerenciar_pedido e enviar_foto_produto.
--
-- O drop tambem e obrigatorio aqui, e pelo mesmo motivo da ida: o tipo de
-- retorno muda.

drop function if exists public.api_n8n_buscar_produtos(uuid, text);

create or replace function public.api_n8n_buscar_produtos(
  p_tenant_id uuid,
  p_termo     text
)
returns table (
  produto_id     uuid,
  nome           text,
  preco_centavos integer,
  preco          text,
  unidade        text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_termo text := btrim(coalesce(p_termo, ''));
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  return query
  select p.id, p.nome, p.preco_centavos, public.centavos_brl(p.preco_centavos), p.unidade
  from public.produtos p
  where p.tenant_id = p_tenant_id
    and p.deletado_em is null
    and p.disponivel
    and (p.estoque is null or p.estoque > 0)
    and (
      v_termo = ''
      or p.nome ilike '%' || v_termo || '%'
      or to_tsvector('portuguese', p.nome || ' ' || coalesce(p.descricao, ''))
         @@ plainto_tsquery('portuguese', v_termo)
    )
  order by
    (p.nome ilike '%' || v_termo || '%') desc,
    p.nome
  limit 10;
end;
$$;

revoke all on function public.api_n8n_buscar_produtos(uuid, text) from public;
revoke all on function public.api_n8n_buscar_produtos(uuid, text) from anon;
revoke all on function public.api_n8n_buscar_produtos(uuid, text) from authenticated;
grant execute on function public.api_n8n_buscar_produtos(uuid, text) to service_role;
