-- Rollback da migracao 44 — times do Chatwoot por tenant
--
-- PERDA DE DADO: `drop table` leva os times cadastrados junto. Sao poucos e
-- recadastraveis (team_id, nome, descricao), mas a descricao e trabalho de
-- redacao do cliente — ela e que ensina o modelo a escolher. Se o motivo do
-- rollback for outro que nao "a tabela esta errada", vale exportar antes:
--
--   select tenant_id, team_id, nome, descricao, padrao from public.tenant_times;

begin;

-- Funcao primeiro: ela depende da tabela.
drop function if exists public.api_n8n_times(uuid);

drop trigger if exists trg_tenant_times_upd on public.tenant_times;
drop trigger if exists trg_tenant_times_teto on public.tenant_times;
drop function if exists public.tenant_times_teto_descricao();

-- Os indices e a policy caem com a tabela; nao precisam de linha propria.
drop table if exists public.tenant_times;

commit;
