-- =============================================================================
-- 88 — O TENANT PELO ID, para o ensaio
-- =============================================================================
--
-- O `POST /testar` (14/10) roda o turno de verdade sem efeito colateral, e
-- precisa carregar o tenant. As duas funções que existem resolvem por Chatwoot
-- (`api_n8n_tenant_por_chatwoot`, `api_agente_tenant_por_conta`) — e isso não
-- serve aqui por dois motivos:
--
--   1. quem chama é o PAINEL, que conhece o tenant pelo id do JWT. Pedir a ele
--      a conta do Chatwoot seria obrigá-lo a saber de uma coisa que não é dele;
--   2. testar uma conta que ainda NÃO foi conectada é um dos casos mais úteis.
--      O Fortalize está assim hoje: existe, tem prompt e módulos, e não tem
--      Chatwoot. Resolver por conta o deixaria de fora justo na hora em que o
--      teste mais valeria — antes de ligar para o cliente.
--
-- Mesmas colunas das irmãs, de propósito: o serviço tipa `Tenant` uma vez só, e
-- `teste:migracao-tenant-por-conta` já guarda essa igualdade entre a 54 e a 87.
--
-- NÃO filtra `ativo`. A 54 e a 87 filtram porque decidem se o agente ATENDE; o
-- ensaio decide se o agente RESPONDERIA, e numa conta desligada essa é
-- exatamente a pergunta de quem está configurando antes de ligar. Quem decide
-- atender continua sendo a 87, intocada.
--
-- ROLLBACK: ao final do arquivo.
-- =============================================================================

drop function if exists public.api_agente_tenant_por_id(uuid);

create or replace function public.api_agente_tenant_por_id(p_tenant_id uuid)
returns table(
  tenant_id                uuid,
  slug                     text,
  nome                     text,
  agente_ativo             boolean,
  system_prompt            text,
  modelo                   text,
  temperatura              numeric,
  debounce_segundos        integer,
  msg_midia_nao_suportada  text,
  msg_fora_escopo          text,
  chatwoot_url             text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if p_tenant_id is null then
    raise exception 'api_agente: p_tenant_id e obrigatorio' using errcode = '22023';
  end if;

  return query
    select t.id, t.slug, t.nome, t.agente_ativo, t.system_prompt, t.modelo,
           t.temperatura, t.debounce_segundos, t.msg_midia_nao_suportada,
           t.msg_fora_escopo, t.chatwoot_url
      from public.tenants t
     where t.id = p_tenant_id
       and t.deletado_em is null;
end;
$$;

comment on function public.api_agente_tenant_por_id(uuid) is
  '88: o tenant pelo id, para o ensaio (POST /testar). Nao filtra `ativo` — o ensaio responde "o que o agente DIRIA", '
  'e conta desligada ou ainda sem Chatwoot e justamente quem mais precisa testar antes de ligar. Quem decide se o '
  'agente ATENDE continua sendo api_agente_tenant_por_conta (87).';

-- ---- grants ----------------------------------------------------------------
-- `revoke` antes do `grant`: objeto novo nasce com EXECUTE para PUBLIC, `anon`
-- e `authenticated` pelas ALTER DEFAULT PRIVILEGES deste projeto.
revoke all on function public.api_agente_tenant_por_id(uuid) from public;
revoke all on function public.api_agente_tenant_por_id(uuid) from anon;
revoke all on function public.api_agente_tenant_por_id(uuid) from authenticated;

grant execute on function public.api_agente_tenant_por_id(uuid) to service_role;
grant execute on function public.api_agente_tenant_por_id(uuid) to n8n_agent;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- drop function if exists public.api_agente_tenant_por_id(uuid);
-- =============================================================================
