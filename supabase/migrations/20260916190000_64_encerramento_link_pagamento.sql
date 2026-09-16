-- =====================================================================
-- 64. O encerramento do link de pagamento — o lado do banco
-- =====================================================================
--
-- Desenho: docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md §12, obrigado pela sonda B
-- (`POLITICA_EXPIRACAO = 'expirou_aceita'`: o Asaas NUNCA fecha o link) e
-- pela sonda D (desativar o link não fecha o Pix que o cliente já gerou; a
-- cobrança PENDING precisa ser removida — soft delete, restaurável).
--
-- O que entra:
--   - `pedido_cobrancas.encerrada_em` / `encerramento_detalhe`: quando o
--     encerramento rodou e o que o Asaas respondeu. Sem a coluna, a varredura
--     reprocessa a mesma cobrança a cada 5 minutos;
--   - `api_n8n_cobrancas_a_encerrar()` — SEM tenant, porque a varredura é
--     global (roda no serviço `agente/`, como `n8n_agent`). Devolve, por
--     cobrança vencida, a chave do TENANT dela — nunca chave global;
--   - `api_n8n_confirmar_encerramento(tenant, cobranca, ok, detalhe)` — grava
--     `encerrada_em` só quando os dois passos deram certo; falha fica em
--     `encerramento_detalhe` e a próxima varredura tenta de novo.
--
-- O encerramento escreve em `pedido_cobrancas`, NUNCA em `pedidos`: quem
-- escreve em `pedidos` mexe no relógio da expiração de pedido
-- (PENDENCIA-EXPIRACAO-PEDIDO.md). `expira_em` é a autoridade e não muda.
--
-- Grants: `revoke` ANTES do `grant`, os DOIS roles (`service_role` e
-- `n8n_agent`), pela lista de tipos. `teste:grants-n8n` as pega pelo prefixo.
-- Extensão: nenhuma. REEXECUTÁVEL. Rollback ao lado.
-- =====================================================================

begin;

alter table public.pedido_cobrancas
  add column if not exists encerrada_em         timestamptz,
  add column if not exists encerramento_detalhe text;

comment on column public.pedido_cobrancas.encerrada_em is
  'Quando o link foi desativado E as cobrancas PENDING dele removidas no Asaas (64). '
  'Nulo = ainda pagavel (ou nunca venceu). Nao toca em pedidos.status.';

-- A varredura lê "vencidas, vivas, não pagas, não encerradas".
create index if not exists idx_pedido_cobrancas_a_encerrar
  on public.pedido_cobrancas (expira_em)
  where url is not null and pago_em is null and falhou_em is null and encerrada_em is null;

-- ---------------------------------------------------------------------
-- api_n8n_cobrancas_a_encerrar — global, uma linha por cobrança vencida
-- ---------------------------------------------------------------------
-- Cobrança cujo link já venceu (`expira_em < now()`), com URL (o Asaas
-- respondeu), não paga, não falhada e ainda não encerrada. A chave e a base
-- vêm de `api_n8n_credencial_asaas` do tenant DA cobrança — se o tenant
-- trocou de ambiente depois, a cobrança carrega `ambiente` e a linha só sai
-- quando o ambiente ativo bate: chave de produção não fecha link de sandbox.
--
-- `p_limite` põe teto por passada; a varredura roda a cada 5 min.
drop function if exists public.api_n8n_cobrancas_a_encerrar(integer);
create or replace function public.api_n8n_cobrancas_a_encerrar(p_limite integer default 50)
returns table(tenant_id uuid, cobranca_id uuid, link_id text, ambiente text, base_url text, api_key text,
              expira_em timestamptz, tentativas_detalhe text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  return query
  select c.tenant_id, c.id, c.link_id, c.ambiente, cred.base_url, cred.api_key, c.expira_em, c.encerramento_detalhe
    from public.pedido_cobrancas c
    -- `t.ativo`: `api_n8n_credencial_asaas` chama `n8n_assert_tenant`, que ESTOURA para
    -- tenant inativo — um tenant desligado abortaria a varredura de todos.
    join public.tenants t on t.id = c.tenant_id and t.deletado_em is null and t.ativo
    cross join lateral public.api_n8n_credencial_asaas(c.tenant_id) cred
   where c.url is not null and c.link_id is not null
     and c.pago_em is null and c.falhou_em is null and c.encerrada_em is null
     and c.expira_em < now()
     and cred.ambiente = c.ambiente
     and coalesce(btrim(cred.api_key), '') <> ''
   order by c.expira_em
   limit greatest(coalesce(p_limite, 50), 1);
end;
$function$;

-- ---------------------------------------------------------------------
-- api_n8n_confirmar_encerramento — grava o resultado dos dois passos
-- ---------------------------------------------------------------------
-- `p_ok = true`: `encerrada_em = now()`; a linha sai da varredura.
-- `p_ok = false`: só `encerramento_detalhe` (o que o Asaas respondeu); a
-- linha continua na varredura e a próxima passada tenta de novo. Uma
-- cobrança já encerrada ou já paga devolve `false` sem erro — o webhook do
-- pagamento pode ter chegado entre a varredura e a confirmação, e nesse caso
-- vence o pagamento (é dinheiro que entrou; o "fora do prazo" é da 61).
drop function if exists public.api_n8n_confirmar_encerramento(uuid, uuid, boolean, text);
create or replace function public.api_n8n_confirmar_encerramento(
  p_tenant_id uuid, p_cobranca_id uuid, p_ok boolean, p_detalhe text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  if p_ok then
    update public.pedido_cobrancas c
       set encerrada_em = now(), encerramento_detalhe = left(p_detalhe, 500), atualizado_em = now()
     where c.id = p_cobranca_id and c.tenant_id = p_tenant_id
       and c.encerrada_em is null and c.pago_em is null;
  else
    update public.pedido_cobrancas c
       set encerramento_detalhe = left(coalesce(p_detalhe, 'falhou'), 500), atualizado_em = now()
     where c.id = p_cobranca_id and c.tenant_id = p_tenant_id
       and c.encerrada_em is null and c.pago_em is null;
  end if;
  return found;
end;
$function$;

-- =====================================================================
-- GRANTS — revoke ANTES do grant, os DOIS roles, pela lista de tipos
-- =====================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.api_n8n_cobrancas_a_encerrar(integer)',
    'public.api_n8n_confirmar_encerramento(uuid, uuid, boolean, text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
    execute format('grant execute on function %s to n8n_agent', f);
  end loop;
end $$;

commit;
