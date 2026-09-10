-- =====================================================================
-- ROLLBACK da 59 — a busca volta a misturar RESULTADO e MENCAO
-- =====================================================================
--
-- Restaura o corpo EXATO que estava em producao antes da 59, extraido com
-- `pg_get_functiondef` no dia da entrega. Nao e uma reescrita de memoria: e o
-- texto que o banco tinha.
--
-- O QUE VOLTA, dito de frente: volta o defeito. Uma busca por "NR 01" no
-- `estudyou-sendbox` volta a devolver os dois cursos de NR 10 na mesma lista do
-- Treinamento de NR 01, sem rotulo, e o agente volta a poder oferecer um curso
-- de R$ 199,90 no lugar de um de R$ 69,90.
--
-- Isso esta certo para um rollback: ele restaura o estado ANTERIOR, inclusive
-- quando o estado anterior era o defeito. Rollback que "melhora" alguma coisa
-- deixa de ser rollback e vira migracao nao versionada.
--
-- MESMA ASSINATURA, `create or replace` sem `drop`: nenhum grant e apagado, e
-- por isso este arquivo NAO tem bloco de grants. Acrescentar um aqui seria
-- reconceder o que nunca saiu.
--
-- REEXECUTAVEL: `create or replace` roda quantas vezes for.
-- =====================================================================

begin;

create or replace function public.api_n8n_buscar_produtos(p_tenant_id uuid, p_termo text)
 RETURNS TABLE(total_encontrado integer, total_catalogo integer, mostrando integer, houve_busca boolean, texto text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- Cinco e o teto de itens por resposta. Vive aqui, e nao no wrapper, porque o
  -- wrapper e instrucao (o modelo pode ignorar) e isto e limite (nao pode).
  c_amostra constant integer := 5;

  -- O limiar da SUGESTAO. Ponto medio da janela medida (0.25, 0.50] contra os
  -- 41 itens do emporio. NUNCA VALIDADO CONTRA TRAFEGO — ver o cabecalho antes
  -- de mexer.
  c_prox constant real := 0.4;

  v_termo      text := btrim(coalesce(p_termo, ''));
  v_busca      boolean := v_termo <> '';
  v_catalogo   integer := 0;
  v_encontrado integer := 0;
  v_mostrando  integer := 0;
  v_linhas     text;
  v_parecidos  text;
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
        -- CAMADA 1. `unaccent` dos DOIS lados: o catalogo tem "Pão" e o cliente
        -- digita "pao", mas o inverso tambem acontece ("nózinho" contra
        -- "Nozinho"). Qualificado por schema de proposito — ver o cabecalho.
        or extensions.unaccent(p.nome) ilike '%' || extensions.unaccent(v_termo) || '%'
        -- O ramo FTS fica SEM unaccent, e isso e deliberado: `idx_produtos_busca`
        -- indexa esta expressao exata, e expressao de indice tem de ser
        -- IMMUTABLE — `unaccent` e STABLE. Unaccentar aqui invalidaria o indice
        -- em silencio. O ramo de cima ja fecha os dois casos conhecidos.
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
    --
    -- O `unaccent` ACOMPANHA O FILTRO. Sem isto, "pao de queijo" entraria pelo
    -- filtro e seria classificado como se tivesse casado so na descricao — a
    -- ordem degradaria em silencio, que e o modo de falha que esta migracao
    -- existe para nao criar.
    select f.*,
           row_number() over (
             order by (extensions.unaccent(f.nome) ilike '%' || extensions.unaccent(v_termo) || '%') desc,
                      f.nome
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
    --
    -- CAMADA 2. So aqui, e so quando a exata deu zero. `word_similarity` porque
    -- os nomes tem prefixo numerico; `>=` com constante e nao o operador `<%`
    -- porque aquele depende de um GUC de sessao. Ver o cabecalho.
    select string_agg(x.nome, ' | ' order by x.w desc, x.nome)
      into v_parecidos
    from (
      select p.nome,
             extensions.word_similarity(
               extensions.unaccent(lower(v_termo)),
               extensions.unaccent(lower(p.nome))) as w
      from public.produtos p
      where p.tenant_id = p_tenant_id
        and p.deletado_em is null
        and p.disponivel
        and (p.estoque is null or p.estoque > 0)
        and extensions.word_similarity(
              extensions.unaccent(lower(v_termo)),
              extensions.unaccent(lower(p.nome))) >= c_prox
      order by w desc, p.nome
      limit c_amostra
    ) x;

    v_texto := format(
      'Busca "%s": 0 encontrados. O catálogo tem %s itens disponíveis.',
      v_termo, v_catalogo);

    -- O ROTULO E A MIGRACAO INTEIRA. Sem ele o agente le cinco produtos
    -- plausiveis e oferece com conviccao. `total_encontrado` continua 0 no
    -- retorno, entao quem le o NUMERO tambem continua vendo "o termo falhou".
    if v_parecidos is not null then
      v_texto := v_texto || E'\n'
        || 'Parecidos (SUGESTÃO, não resultado — confirme com o cliente antes de usar): '
        || v_parecidos;
    end if;

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
$function$
;

commit;
