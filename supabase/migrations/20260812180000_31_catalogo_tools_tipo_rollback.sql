-- Rollback da migracao 31
--
-- RECUSA rodar se algum tenant tiver contratado uma capacidade de fluxo. Sem a
-- coluna `tipo` o painel volta a tratar `transcricao_audio` como tool do modelo
-- e passaria a lista-la como ferramenta do agente — que o agente nunca chama.
-- Melhor falhar alto do que deixar o painel mentindo.

begin;

do $$
declare
  n integer;
begin
  select count(*) into n
    from public.tenant_tools tt
    join public.catalogo_tools c on c.tool_nome = tt.tool_nome
   where c.tipo = 'capacidade_fluxo'
     and tt.contratado;

  if n > 0 then
    raise exception
      'rollback 31 recusado: % tenant(s) com capacidade de fluxo contratada. Descontrate no painel antes.', n
      using errcode = '55000';
  end if;
end $$;

-- A linha some junto: ela so faz sentido classificada.
delete from public.tenant_tools where tool_nome = 'transcricao_audio';
delete from public.catalogo_tools where tool_nome = 'transcricao_audio';

alter table public.catalogo_tools drop constraint if exists catalogo_tools_tipo_check;
alter table public.catalogo_tools drop column if exists tipo;

commit;
