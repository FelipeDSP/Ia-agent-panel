-- Rollback da migracao 35
--
-- RECUSA se algum tenant tiver `foto_produto` contratada: dropar a funcao
-- quebraria o sub-workflow em runtime, e plpgsql e texto opaco para o
-- `pg_depend` — o drop passaria verde e a falha apareceria na primeira foto que
-- um cliente pedisse.
--
-- A TABELA E APAGADA JUNTO, e isso e perda de dado deliberada: `fotos_enviadas`
-- e registro operacional, nao historico de cliente. Se o objetivo for so
-- desligar a capacidade, descontrate o modulo no painel — a trava passa a
-- recusar por `nao_contratado` e o registro continua acumulando evidencia.
--
-- Para reverter de verdade: descontrate, reimporte o workflow anterior no n8n, e
-- so entao rode isto.

begin;

do $$
declare
  n integer;
begin
  select count(*) into n
    from public.tenant_tools
   where tool_nome = 'foto_produto' and contratado;

  if n > 0 then
    raise exception
      'rollback 35 recusado: % tenant(s) com foto_produto contratada. Descontrate e reimporte o workflow antes.', n
      using errcode = '55000';
  end if;
end $$;

drop function if exists public.api_n8n_enviar_foto(uuid, bigint, uuid);

delete from public.tenant_tools where tool_nome = 'foto_produto';
delete from public.catalogo_tools where tool_nome = 'foto_produto';

drop index if exists public.idx_fotos_enviadas_janela;
drop policy if exists fotos_enviadas_select on public.fotos_enviadas;
drop table if exists public.fotos_enviadas;

commit;
