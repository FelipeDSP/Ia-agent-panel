-- =====================================================================
-- Migração 82 — capacidade quando NÃO existe linha em usuarios_painel
-- =====================================================================
-- Achado ao rodar a suíte inteira logo depois de aplicar a 80, em 06/10/2026.
-- `teste:conversas-painel` ficou vermelho em 5 asserções: o tenant passou a
-- ver ZERO conversas.
--
-- A causa é uma lacuna da 80, não do teste. `auth_capacidades()` lia a linha de
-- `usuarios_painel` e, NÃO ACHANDO NENHUMA, devolvia `{}`. Mas "não achei
-- linha" e "a linha diz que não pode" são coisas diferentes:
--
--   - linha com `ativo = false`          -> acesso revogado. `{}` está certo.
--   - linha de `tenant_agente` sem função -> `{}` está certo.
--   - NENHUMA linha                       -> não é uma decisão sobre a pessoa.
--                                            É ausência de projeção.
--
-- O terceiro caso devolvia `{}` e, com isso, uma sessão legítima de
-- `tenant_admin` perdia a leitura de `conversas` em silêncio. Em produção
-- ninguém está nesse estado hoje (todo usuário vivo tem linha, posta pelo
-- trigger da 12), e foi por isso que a conferência pós-aplicação passou: ela
-- usou o admin REAL do Empório, que tem linha. A suíte, que forja claims sem
-- linha, é que encostou na lacuna — e teria sido um chamado de produção no dia
-- em que um usuário aparecesse sem projeção.
--
-- A CORREÇÃO: sem linha, vale o papel do JWT — que é a identidade emitida pelo
-- Auth. Com linha, a LINHA decide, inclusive para revogar. Assim a revogação
-- imediata (o motivo de a capacidade não morar no JWT) continua valendo para
-- todo mundo que existe de verdade.
--
-- `create or replace` de mesma assinatura: sem `drop`, os grants ficam.
--
-- Rollback: 20261006140000_82_capacidade_sem_projecao_rollback.sql
-- =====================================================================

begin;

create or replace function public.auth_capacidades()
returns text[]
language sql
stable
security definer
set search_path = public
as $fn$
  select case
    when public.auth_is_super_admin() then public.capacidades_conhecidas()
    else (
      select case
        -- Sem projeção: a identidade que existe é a do JWT. `tenant_agente`
        -- sem linha continua sem nada — ele só tem capacidade POR função, e
        -- função mora na linha.
        when u.id is null then
          case when nullif(public.jwt_claims() -> 'app_metadata' ->> 'papel', '') in ('super_admin', 'tenant_admin')
               then public.capacidades_conhecidas()
               else '{}'::text[] end
        -- Com projeção, a LINHA decide — é isto que faz revogar valer na hora.
        when not u.ativo then '{}'::text[]
        when u.papel in ('super_admin', 'tenant_admin') then public.capacidades_conhecidas()
        else coalesce(f.capacidades, '{}'::text[])
      end
      from (select 1) z
      left join public.usuarios_painel u on u.id = auth.uid()
      left join public.tenant_funcoes f on f.id = u.funcao_id
    )
  end;
$fn$;

commit;
