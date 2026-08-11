-- Rollback de 22_backfill_tools_baseline
--
-- Apaga as linhas de tenant_tools que a migracao 22 inseriu — e SO elas. As
-- chaves vem de `backfill_22_tools_inseridas`, que a ida preencheu; um delete
-- por predicado ("baseline de tenant ativo") apagaria tambem o que ja existia
-- antes, incluindo a transferir_humano da Acqua com config de producao dentro.
--
-- NAO APAGA LINHA QUE O CLIENTE JA MEXEU. Se depois do backfill alguem
-- desligou o modulo, ou gravou config (horario, notificacao), a linha deixou de
-- ser "a que a migracao criou" e virou trabalho de alguem. Essas ficam, e um
-- NOTICE lista quais — desfazer uma migracao nao e licenca para descartar
-- configuracao de cliente. Se a intencao for mesmo remover, remova a mao pela
-- tela de Modulos, que e onde essa decisao tem contexto.
--
-- Linha pristina = ainda contratado, ainda ativo e config vazio, exatamente
-- como a ida a criou.
--
-- Efeito no produto: tenant que volte a ficar sem as tools fica sem agente util
-- (sem busca na base de conhecimento). Este rollback existe para desfazer a
-- migracao, nao porque desfaze-la seja desejavel.

begin;

-- 1. Relata o que NAO sera apagado, para o desvio nao passar calado.
do $$
declare
  v_mexidas text;
begin
  select string_agg(t.slug || '/' || tt.tool_nome, ', ')
    into v_mexidas
  from public.backfill_22_tools_inseridas b
  join public.tenant_tools tt
    on tt.tenant_id = b.tenant_id and tt.tool_nome = b.tool_nome
  join public.tenants t on t.id = b.tenant_id
  where not (tt.contratado and tt.ativo and tt.config = '{}'::jsonb);

  if v_mexidas is not null then
    raise notice
      'Rollback 22: preservando linhas alteradas depois do backfill: %. '
      'Remova a mao se for mesmo a intencao.', v_mexidas;
  end if;
end;
$$;

-- 2. Apaga so as pristinas que a ida inseriu.
delete from public.tenant_tools tt
using public.backfill_22_tools_inseridas b
where tt.tenant_id = b.tenant_id
  and tt.tool_nome = b.tool_nome
  and tt.contratado
  and tt.ativo
  and tt.config = '{}'::jsonb;

-- 3. Remove a tabela de rastreio: ela so existia para este rollback.
drop table if exists public.backfill_22_tools_inseridas;

commit;
