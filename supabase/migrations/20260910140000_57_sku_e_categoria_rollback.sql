-- =====================================================================
-- ROLLBACK da 57 — SKU gerado e categoria por tenant
-- =====================================================================
--
-- ORDEM: o painel le `categorias` e `produtos.categoria_id`. Reverta o DEPLOY do
-- painel ANTES de rodar isto, ou a tela do catalogo passa a consultar coluna que
-- nao existe (`42703`) e o cliente fica sem catalogo.
--
-- ---------------------------------------------------------------------
-- O QUE ELE DESFAZ, E A PARTE QUE IMPORTA E A PRIMEIRA
--
--   1. DEVOLVE O PREFIXO AO NOME, linha a linha, a partir do registro que a
--      migracao anotou em `backfill_57_nome_original`. Nao e reconstrucao por
--      heuristica: e o nome exato de antes.
--
--      Reconstruir por regra ("se o sku e numerico, prefixe") poria prefixo em
--      produto que NUNCA teve — os seis planos do `Denuncyou` e os tres do
--      `Chatyou` no sendbox nunca tiveram numero no nome, e ganhariam um. O
--      cliente veria o catalogo mudar num rollback que deveria devolve-lo.
--
--   2. limpa o sku que a migracao gerou, PRESERVANDO o texto legado
--      (`BEB-AGUA-500`, `BEB-CHOPP-300`, `LAV-CAM-SOC`), que a migracao nao
--      tocou e o rollback tambem nao pode apagar;
--   3. dropa a trigger, a funcao, o contador, `categoria_id` e `categorias`;
--   4. RESTAURA o indice unico anterior, com `deletado_em is null` no predicado.
--      Voltar ao estado de antes significa voltar tambem ao defeito de antes —
--      um rollback que "melhora" alguma coisa deixa de ser rollback e vira
--      migracao nao versionada.
--
-- ---------------------------------------------------------------------
-- REEXECUTAVEL: `if exists` em tudo, e o passo 1 vira no-op quando a tabela de
-- registro ja foi dropada. Rodar duas vezes da o mesmo resultado, que e o que
-- permite ao teste replayar isto em transacao abortada com a migracao aplicada
-- ou nao.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. o nome volta a ter o prefixo — do registro, nao de heuristica
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.backfill_57_nome_original') is not null then
    update public.produtos p
       set nome = b.nome_antes
      from public.backfill_57_nome_original b
     where b.produto_id = p.id
       and p.nome <> b.nome_antes;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. o sku gerado sai; o texto legado fica
-- ---------------------------------------------------------------------
-- `sku ~ '^[0-9]+$'` e o discriminador: tudo que a 57 gerou e numerico, e nada
-- do que existia antes dela era. Os tres skus de texto sobrevivem.
update public.produtos
   set sku = null
 where sku ~ '^[0-9]+$';

-- ---------------------------------------------------------------------
-- 3. trigger, funcao, contador, coluna e tabela
-- ---------------------------------------------------------------------
drop trigger if exists trg_produtos_sku on public.produtos;
drop function if exists public.produtos_atribui_sku();

alter table public.produtos drop constraint if exists produtos_categoria_fk;
drop index if exists public.idx_produtos_tenant_categoria;
alter table public.produtos drop column if exists categoria_id;

-- `drop trigger if exists ... ON tabela` NAO e seguro quando a TABELA nao
-- existe: o `if exists` cobre o gatilho, nao a relacao, e o comando estoura com
-- `42P01`. Pego pelo rollback-primeiro do teste, que roda este arquivo com o
-- banco ainda sem `categorias`.
--
-- Dropar a tabela ja leva os gatilhos dela junto, entao o drop explicito nem
-- precisa existir. Fica so o `drop table`, que aceita `if exists` de verdade.
drop table if exists public.categorias;
drop table if exists public.produto_sku_seq;
drop table if exists public.backfill_57_nome_original;

-- ---------------------------------------------------------------------
-- 4. o indice unico ANTERIOR, com o predicado anterior
-- ---------------------------------------------------------------------
drop index if exists public.uq_produtos_tenant_sku;
create unique index uq_produtos_tenant_sku
  on public.produtos (tenant_id, sku)
  where sku is not null and deletado_em is null;

commit;
