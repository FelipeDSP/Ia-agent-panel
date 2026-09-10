-- =====================================================================
-- 59. A busca separa RESULTADO de MENCAO
-- =====================================================================
--
-- O DEFEITO, e ele e o mais serio que sobrou.
--
-- Cliente do `estudyou-sendbox` pediu "2 treinamentos de NR 01". A busca
-- devolveu TRES: o Treinamento de NR 01 (R$ 69,90) e dois cursos de NR 10
-- (R$ 199,90 e R$ 149,90). O agente listou os tres e perguntou qual. Ele fez o
-- que devia — a funcao e que entregou errado.
--
-- Se o cliente responde "o segundo", entra no pedido um curso de NR 10 por
-- R$ 199,90 no lugar de um de NR 01 por R$ 69,90. E O PORTAO DA 56 NAO PEGA: o
-- pedido existe, o total bate com o banco, nenhum numero esta errado. **E venda
-- errada com todos os numeros certos** — a unica classe de erro que a defesa
-- que subiu na 56 nao cobre, porque ela compara o texto com o banco e aqui o
-- texto e o banco concordam.
--
-- ---------------------------------------------------------------------
-- A CAUSA NAO E A QUE PARECE, E `phraseto_tsquery` NAO RESOLVE
--
-- Nao e coincidencia de tokens. A descricao dos dois cursos de NR 10 menciona a
-- frase, adjacente e literal:
--
--   "...o exigido pela NR 10. Alem disso, segue as determinacoes da NR 01
--    quanto aos procedimentos para treinamentos on-line."
--
-- Trocar `plainto_tsquery` por `phraseto_tsquery` continua devolvendo 3. Nenhuma
-- sofisticacao de tsquery separa isso, porque nao ha nada de errado com o
-- casamento: a frase esta la mesmo.
--
-- A causa real: a funcao trata "o produto E de NR 01" e "o produto MENCIONA
-- NR 01" como a mesma coisa, porque o ramo FTS indexa
-- `nome || ' ' || descricao` numa expressao so.
--
-- ---------------------------------------------------------------------
-- POR QUE NAO E "BUSCAR SO NO NOME". Medido em 2026-09-10:
--
--   termo                 hoje   so_nome   mencao
--   NR 01 (sendbox)          3        1        2
--   NR 10 (sendbox)          4        2        2
--   curso (sendbox)         19       13        6
--   primeiros socorros       4        1        3
--   brigada (sendbox)        2        1        1
--   queijo (emporio)         8        8        0
--
-- "So no nome" acerta o caso e paga caro: "primeiros socorros" cairia de 4 para
-- 1, "curso" de 19 para 13. Recall real, perdido para consertar a rotulagem.
--
-- ---------------------------------------------------------------------
-- O DESENHO: DOIS BLOCOS, E O ROTULO E A CORRECAO INTEIRA
--
-- A funcao JA TEM a distincao certa, em dois lugares:
--
--   a) o `row_number` do CTE `ordenados` ja poe casamento-no-nome primeiro. Ela
--      SABE a diferenca e nao a DIZ;
--   b) quando o termo da zero, a camada 2 devolve "parecidos" ROTULADOS como
--      sugestao e instrui o agente a confirmar antes de usar.
--
-- Esta migracao aplica (b) ao caso de (a): a lista deixa de ser uma so e passa a
-- ser RESULTADO (o nome casa) e MENCAO (so a descricao fala do assunto).
--
-- SEM O ROTULO OS DOIS BLOCOS SAO A LISTA DE HOJE COM UMA QUEBRA DE LINHA NO
-- MEIO, e o agente volta a oferecer os tres como iguais. Se alguma decisao
-- futura obrigar a escolher entre manter os itens e manter o rotulo, mantenha o
-- rotulo.
--
-- ---------------------------------------------------------------------
-- REGRAS QUE NAO PODEM SAIR
--
--   - o bloco de MENCAO aparece SEMPRE que houver mencao NA AMOSTRA. Nada de
--     condicionar a "quando o nome traz poucos": regra condicional e o que fica
--     errada em silencio.
--
--     "NA AMOSTRA" nao e uma condicao disfarcada, e o teto: `v_n_mencao` conta
--     sobre os 5 que cabem, entao um termo com 13 casamentos no nome ("curso")
--     enche a amostra de resultado e NAO mostra bloco de mencao. Nao ha `if`
--     nenhum sobre proporcao — e a ordem cortando, que e a regra de baixo. Foi
--     medido nos dois sentidos em `tests/busca-resultado-mencao.mjs`: `curso`
--     (19/13), `treinamentos` (15/5) e `queijo` (8/8) nao mostram o bloco, e
--     `NR 01`, `NR 10`, `primeiros socorros` e `brigada` mostram. Quem ler a
--     ausencia como defeito vai reintroduzir o defeito consertando-a;
--   - o TETO DE 5 vale para os DOIS BLOCOS SOMADOS. O texto entra no contexto de
--     toda busca de todo tenant com vendas. O limite vive aqui e nao no prompt
--     porque instrucao o modelo ignora e limite nao;
--   - ORDEM: resultado primeiro, mencao depois. Se o teto cortar, corta a
--     mencao, que e a informacao menos confiavel. Isso ja acontece de graca: o
--     `row_number` ordena por `casou_nome desc`;
--   - `total_encontrado` continua contando OS DOIS. Quem le o numero precisa ver
--     o mesmo que quem le o texto;
--   - a camada 2 (parecidos por `word_similarity`) NAO muda.
--
-- ---------------------------------------------------------------------
-- O INDICE: NENHUM INDICE NOVO E PRECISO, E ISSO FOI MEDIDO
--
-- A pergunta e legitima porque `idx_produtos_busca` indexa a expressao
-- `to_tsvector('portuguese', nome || ' ' || coalesce(descricao,''))` e o ramo
-- FTS casa essa expressao EXATA. O comentario da funcao explica por que ela fica
-- sem `unaccent`: expressao de indice tem de ser IMMUTABLE e `unaccent` e
-- STABLE, entao unaccentar ali invalidaria o indice EM SILENCIO.
--
-- Tres fatos medidos, e o terceiro e o que surpreende:
--
--   1. O FILTRO NAO MUDA. A expressao do ramo FTS continua identica, palavra por
--      palavra. O indice continua valido — nao ha o que invalidar;
--   2. a classificacao (`casou_nome`) usa uma expressao NOVA,
--      `to_tsvector('portuguese', p.nome)` sem a descricao, que nenhum indice
--      cobre. Ela nao precisa de indice: e avaliada na PROJECAO, sobre as linhas
--      que o filtro ja selecionou, e nao no filtro. `explain (analyze, buffers)`
--      antes e depois: MESMO plano, mesmos 16 buffers, custo 17.85 -> 18.10;
--   3. `idx_produtos_busca` NAO ESTA SENDO USADO HOJE. Com 90 produtos e 128 kB
--      de tabela contra 2 MB de indice, o planner escolhe
--      `idx_produtos_tenant_categoria` para o filtro de tenant e aplica o FTS
--      como `Filter`. Isso nao e defeito nem motivo para mexer nele agora — e o
--      esperado nesse tamanho —, mas quem for medir desempenho da busca deve
--      saber que o GIN esta ocioso, e nao concluir da leitura do codigo que ele
--      esta trabalhando.
--
-- ---------------------------------------------------------------------
-- MESMA ASSINATURA: `create or replace` sem `drop`. Sem `drop` nao ha aridade
-- ambigua (28, 32, 37) e nenhum grant e apagado (40, 41) — o ACL de
-- `api_n8n_buscar_produtos` (`postgres+n8n_agent+service_role`) sobrevive
-- intacto. O teste confere o ACL antes e depois em vez de conferir contra a
-- lista que eu esperava, que foi como a 41 passou verde sem `n8n_agent`.
--
-- ROLLBACK: 20260910190000_59_busca_resultado_x_mencao_rollback.sql
-- =====================================================================

begin;

create or replace function public.api_n8n_buscar_produtos(p_tenant_id uuid, p_termo text)
returns table(total_encontrado integer, total_catalogo integer, mostrando integer,
              houve_busca boolean, texto text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
$function$;

-- Sem `drop function`, o ACL nao foi tocado e nao ha nada para reconceder. As
-- duas linhas ficam mesmo assim, porque `create or replace` sobre uma funcao que
-- por acaso NAO existisse (ambiente novo) a criaria aberta — e ai o `revoke`
-- acima e que seguraria. Aqui o `revoke` E necessario pelo mesmo motivo de
-- sempre: objeto novo neste projeto nasce com EXECUTE para PUBLIC.
revoke all on function public.api_n8n_buscar_produtos(uuid, text) from public;
revoke all on function public.api_n8n_buscar_produtos(uuid, text) from anon;
revoke all on function public.api_n8n_buscar_produtos(uuid, text) from authenticated;

grant execute on function public.api_n8n_buscar_produtos(uuid, text) to service_role;
grant execute on function public.api_n8n_buscar_produtos(uuid, text) to n8n_agent;

commit;
