-- Rollback da migracao 33
--
-- RECUSA se o workflow principal ainda depender dela. Nao da para checar o n8n
-- daqui, entao a checagem e indireta: se algum tenant tem transcricao_audio
-- contratada, o ramo de audio esta em uso e dropar a funcao o quebraria em
-- runtime -- a mesma classe de falha da migracao 16 com o chatwoot_token, em que
-- plpgsql e texto e pg_depend nao enxerga a dependencia.
--
-- Para reverter de verdade: descontrate o modulo no painel, reimporte o
-- workflow anterior no n8n, e so entao rode isto.

begin;

do $$
declare
  n integer;
begin
  select count(*) into n
    from public.tenant_tools
   where tool_nome = 'transcricao_audio' and contratado;

  if n > 0 then
    raise exception
      'rollback 33 recusado: % tenant(s) com transcricao_audio contratada. Descontrate e reimporte o workflow antes.', n
      using errcode = '55000';
  end if;
end $$;

drop function if exists public.api_n8n_pode_transcrever(uuid, bigint);

commit;
