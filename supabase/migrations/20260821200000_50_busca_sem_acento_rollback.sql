-- Rollback da migracao 50 — busca de catalogo volta a exigir acento
--
-- #########################################################################
-- ##  ESTE ROLLBACK NAO DROPA `unaccent` NEM `pg_trgm`. E DE PROPOSITO.  ##
-- #########################################################################
--
-- Ele restaura SO O CORPO da funcao `api_n8n_buscar_produtos`. As duas
-- extensoes FICAM INSTALADAS em `extensions`, sem uso, e isso nao e
-- esquecimento nem incompletude a ser "consertada" depois.
--
-- POR QUE, e foi medido em transacao abortada antes de escrever isto:
--
--   - `pg_depend` NAO registra vinculo entre uma funcao plpgsql e as extensoes
--     que ela usa (contagem medida: 0). plpgsql e late-binding — o corpo e uma
--     string, resolvida na execucao;
--   - por isso `DROP EXTENSION unaccent` **passa sem reclamar** da funcao;
--   - e a funcao continua EXISTINDO, falhando por dentro com
--     `42883: function extensions.unaccent(text) does not exist`, para TODO
--     tenant com vendas, na primeira busca de catalogo.
--
-- Ou seja: dropar a extensao junto transformaria este rollback num incidente.
-- Quem roda um rollback ja esta num momento ruim; rollback incompleto e melhor
-- que rollback que derruba o catalogo de todo mundo. Extensao instalada e nao
-- usada custa praticamente nada.
--
-- SE VOCE QUISER MESMO REMOVE-LAS, e passo MANUAL e SEPARADO, nesta ordem:
--
--   1. rode ESTE arquivo (a funcao para de citar `extensions.unaccent` e
--      `extensions.word_similarity`);
--   2. CONFIRME que nada mais as cita — e a busca nao pode ser por memoria:
--
--        select p.proname, n.nspname
--          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--         where p.prosrc ilike '%unaccent%' or p.prosrc ilike '%word_similarity%'
--            or p.prosrc ilike '%similarity(%' or p.prosrc ilike '%show_trgm%';
--
--      `prosrc` e o texto do corpo; e o unico lugar onde a dependencia existe,
--      porque `pg_depend` nao a tem;
--   3. so entao `drop extension pg_trgm;` e `drop extension unaccent;`.
--
-- O passo 2 nao e zelo: sem ele o drop e exatamente o incidente descrito acima.
--
-- ===================== O QUE VOLTA A ACONTECER =============================
--
-- Este rollback devolve os dois defeitos que a 50 fechou, e vale saber quais:
--
--   "pao de queijo"   volta a 0 encontrados, com "11 - Pão de queijo
--                     tradicional" no catalogo;
--   "queijo nózinho"  volta a 0 encontrados, com "1 - Queijo Nozinho" no
--                     catalogo.
--
-- E o ramo de zero volta a nao sugerir nada. Se voce esta rodando isto porque a
-- SUGESTAO causou problema, considere antes subir o `c_prox` na 50 (a janela
-- medida e (0.25, 0.50], e 0.4 e o ponto medio) em vez de perder tambem o
-- unaccent, que e deterministico e nao tem limiar.
--
-- ===================== SEM PERDA DE DADO ===================================
--
-- Nenhuma linha de `produtos`, `pedidos` ou `pedido_itens` e tocada. E
-- `idx_produtos_busca` nao e tocado por nenhum dos dois arquivos — a 50 deixou o
-- ramo FTS intacto justamente para nao mexer nele.
--
-- SEM `drop function`: a assinatura nunca mudou, entao o ACL (postgres,
-- service_role, n8n_agent) atravessa este rollback intacto. Se acrescentar um
-- `drop` aqui, acrescente os dois `grant` — e confira por diff de ACL, nao
-- contra a lista que voce escreveu.

begin;

create or replace function public.api_n8n_buscar_produtos(
  p_tenant_id uuid,
  p_termo     text
) returns table(
  total_encontrado integer,
  total_catalogo   integer,
  mostrando        integer,
  houve_busca      boolean,
  texto            text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  -- Cinco e o teto de itens por resposta. Vive aqui, e nao no wrapper, porque o
  -- wrapper e instrucao (o modelo pode ignorar) e isto e limite (nao pode).
  c_amostra constant integer := 5;

  v_termo      text := btrim(coalesce(p_termo, ''));
  v_busca      boolean := v_termo <> '';
  v_catalogo   integer := 0;
  v_encontrado integer := 0;
  v_mostrando  integer := 0;
  v_linhas     text;
  v_texto      text;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  select count(*)::integer
    into v_catalogo
  from public.produtos p
  where p.tenant_id = p_tenant_id
    and p.deletado_em is null
    and p.disponivel
    and (p.estoque is null or p.estoque > 0);

  with filtrados as (
    select p.id, p.nome, p.preco_centavos, p.unidade
    from public.produtos p
    where p.tenant_id = p_tenant_id
      and p.deletado_em is null
      and p.disponivel
      and (p.estoque is null or p.estoque > 0)
      and (
        not v_busca
        or p.nome ilike '%' || v_termo || '%'
        or to_tsvector('portuguese', p.nome || ' ' || coalesce(p.descricao, ''))
           @@ plainto_tsquery('portuguese', v_termo)
      )
  ),
  ordenados as (
    select f.*,
           row_number() over (
             order by (f.nome ilike '%' || v_termo || '%') desc, f.nome
           ) as pos
    from filtrados f
  ),
  amostra as (
    select * from ordenados where pos <= c_amostra
  )
  select
    (select count(*)::integer from filtrados),
    (select count(*)::integer from amostra),
    (select string_agg(
              format('%s — %s por %s (id: %s)',
                     a.nome, public.centavos_brl(a.preco_centavos), a.unidade, a.id),
              E'\n' order by a.pos)
       from amostra a)
    into v_encontrado, v_mostrando, v_linhas;

  if v_catalogo = 0 then
    v_texto := 'Catálogo vazio: nenhum item disponível.';

  elsif v_busca and v_encontrado = 0 then
    v_texto := format(
      'Busca "%s": 0 encontrados. O catálogo tem %s itens disponíveis.',
      v_termo, v_catalogo);

  elsif v_busca and v_encontrado > v_mostrando then
    v_texto := format('Busca "%s": %s encontrados, mostrando %s:' || E'\n' || '%s',
      v_termo, v_encontrado, v_mostrando, v_linhas);

  elsif v_busca then
    v_texto := format('Busca "%s": %s encontrados:' || E'\n' || '%s',
      v_termo, v_encontrado, v_linhas);

  elsif v_catalogo > v_mostrando then
    v_texto := format(
      'Catálogo: %s itens disponíveis. Amostra de %s (sem busca, ordem alfabética):' || E'\n' || '%s',
      v_catalogo, v_mostrando, v_linhas);

  else
    v_texto := format('Catálogo completo: %s itens:' || E'\n' || '%s', v_catalogo, v_linhas);
  end if;

  return query select v_encontrado, v_catalogo, v_mostrando, v_busca, v_texto;
end;
$function$;

comment on function public.api_n8n_buscar_produtos(uuid, text) is
  'Busca no catalogo do tenant. ATENCAO: forma anterior a migracao 50 — exige '
  'acento exato nos dois ramos, entao "pao de queijo" nao acha "Pão de queijo '
  'tradicional". Ver docs/PENDENCIA-CATEGORIA-PRODUTO.md e o cabecalho da 50.';

grant execute on function public.api_n8n_buscar_produtos(uuid, text) to service_role;
grant execute on function public.api_n8n_buscar_produtos(uuid, text) to n8n_agent;

commit;
