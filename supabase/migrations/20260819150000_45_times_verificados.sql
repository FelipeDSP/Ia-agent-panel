-- Migracao 45 — `api_n8n_times` so devolve time VERIFICADO
--
-- NAO APLICADA quando este arquivo foi escrito. Aplicar so depois de avisar.
--
-- ========================== O QUE MUDA, E POR QUE ==========================
--
-- O selo deixa de ser informativo e vira CONTRATO: o sub-workflow de
-- transferencia so enxerga time que o painel provou existir naquela conta do
-- Chatwoot (`verificado_em is not null`) e que nao sumiu depois
-- (`falhou_em is null`).
--
-- O motivo e o comportamento medido do Chatwoot em 18/08: `POST
-- /conversations/{id}/assignments` com `team_id` que NAO existe responde
-- **200 com corpo null** e DESATRIBUI a conversa. Ou seja, mandar um id nao
-- verificado nao e "nao acontece nada" — e tirar o time que estivesse la, em
-- silencio, no meio de um atendimento. Filtrar aqui e mais barato que tratar
-- la: o que nao volta da funcao nao pode ser mandado.
--
-- Efeito esperado no dia em que for aplicada (conferir com o select do fim):
--   fortalize  2 times -> 1 utilizavel (o 20, verificado)
--   emporio    1 time  -> 0            (padrao marcado, sem selo, conta
--                                       desconectada — e o que protege a demo)
--
-- ============================ POR QUE NAO E PERIGOSA ========================
--
-- `create or replace` com assinatura E tipo de retorno IDENTICOS: entra so um
-- `where`. Nao ha `drop function`, entao os grants nao sao apagados e nao ha
-- risco de aridade ambigua (as armadilhas das migracoes 28, 32, 37, 40 e 41).
--
-- Mesmo assim os grants vao EXPLICITOS. Custam uma linha, e a regra existe
-- porque o caso em que eles somem nao avisa: a chamada resolve certo e morre em
-- `permission denied for function`. `n8n_agent` e o role que o agente usa de
-- verdade — `service_role` sozinho ja derrubou o catalogo do emporio na 41.
--
-- Rollback: 20260819150000_45_times_verificados_rollback.sql
--
-- NOTA DE LEDGER: se esta migracao for aplicada por SQL avulso (editor/MCP) em
-- vez do CLI, o ledger grava a versao com o timestamp DELE. Confira
-- `supabase_migrations.schema_migrations` e renomeie este arquivo para a versao
-- registrada — o descasamento fez `supabase db push` querer replayar seis
-- migracoes ja aplicadas.

begin;

create or replace function public.api_n8n_times(p_tenant_id uuid)
returns table (team_id bigint, nome text, descricao text, padrao boolean)
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $$
  select t.team_id, t.nome, t.descricao, t.padrao
    from public.tenant_times t
   where t.tenant_id = p_tenant_id
     -- O SELO E O CONTRATO. Time sem prova de existencia nao chega ao n8n:
     -- `team_id` inexistente DESATRIBUI a conversa no Chatwoot, calado.
     and t.verificado_em is not null
     and t.falhou_em is null
   order by t.padrao desc, lower(btrim(t.nome));
$$;

comment on function public.api_n8n_times(uuid) is
  'Times VERIFICADOS do tenant para o sub-workflow de transferencia. Time sem selo nao sai daqui: id inexistente desatribui a conversa no Chatwoot.';

-- Grants nos DOIS roles, e so neles — a licao das migracoes 40, 41, 42 e 43.
revoke all on function public.api_n8n_times(uuid) from public, anon, authenticated;
grant execute on function public.api_n8n_times(uuid) to service_role;
grant execute on function public.api_n8n_times(uuid) to n8n_agent;

commit;

-- ============================ CONFERENCIA DEPOIS ============================
--
-- Nao roda como superusuario: `postgres` ignora grant. A prova de que o n8n
-- consegue chamar e `set role`:
--
--   set local role n8n_agent;
--   select t.slug, count(x.team_id) as utilizaveis
--     from public.tenants t
--     left join lateral public.api_n8n_times(t.id) x on true
--    where t.deletado_em is null
--    group by t.slug order by t.slug;
--
-- E o diff de ACL antes/depois, nunca a conferencia contra a lista que voce
-- espera — foi assim que `n8n_agent` passou despercebido nas migracoes 40 e 41:
--
--   select proacl from pg_proc where proname = 'api_n8n_times';
