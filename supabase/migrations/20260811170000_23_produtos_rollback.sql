-- Rollback de 23_produtos
--
-- Remove a tabela de produtos e o que a migracao 23 criou em volta dela.
--
-- ATENCAO — ISTO APAGA CATALOGO. Diferente dos rollbacks anteriores deste repo,
-- que so mexiam em estrutura, aqui existe dado de cliente: cada linha de
-- `produtos` foi digitada por alguem no painel. `drop table` leva junto os
-- produtos soft-deletados, que sao recuperaveis enquanto a tabela existir.
--
-- Antes de rodar, se houver qualquer catalogo cadastrado, exporte:
--
--   \copy (select * from public.produtos) to 'produtos_backup.csv' csv header
--
-- O bloco 1 abaixo recusa o rollback se houver produto vivo, exatamente para
-- este comando nao ser lembrado tarde demais. Para forcar mesmo assim, apague o
-- bloco e assuma a perda.
--
-- Nao ha o que reverter na aplicacao: a fatia 1 nao alterou nenhuma tabela
-- existente nem nenhuma funcao do n8n. Reverter aqui deixa a tela
-- /painel/catalogo erroando; o deploy do codigo tem que sair junto.

begin;

-- ---------------------------------------------------------------------------
-- 1. Trava: nao apagar catalogo de cliente sem decisao explicita
-- ---------------------------------------------------------------------------

do $$
declare
  v_vivos integer;
  v_total integer;
begin
  select count(*) filter (where deletado_em is null), count(*)
    into v_vivos, v_total
  from public.produtos;

  if v_total > 0 then
    raise exception
      'Abortado: existem % produto(s) cadastrado(s) (% vivo(s)). `drop table` '
      'perderia catalogo digitado por cliente, incluindo os soft-deletados. '
      'Exporte antes (\copy ... to ''produtos_backup.csv'' csv header) e remova '
      'este bloco se a perda for aceita.', v_total, v_vivos
      using errcode = 'data_exception';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Tabela (leva junto policy, indices e trigger)
-- ---------------------------------------------------------------------------

drop table if exists public.produtos;

-- ---------------------------------------------------------------------------
-- 3. btree_gin
-- ---------------------------------------------------------------------------
-- So a migracao 23 instalou e so o indice de busca de produtos usava. Se outra
-- migracao passar a depender dela, REMOVA este drop — derrubar a extensao
-- levaria os indices dela junto, em cascata silenciosa.
--
-- Sem `cascade` de proposito: se algo mais depender, o drop falha e avisa, em
-- vez de destruir indice alheio.

drop extension if exists btree_gin;

commit;
