-- =====================================================================
-- Rollback da migração 82 — volta `auth_capacidades()` à forma da 80
-- =====================================================================
-- Sempre replayável: é só o corpo de uma função, sem estado.
--
-- Mas note o que voltar significa: sessão sem linha em `usuarios_painel`
-- volta a receber `{}`, e com isso um `tenant_admin` sem projeção perde a
-- leitura de `conversas` em silêncio. Era o defeito que a 82 consertou.
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
    else coalesce(
      (select case
                when u.papel in ('super_admin','tenant_admin') then public.capacidades_conhecidas()
                else coalesce(f.capacidades, '{}'::text[])
              end
         from public.usuarios_painel u
         left join public.tenant_funcoes f on f.id = u.funcao_id
        where u.id = auth.uid() and u.ativo),
      '{}'::text[])
  end;
$fn$;

commit;
