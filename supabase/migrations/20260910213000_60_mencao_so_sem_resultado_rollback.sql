-- =====================================================================
-- ROLLBACK da 60 — a MENCAO volta a sair junto com o RESULTADO
-- =====================================================================
--
-- Restaura o corpo EXATO que a migracao 59 deixou em producao, extraido com
-- `pg_get_functiondef` no dia da entrega da 60. Nao e uma reescrita de memoria:
-- e o texto que o banco tinha.
--
-- O QUE VOLTA, dito de frente: volta a resposta em DOIS BLOCOS. Uma busca por
-- "NR 01" no `estudyou-sendbox` volta a entregar ao agente, junto com o
-- Treinamento de NR 01, os dois cursos de NR 10 rotulados como MENCAO — e foi
-- exatamente com esse texto que ele escreveu ao cliente "tem mencao a NR 01 na
-- descricao" e ofereceu NR 10 a quem pediu NR 01.
--
-- Isso esta certo para um rollback: ele restaura o estado ANTERIOR, inclusive
-- quando o estado anterior era o defeito. Rollback que "melhora" alguma coisa
-- deixa de ser rollback e vira migracao nao versionada.
--
-- Rodar este arquivo NAO desfaz a 59 — ele para na 59. Para voltar ao mundo de
-- uma lista so, rode depois o rollback da 59.
--
-- MESMA ASSINATURA, `create or replace` sem `drop`: nenhum grant e apagado, e
-- por isso este arquivo NAO tem bloco de grants. Acrescentar um aqui seria
-- reconceder o que nunca saiu.
--
-- REEXECUTAVEL: `create or replace` roda quantas vezes for.
-- =====================================================================

begin;

CREATE OR REPLACE FUNCTION public.api_n8n_buscar_produtos(p_tenant_id uuid, p_termo text)
 RETURNS TABLE(total_encontrado integer, total_catalogo integer, mostrando integer, houve_busca boolean, texto text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- Cinco e o teto de itens por resposta, agora somando os DOIS blocos. Vive
  -- aqui, e nao no wrapper, porque o wrapper e instrucao (o modelo pode ignorar)
  -- e isto e limite (nao pode).
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
  v_linhas     text;      -- sem busca, ou busca sem mencao nenhuma
  v_resultado  text;      -- bloco 1: o nome casa
  v_mencao     text;      -- bloco 2: so a descricao fala do assunto
  v_n_result   integer := 0;
  v_n_mencao   integer := 0;
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
    select p.id, p.nome, p.preco_centavos, p.unidade,
           -- CASOU NO NOME. Duas formas, e as duas sao necessarias:
           --   `ilike` pega substring ("queijo" dentro de "Queijo Coalho") e
           --   sobrevive a acento pelos dois lados;
           --   o FTS SO DO NOME pega flexao ("treinamentos" -> "Treinamento"),
           --   que o `ilike` de substring nao pega.
           -- Esta expressao NAO entra no filtro: e projecao sobre o que o filtro
           -- ja selecionou. Por isso nao precisa de indice — ver o cabecalho.
           (
             extensions.unaccent(p.nome) ilike '%' || extensions.unaccent(v_termo) || '%'
             or to_tsvector('portuguese', p.nome) @@ plainto_tsquery('portuguese', v_termo)
           ) as casou_nome
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
        --
        -- ESTA LINHA NAO MUDOU NA MIGRACAO 59, e nao mudar e o ponto: o filtro
        -- identico e o que garante que nenhum recall foi perdido. O que a 59
        -- acrescenta e a CLASSIFICACAO do que ja vinha, nao um filtro novo.
        or to_tsvector('portuguese', p.nome || ' ' || coalesce(p.descricao, ''))
           @@ plainto_tsquery('portuguese', v_termo)
      )
  ),
  ordenados as (
    -- Casamento no nome antes de casamento so na descricao. `row_number` em vez
    -- de `order by ... limit` para que os `string_agg` abaixo consigam repetir
    -- EXATAMENTE a ordem da amostra.
    --
    -- E E DAQUI QUE SAI A REGRA "SE O TETO CORTAR, CORTA A MENCAO": ordenando
    -- `casou_nome desc`, os cinco primeiros sao os resultados e so depois as
    -- mencoes. Nao ha logica de corte em lugar nenhum — a ordem faz o trabalho.
    select f.*,
           row_number() over (order by f.casou_nome desc, f.nome) as pos
    from filtrados f
  ),
  amostra as (
    select * from ordenados where pos <= c_amostra
  )
  select
    (select count(*)::integer from filtrados),
    (select count(*)::integer from amostra),
    (select count(*)::integer from amostra a where a.casou_nome),
    (select count(*)::integer from amostra a where not a.casou_nome),
    -- lista unica, usada quando NAO ha mencao nenhuma (e no ramo sem busca)
    (select string_agg(
              format('%s — %s por %s (id: %s)',
                     a.nome, public.centavos_brl(a.preco_centavos), a.unidade, a.id),
              E'\n' order by a.pos)
       from amostra a),
    (select string_agg(
              format('%s — %s por %s (id: %s)',
                     a.nome, public.centavos_brl(a.preco_centavos), a.unidade, a.id),
              E'\n' order by a.pos)
       from amostra a where a.casou_nome),
    (select string_agg(
              format('%s — %s por %s (id: %s)',
                     a.nome, public.centavos_brl(a.preco_centavos), a.unidade, a.id),
              E'\n' order by a.pos)
       from amostra a where not a.casou_nome)
    into v_encontrado, v_mostrando, v_n_result, v_n_mencao,
         v_linhas, v_resultado, v_mencao;

  -- ---------------------------------------------------------------------
  -- O TEXTO. Curto de proposito: entra no contexto a cada busca, de todo
  -- tenant com vendas.
  -- ---------------------------------------------------------------------
  if v_catalogo = 0 then
    -- Nao ha catalogo. Nao e falha de busca, e ausencia de cadastro.
    v_texto := 'Catálogo vazio: nenhum item disponível.';

  elsif v_busca and v_encontrado = 0 then
    -- O termo nao casou, MAS existe catalogo.
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

    -- O ROTULO E A MIGRACAO INTEIRA (isto e da 51, e segue igual). Sem ele o
    -- agente le cinco produtos plausiveis e oferece com conviccao.
    if v_parecidos is not null then
      v_texto := v_texto || E'\n'
        || 'Parecidos (SUGESTÃO, não resultado — confirme com o cliente antes de usar): '
        || v_parecidos;
    end if;

  elsif v_busca and v_n_mencao > 0 then
    -- ------------------------------------------------------------------
    -- O CASO DESTA MIGRACAO: ha item cujo NOME nao casa, so a descricao.
    --
    -- O bloco de mencao aparece SEMPRE que `v_n_mencao > 0`. Sem condicao
    -- nenhuma sobre quantos resultados existem: regra condicional e o que fica
    -- errada em silencio no dia em que a proporcao muda.
    -- ------------------------------------------------------------------
    v_texto := format('Busca "%s": %s encontrados', v_termo, v_encontrado);
    if v_encontrado > v_mostrando then
      v_texto := v_texto || format(', mostrando %s', v_mostrando);
    end if;
    v_texto := v_texto || '.';

    if v_resultado is not null then
      v_texto := v_texto || E'\n'
        || format('RESULTADO — o nome casa com "%s" (%s):', v_termo, v_n_result) || E'\n'
        || v_resultado;
    else
      -- Nenhum nome casou: TODOS os achados sao mencao. Dizer isso e o que
      -- impede o agente de tratar o bloco de baixo como se fosse a resposta.
      v_texto := v_texto || E'\n'
        || format('RESULTADO: NENHUM item tem "%s" no nome.', v_termo);
    end if;

    v_texto := v_texto || E'\n'
      || format('MENÇÃO (%s) — o nome NÃO casa; só a descrição fala deste assunto. '
                || 'NÃO ofereça como se fosse o item pedido; confirme com o cliente antes de usar:',
                v_n_mencao) || E'\n'
      || v_mencao;

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
