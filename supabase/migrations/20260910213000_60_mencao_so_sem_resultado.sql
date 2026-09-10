-- =====================================================================
-- 60. A MENCAO so aparece quando NAO ha RESULTADO
-- =====================================================================
--
-- A 59 FEZ O QUE DEVIA, E NAO BASTOU.
--
-- Com "NR 01" o Treinamento de NR 01 saiu como RESULTADO e os dois cursos de
-- NR 10 como MENCAO, rotulados. O agente ENTENDEU — nao tratou os tres como
-- equivalentes. So que ele REPASSOU A ESTRUTURA AO CLIENTE. Mensagem real do
-- `estudyou-sendbox`, em resposta a "quero 2 treinamentos de NR 01":
--
--   "Encontrei 3 opcoes relacionadas a NR 01:
--    - Treinamento de NR 01 on-line, por R$ 69,90 cada
--    - Curso de NR 10 BASICO - teorico, por R$ 199,90 cada (tem mencao a NR 01
--      na descricao)
--    - Curso de Reciclagem - NR 10 BASICO, por R$ 149,90 cada (tambem menciona
--      NR 01 na descricao)
--    Voce quer os dois treinamentos de NR 01 on-line, ou tem interesse em algum
--    dos cursos de NR 10 que mencionam NR 01?"
--
-- "Tem mencao na descricao" e vocabulario NOSSO, nao do cliente. E o agente
-- terminou OFERECENDO NR 10 A QUEM PEDIU NR 01 — que e o efeito que a 59 existia
-- para evitar, uma camada adiante.
--
-- E a mesma familia do defeito que o portao da 56 contem: o modelo RECITA o que
-- a ferramenta devolve. Ferramenta que devolve dois blocos produz resposta com
-- dois blocos.
--
-- ---------------------------------------------------------------------
-- A CORRECAO E ESTRUTURA, NAO INSTRUCAO
--
-- Nao ha instrucao nova em lugar nenhum — nem no rotulo, nem no system message.
-- Este projeto ja MEDIU que instrucao nao segura: "so afirme depois do retorno
-- da ferramenta" esta no system message e foi violada OITO vezes. Instrucao que
-- compete com o impulso de ser prestativo perde.
--
-- A regra nova e uma so:
--
--   O bloco de MENCAO so e montado quando o bloco de RESULTADO esta VAZIO.
--
-- O agente nao pode citar o que nao recebeu. Havendo resultado, ele recebe so o
-- resultado. Nao havendo, a mencao e a unica informacao disponivel e passa a ser
-- util — e continua com o rotulo da 59, que nesse caso esta certo.
--
-- ---------------------------------------------------------------------
-- O ROTULO "RESULTADO —" TAMBEM SAI, E PELO MESMO MOTIVO
--
-- Com um bloco so nao ha o que rotular: a palavra RESULTADO existia para opor a
-- MENCAO. Mantida sozinha, ela seria exatamente o tipo de estrutura que o modelo
-- recita ("o resultado que casa com o nome e..."). Entao a resposta com
-- resultado volta a ser a lista simples de sempre.
--
-- A palavra RESULTADO sobrevive num unico lugar: `RESULTADO: NENHUM item tem
-- "X" no nome`, que so aparece no ramo sem resultado, onde dizer isso e o que
-- impede o agente de tratar a mencao como se fosse a resposta.
--
-- ---------------------------------------------------------------------
-- O NUMERO NAO MENTE, E NAO HA FRASE NOVA PARA ISSO
--
-- `total_encontrado` continua contando OS DOIS. Com "NR 01" ele segue 3, e o
-- texto passa a mostrar 1 — entao o texto tem de dizer que escondeu dois.
--
-- Ele diz, e na propria linguagem que a funcao ja tinha:
--
--   Busca "NR 01": 3 encontrados, mostrando 1:
--
-- `mostrando` deixou de ser "quantos couberam no teto" e passou a ser QUANTOS O
-- TEXTO LISTA — que e o que a palavra sempre prometeu. A coluna `mostrando` do
-- retorno acompanha, entao quem le o numero ve o mesmo universo de quem le o
-- texto.
--
-- NAO foi acrescentada uma frase do tipo "2 itens omitidos porque so citam o
-- termo na descricao". Foi considerada e descartada de proposito: o defeito
-- desta migracao E o modelo recitando estrutura, e cada frase nova e estrutura
-- nova para recitar — inclusive uma que devolveria ao agente o vocabulario
-- "mencao na descricao" que acabamos de tirar dele. A divulgacao honesta ja
-- existe no par `encontrados`/`mostrando`, que o agente ja recebe hoje em toda
-- busca larga ("curso": 19 encontrados, mostrando 5) e sabe tratar: ele pede ao
-- cliente para refinar. E o que ele NAO pode fazer, agora, e oferecer os dois
-- cursos de NR 10 — porque nao os tem.
--
-- ---------------------------------------------------------------------
-- MEDIDO EM PRODUCAO, 2026-09-10 (classificacao na amostra, teto 5,
-- ordem `casou_nome desc`):
--
--   termo                tenant     total  resultado  mencao   depois da 60
--   NR 01                sendbox      3        1        2      so o resultado
--   NR 10                sendbox      4        2        2      so o resultado
--   primeiros socorros   sendbox      4        1        3      so o resultado
--   curso                sendbox     19        5        0      igual
--   treinamentos         sendbox     15        5        0      igual
--   queijo               emporio      8        5        0      igual
--
-- Os tres ultimos nao mudam: o teto ja era preenchido pelos resultados.
--
-- O CAMINHO EM QUE A MENCAO AINDA APARECE FOI MEDIDO, NAO INVENTADO. Varrendo
-- as palavras das descricoes dos dois tenants: 685 termos so-mencao no
-- `estudyou-sendbox` e 3 no `emporio`. Os dois que o teste usa sao reais e sao
-- perguntas plausiveis de cliente:
--
--   certificado (sendbox)   10 encontrados, 0 casam no nome
--   torra       (emporio)    1 encontrado,  0 casa  no nome
--
-- ---------------------------------------------------------------------
-- O RISCO QUE ESTA MIGRACAO CRIA, DITO DE FRENTE
--
-- Condicionar cria um modo de falha silencioso: se um dia `casou_nome` quebrar e
-- passar a devolver falso para tudo, o bloco de RESULTADO fica vazio, a MENCAO
-- vira a resposta inteira e ninguem percebe — o texto continua bem formado.
--
-- Por isso `tests/busca-resultado-mencao.mjs` afirma OS DOIS SENTIDOS, e nenhum
-- sozinho basta: (1) havendo resultado, MENCAO nao aparece **e** o resultado
-- aparece; (2) nao havendo, MENCAO aparece com o rotulo integro. So (1) passa
-- numa implementacao que apagou o bloco de mencao do codigo; so (2) passa numa
-- que nunca classifica nada como nome. A sabotagem S5 forca `casou_nome` a falso
-- para tudo e exige vermelho.
--
-- ---------------------------------------------------------------------
-- O QUE NAO MUDOU: `casou_nome`, o filtro (as duas camadas), a camada 2
-- (parecidos por `word_similarity`), o teto de 5, o rotulo da MENCAO quando ela
-- aparece, e `total_encontrado`. Muda so o trecho que MONTA O TEXTO.
--
-- MESMA ASSINATURA (as mesmas cinco colunas), `create or replace` sem `drop`:
-- sem `drop` nao ha aridade ambigua (28, 32, 37) e nenhum grant e apagado
-- (40, 41). O `revoke` antes do `grant` fica, porque objeto novo neste projeto
-- nasce com EXECUTE para PUBLIC.
--
-- ROLLBACK: 20260910213000_60_mencao_so_sem_resultado_rollback.sql
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
  v_mostrando  integer := 0;   -- QUANTOS O TEXTO LISTA (ver o cabecalho)
  v_linhas     text;      -- a amostra inteira: usada nos ramos SEM busca
  v_resultado  text;      -- as linhas cujo NOME casa
  v_mencao     text;      -- as linhas em que so a descricao fala do assunto
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
           -- ja selecionou. Por isso nao precisa de indice — ver a 59.
           --
           -- NAO MUDOU NA 60. A 60 mexe so em como o texto e montado; mexer aqui
           -- mudaria o que e resultado e o que e mencao, que esta medido e certo.
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
        -- "Nozinho"). Qualificado por schema de proposito.
        or extensions.unaccent(p.nome) ilike '%' || extensions.unaccent(v_termo) || '%'
        -- O ramo FTS fica SEM unaccent, e isso e deliberado: `idx_produtos_busca`
        -- indexa esta expressao exata, e expressao de indice tem de ser
        -- IMMUTABLE — `unaccent` e STABLE. Unaccentar aqui invalidaria o indice
        -- em silencio. O ramo de cima ja fecha os dois casos conhecidos.
        --
        -- NAO MUDOU NA 59 NEM NA 60, e nao mudar e o ponto: o filtro identico e
        -- o que garante que nenhum recall foi perdido em nenhuma das duas.
        or to_tsvector('portuguese', p.nome || ' ' || coalesce(p.descricao, ''))
           @@ plainto_tsquery('portuguese', v_termo)
      )
  ),
  ordenados as (
    -- Casamento no nome antes de casamento so na descricao. `row_number` em vez
    -- de `order by ... limit` para que os `string_agg` abaixo consigam repetir
    -- EXATAMENTE a ordem da amostra.
    --
    -- E E DAQUI QUE SAI "SE O TETO CORTAR, CORTA A MENCAO": ordenando
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
    -- porque aquele depende de um GUC de sessao. NAO MUDOU NA 60.
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

  elsif v_busca and v_n_result = 0 then
    -- ------------------------------------------------------------------
    -- NENHUM nome casou. A mencao e a UNICA informacao que existe, entao ela
    -- sai — e o rotulo da 59 esta certo justamente aqui: o agente precisa saber
    -- que nao e o item pedido, porque nao ha item pedido.
    --
    -- Este ramo e o unico lugar em que a palavra MENCAO existe depois da 60.
    -- ------------------------------------------------------------------
    v_mostrando := v_n_mencao;

    v_texto := format('Busca "%s": %s encontrados', v_termo, v_encontrado);
    if v_encontrado > v_mostrando then
      v_texto := v_texto || format(', mostrando %s', v_mostrando);
    end if;
    v_texto := v_texto || '.' || E'\n'
      || format('RESULTADO: NENHUM item tem "%s" no nome.', v_termo) || E'\n'
      || format('MENÇÃO (%s) — o nome NÃO casa; só a descrição fala deste assunto. '
                || 'NÃO ofereça como se fosse o item pedido; confirme com o cliente antes de usar:',
                v_n_mencao) || E'\n'
      || v_mencao;

  elsif v_busca then
    -- ------------------------------------------------------------------
    -- HA RESULTADO. So ele sai: o bloco de mencao NAO E MONTADO, e por isso o
    -- agente nao tem como cita-lo. Nenhuma instrucao pedindo que ele se cale —
    -- instrucao ja foi medida e nao segura.
    --
    -- Sem o segundo bloco nao ha o que rotular, entao a resposta volta a ser a
    -- lista simples: menos estrutura para o modelo espelhar.
    --
    -- `mostrando` conta as linhas que ESTE texto lista. Quando o resto do
    -- encontrado ficou de fora — por mencao suprimida ou pelo teto, e sao a
    -- mesma frase — o par `encontrados`/`mostrando` diz isso sozinho.
    -- ------------------------------------------------------------------
    v_mostrando := v_n_result;

    if v_encontrado > v_mostrando then
      v_texto := format('Busca "%s": %s encontrados, mostrando %s:' || E'\n' || '%s',
        v_termo, v_encontrado, v_mostrando, v_resultado);
    else
      v_texto := format('Busca "%s": %s encontrados:' || E'\n' || '%s',
        v_termo, v_encontrado, v_resultado);
    end if;

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
-- linhas ficam mesmo assim, porque `create or replace` sobre uma funcao que por
-- acaso NAO existisse (ambiente novo) a criaria aberta — e ai o `revoke` acima e
-- que seguraria.
revoke all on function public.api_n8n_buscar_produtos(uuid, text) from public;
revoke all on function public.api_n8n_buscar_produtos(uuid, text) from anon;
revoke all on function public.api_n8n_buscar_produtos(uuid, text) from authenticated;

grant execute on function public.api_n8n_buscar_produtos(uuid, text) to service_role;
grant execute on function public.api_n8n_buscar_produtos(uuid, text) to n8n_agent;

commit;
