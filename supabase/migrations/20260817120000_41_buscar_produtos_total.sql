-- 41_buscar_produtos_total
--
-- `api_n8n_buscar_produtos` passa a dizer QUANTOS existem, nao so a amostra.
--
-- O DEFEITO. O agente do emporio (40 produtos) respondeu "o que voces teriam
-- para me oferecer?" listando TRES QUEIJOS, como se fosse o catalogo inteiro. A
-- funcao tinha `limit 10` e devolvia so as linhas: o agente recebia N e
-- apresentava N, sem ter como saber que houve corte. O cliente final tambem nao.
--
-- Corte silencioso e pior que lista longa: lista longa o cliente rola, corte
-- silencioso ele nem sabe que existe.
--
-- ---------------------------------------------------------------------------
-- A FORMA DO RETORNO, e por que UMA LINHA em vez de coluna repetida
-- ---------------------------------------------------------------------------
--
-- A alternativa obvia era acrescentar `total_encontrado` repetido em cada linha.
-- Ela quebra exatamente no caso que mais importa: quando a busca NAO ACHA NADA,
-- nao ha linha nenhuma, e com isso nao ha onde pendurar o total. O agente
-- receberia vazio e nao saberia distinguir "esse termo nao existe no catalogo de
-- 40 itens" de "esse cliente nao tem catalogo". As duas pedem resposta
-- diferente: a primeira e "nao temos esse, mas temos outros 40 — quer ver?"; a
-- segunda e "o catalogo ainda nao esta cadastrado".
--
-- Entao a funcao devolve SEMPRE UMA LINHA, com os fatos e com o texto pronto:
--
--   total_encontrado  quantos casam com o termo (ou o catalogo todo, sem termo)
--   total_catalogo    quantos existem disponiveis, ignorando o termo
--   mostrando         quantos vieram na amostra
--   houve_busca       false quando o termo veio vazio
--   texto             o que o agente le
--
-- O TEXTO SAI DAQUI e nao da query do n8n, que era onde ele morava. Dois
-- motivos: (a) o teto e a formatacao passam a ser exercitados por
-- `tests/migracao-vendas.mjs`, contra o banco, em vez de viverem numa string
-- dentro de um JSON de workflow — e este projeto ja perdeu producao por
-- escapamento errado em no de workflow; (b) muda-se a frase por migracao, com
-- rollback, e nao por reimportacao manual em 9 workflows.
--
-- ---------------------------------------------------------------------------
-- LIMITE 10 -> 5
-- ---------------------------------------------------------------------------
--
-- Contra-intuitivo so enquanto a lista for a unica resposta possivel. Com o
-- total no retorno, o agente para de precisar da lista para responder bem:
-- "tenho 23 opcoes — procura queijo para petisco ou para cozinhar?" conversa
-- melhor que dez linhas que ninguem le no WhatsApp. Cinco cabem numa tela de
-- celular sem rolar.
--
-- ---------------------------------------------------------------------------
-- DROP EXPLICITO
-- ---------------------------------------------------------------------------
--
-- O tipo de retorno muda, e `create or replace` recusa mudanca de tipo de
-- retorno ("cannot change return type of existing function"). Aqui o drop nao e
-- so a precaucao do CLAUDE.md contra aridade ambigua (28, 32, 37) — e
-- obrigatorio. Dropado pela lista completa de tipos, nunca pelo nome.
--
-- Rollback: 20260817120000_41_buscar_produtos_total_rollback.sql

drop function if exists public.api_n8n_buscar_produtos(uuid, text);

create or replace function public.api_n8n_buscar_produtos(
  p_tenant_id uuid,
  p_termo     text
)
returns table (
  total_encontrado integer,
  total_catalogo   integer,
  mostrando        integer,
  houve_busca      boolean,
  texto            text
)
language plpgsql
stable
security definer
set search_path = public
as $$
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

  -- O catalogo INTEIRO disponivel, sem o termo. E o denominador que permite
  -- dizer "nao achei esse, mas existem outros 40".
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
    -- Casamento no nome antes de casamento so na descricao: quem pede "pudim"
    -- quer o pudim, nao o prato cuja descricao menciona pudim. `row_number` em
    -- vez de `order by ... limit` para que o string_agg abaixo consiga repetir
    -- EXATAMENTE a ordem da amostra — ordenar de novo no agg perderia a
    -- relevancia e mostraria itens diferentes dos contados.
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

  -- ---------------------------------------------------------------------
  -- O TEXTO. Curto de proposito: entra no contexto a cada busca, de todo
  -- tenant com vendas. Cada ramo diz uma coisa diferente ao agente, e a
  -- diferenca entre eles e o ponto da migracao.
  -- ---------------------------------------------------------------------
  if v_catalogo = 0 then
    -- Nao ha catalogo. Nao e falha de busca, e ausencia de cadastro.
    v_texto := 'Catálogo vazio: nenhum item disponível.';

  elsif v_busca and v_encontrado = 0 then
    -- O termo nao casou, MAS existe catalogo. E o caso que a forma antiga nao
    -- conseguia comunicar.
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
    -- Sem termo. Dizer que NAO houve busca importa: o agente que sabe disso
    -- pergunta o que a pessoa procura em vez de tratar a amostra como resposta.
    v_texto := format(
      'Catálogo: %s itens disponíveis. Amostra de %s (sem busca, ordem alfabética):' || E'\n' || '%s',
      v_catalogo, v_mostrando, v_linhas);

  else
    v_texto := format('Catálogo completo: %s itens:' || E'\n' || '%s', v_catalogo, v_linhas);
  end if;

  return query select v_encontrado, v_catalogo, v_mostrando, v_busca, v_texto;
end;
$$;

comment on function public.api_n8n_buscar_produtos(uuid, text) is
  'Amostra de ate 5 produtos MAIS os totais. Devolve sempre UMA linha, inclusive '
  'quando a busca nao acha nada — e o unico jeito de o agente distinguir '
  '"termo sem resultado" de "catalogo vazio". Ver migracao 41.';

revoke all on function public.api_n8n_buscar_produtos(uuid, text) from public;
revoke all on function public.api_n8n_buscar_produtos(uuid, text) from anon;
revoke all on function public.api_n8n_buscar_produtos(uuid, text) from authenticated;
grant execute on function public.api_n8n_buscar_produtos(uuid, text) to service_role;
