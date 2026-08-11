-- 21b_credencial_chatwoot_contract  (fase CONTRACT)
--
-- Fecha a exposicao: remove `tenants.chatwoot_token`. Segunda metade do par
-- iniciado em 20260811120000_21a_credencial_chatwoot_expand.sql — leia o
-- cabecalho de la para o motivo da vulnerabilidade e para as duas funcoes do
-- n8n que dependiam da coluna.
--
-- SO APLIQUE DEPOIS DE:
--   1. a 21a estar aplicada; e
--   2. o painel novo estar no ar em producao.
-- O passo 2 e o que torna esta fase segura: enquanto codigo antigo estiver
-- servindo, ele le `tenants.chatwoot_token` e quebra no instante do drop.
--
-- Nao ha janela de manutencao a escolher. Entre a 21a e o deploy as duas versoes
-- do painel funcionam; depois do deploy, nenhuma le mais a coluna. Esta fase
-- pode rodar em qualquer horario.
--
-- POR QUE O DROP NAO ACUSA DEPENDENCIA. Corpo de funcao plpgsql e texto opaco
-- para o pg_depend: se alguma funcao ainda lesse a coluna, este `alter table`
-- passaria verde e a funcao so estouraria em runtime. Por isso a 21a aponta as
-- duas funcoes para `tenant_credenciais` ANTES desta fase existir, e por isso a
-- varredura documentada la (28 funcoes, views, policies, indices, colunas) e
-- pre-requisito e nao formalidade.
--
-- Rollback: 20260811120500_21b_credencial_chatwoot_contract_rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. Fecha lacunas: tenant com token na coluna e sem linha na tabela
-- ---------------------------------------------------------------------------
-- Cobre o caso de o painel ANTIGO ter conectado um Chatwoot novo no intervalo
-- entre a 21a e o deploy: ele gravou so na coluna, e a tabela nao tem a linha.
-- Preenche apenas o que falta; nunca sobrescreve valor ja presente na tabela,
-- porque depois do deploy `tenant_credenciais` e a fonte da verdade.

insert into public.tenant_credenciais (tenant_id, chatwoot_token)
select t.id, t.chatwoot_token
from public.tenants t
where t.chatwoot_token is not null
on conflict (tenant_id) do update
  set chatwoot_token = excluded.chatwoot_token
  where public.tenant_credenciais.chatwoot_token is null;

-- ---------------------------------------------------------------------------
-- 2. Trava de divergencia — aborta antes de destruir dado
-- ---------------------------------------------------------------------------
-- Se um tenant tem token NAO nulo nos dois lugares e eles diferem, alguem
-- gravou credencial em algum ponto do rollout e nao da para saber daqui qual e
-- a boa. Dropar a coluna nesse estado destroi silenciosamente uma das duas.
-- Melhor abortar e deixar a decisao explicita.
--
-- COMO RESOLVER, conforme o caso:
--   * o token correto e o de tenant_credenciais (ex.: ja rotacionaram pelo
--     painel novo antes desta fase) — limpe a coluna do tenant citado e rode de
--     novo:
--         set local session_replication_role = replica;
--         update public.tenants set chatwoot_token = null where id = '<uuid>';
--     (o guard da migracao 13 bloqueia esse update sem o `set local`; veja o
--     rollback da 21a para a explicacao completa)
--   * o token correto e o da coluna (ex.: reconectaram pelo painel antigo no
--     intervalo) — grave-o em tenant_credenciais e rode de novo:
--         update public.tenant_credenciais set chatwoot_token = '<token>'
--          where tenant_id = '<uuid>';
--
-- Em rollout limpo, sem ninguem tocando em Chatwoot no meio, os dois lados sao
-- identicos e este bloco passa direto.

do $$
declare
  v_divergentes text;
begin
  select string_agg(t.id::text || ' (' || coalesce(t.nome, 'sem nome') || ')', ', ')
    into v_divergentes
  from public.tenants t
  join public.tenant_credenciais c on c.tenant_id = t.id
  where t.chatwoot_token is not null
    and c.chatwoot_token is not null
    and t.chatwoot_token is distinct from c.chatwoot_token;

  if v_divergentes is not null then
    raise exception
      'Abortado: token diverge entre tenants.chatwoot_token e tenant_credenciais para: %. '
      'Dropar a coluna agora destruiria uma das duas versoes. Resolva a divergencia '
      'e rode de novo — instrucoes no comentario acima deste bloco.', v_divergentes
      using errcode = 'data_exception';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Remove a coluna
-- ---------------------------------------------------------------------------
-- Seguro porque: (a) nenhuma das duas funcoes do n8n le mais daqui (21a, secoes
-- 3a e 3b; a varredura no cabecalho da 21a confirma que nao ha uma terceira);
-- (b) o guard de coluna (mig 13) usa diff de jsonb, nao referencia a coluna por
-- nome; (c) api_n8n_tenant_por_chatwoot nunca retornou o token; (d) o painel
-- novo, ja no ar, le e grava em tenant_credenciais.

alter table public.tenants drop column if exists chatwoot_token;

commit;
