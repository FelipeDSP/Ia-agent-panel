-- Rollback de 24_unidade_pessoa
--
-- Volta `produtos.unidade` a lista de 12 da migracao 23, sem 'pessoa'.
--
-- ATENCAO: se algum produto ja usa 'pessoa', o ADD CONSTRAINT falharia com
-- 23514 no meio do rollback, deixando a tabela SEM constraint nenhuma — pior que
-- o estado que se queria restaurar, porque a partir dai qualquer texto entra em
-- `unidade` sem ninguem perceber. O bloco 1 detecta isso antes e aborta com o
-- que precisa ser decidido.
--
-- O deploy do painel tem que ser revertido junto: UNIDADES em
-- src/lib/vendas/schema.ts oferece 'pessoa' no select, e o cliente que
-- escolhesse essa opcao levaria 23514 na tela.

begin;

-- ---------------------------------------------------------------------------
-- 1. Trava: nao deixar a tabela sem constraint
-- ---------------------------------------------------------------------------

do $$
declare
  v_usos text;
begin
  select string_agg(distinct t.slug || ' (' || p.nome || ')', ', ')
    into v_usos
  from public.produtos p
  join public.tenants t on t.id = p.tenant_id
  where p.unidade = 'pessoa';

  if v_usos is not null then
    raise exception
      'Abortado: existem produtos com unidade = ''pessoa'': %. Reverter deixaria '
      'a tabela sem CHECK de unidade. Decida a unidade de destino desses produtos '
      '(''un'' e a mais proxima), aplique o update e rode de novo.', v_usos
      using errcode = 'data_exception';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Restaura a lista de 12 da migracao 23
-- ---------------------------------------------------------------------------

alter table public.produtos
  drop constraint if exists produtos_unidade_valida;

alter table public.produtos
  add constraint produtos_unidade_valida check (unidade in (
    'un', 'kg', 'g', 'l', 'ml', 'm', 'm2', 'peca', 'par', 'porcao', 'hora', 'servico'
  ));

commit;
