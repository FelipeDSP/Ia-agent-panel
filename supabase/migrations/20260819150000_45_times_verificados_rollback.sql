-- Rollback da migracao 45 — devolve `api_n8n_times` sem o filtro de selo
--
-- Volta exatamente ao corpo da migracao 44. Mesma assinatura e mesmo tipo de
-- retorno, entao tambem e `create or replace` sem `drop function`: os grants
-- sobrevivem, e mesmo assim vao explicitos pelo mesmo motivo da ida.
--
-- ============================ QUANDO USAR ==================================
--
-- Se depois de aplicar a 45 um tenant que DEVERIA rotear parar de rotear. O
-- sintoma e a transferencia voltar a so pausar, sem atribuir time — que e o
-- comportamento anterior a toda esta fatia, e portanto NAO quebra ninguem; e
-- perda de funcionalidade nova, nao regressao.
--
-- Antes de rodar isto, confira se a causa nao e simplesmente selo faltando:
--
--   select t.slug, tt.team_id, tt.nome, tt.padrao, tt.verificado_em, tt.falhou_em
--     from public.tenant_times tt
--     join public.tenants t on t.id = tt.tenant_id
--    order by t.slug, tt.team_id;
--
-- Se `verificado_em` estiver nulo, o conserto e clicar em "Verificar" no painel
-- do cliente, NAO reverter a migracao: reverter devolve ao n8n times nao
-- provados, e id inexistente DESATRIBUI a conversa no Chatwoot em silencio.

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
   order by t.padrao desc, lower(btrim(t.nome));
$$;

comment on function public.api_n8n_times(uuid) is
  'Times do tenant para o sub-workflow de transferencia: o modelo escolhe pelo nome, o servidor resolve o team_id.';

revoke all on function public.api_n8n_times(uuid) from public, anon, authenticated;
grant execute on function public.api_n8n_times(uuid) to service_role;
grant execute on function public.api_n8n_times(uuid) to n8n_agent;

commit;
