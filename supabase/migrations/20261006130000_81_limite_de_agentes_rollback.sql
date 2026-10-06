-- =====================================================================
-- Rollback da migração 81 — limite de agentes por conta
-- =====================================================================
-- Este rollback é SEMPRE replayável, e vale dizer por quê: a 81 RESTRINGE (põe
-- um teto), não amplia. Tirar o teto não esbarra em nenhum estado criado
-- legalmente depois dela — ao contrário da 80, cujo rollback aborta porque o
-- estado novo é gente.
--
-- Perde-se o valor de `max_agentes` de cada conta, que é configuração da
-- agência e se refaz em dois cliques. Nenhum acesso é revogado: os agentes que
-- existirem continuam existindo, só deixam de ter teto.
-- =====================================================================

begin;

drop trigger if exists trg_usuarios_painel_limite on public.usuarios_painel;
drop function if exists public.usuarios_painel_limite_agentes();

alter table public.tenants drop constraint if exists ck_tenants_max_agentes;
alter table public.tenants drop column if exists max_agentes;

commit;
