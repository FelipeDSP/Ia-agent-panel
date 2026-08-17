-- Rollback de 40_ver_pedido_volatile
--
-- Devolve `api_n8n_ver_pedido` ao estado anterior: `stable`.
--
-- ATENCAO: voltar para `stable` REINTRODUZ o defeito — a funcao continua
-- escrevendo (via `pedido_aberto_da_conversa`, migracao 38) e volta a estourar
-- `25006 cannot execute UPDATE in a read-only transaction` quando chamada pelo
-- PostgREST. O n8n, que usa conexao direta, segue funcionando nos dois estados.
--
-- So role isto se a 40 tiver causado algum efeito inesperado; o estado "correto"
-- e o da 40.

drop function if exists public.api_n8n_ver_pedido(uuid, bigint);

create or replace function public.api_n8n_ver_pedido(
  p_tenant_id       uuid,
  p_conversation_id bigint
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_pedido uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  v_pedido := public.pedido_aberto_da_conversa(p_tenant_id, p_conversation_id);
  if v_pedido is null then
    return 'Nao ha pedido aberto nesta conversa.';
  end if;

  return public.pedido_em_texto(v_pedido);
end;
$$;

revoke all on function public.api_n8n_ver_pedido(uuid, bigint) from public;
revoke all on function public.api_n8n_ver_pedido(uuid, bigint) from anon;
revoke all on function public.api_n8n_ver_pedido(uuid, bigint) from authenticated;
grant execute on function public.api_n8n_ver_pedido(uuid, bigint) to service_role;
