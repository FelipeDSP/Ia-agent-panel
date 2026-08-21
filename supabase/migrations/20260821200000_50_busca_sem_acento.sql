-- Migracao 50 — busca de catalogo sem acento, e proximidade como SUGESTAO
--
-- NAO APLICADA EM PRODUCAO. Ao aplicar fora do CLI: escolha a versao ANTES,
-- renomeie ESTE arquivo e o rollback para ela, e grave a linha do ledger na
-- MESMA transacao — procedimento das 47, 48 e 49. O topo do ledger e
-- `20260821191500` (49).
--
-- ###########################################################################
-- ##  O RISCO DESTA MIGRACAO NAO E O `create or replace`. SAO AS EXTENSOES. ##
-- ###########################################################################
--
-- A funcao muda de corpo com assinatura IDENTICA, entao dela nao vem risco: sem
-- `drop function`, sem aridade ambigua (28, 32, 37), sem grant apagado (40, 41).
--
-- Mas a migracao tambem instala DUAS EXTENSOES, e e dai que vem o que ela tem de
-- irreversivel na pratica. Leia a secao "O rollback nao dropa as extensoes" e o
-- cabecalho do `_rollback.sql` antes de aplicar.
--
-- ===================== OS DOIS CASOS REAIS =================================
--
-- Medidos contra o catalogo do `emporio` (41 itens disponiveis) em 2026-08-21:
--
--   "pao de queijo"    HOJE 0 encontrados  ->  com unaccent: 1
--                      ("11 - Pão de queijo tradicional")
--   "queijo nózinho"   HOJE 0 encontrados  ->  com unaccent: 1
--                      ("1 - Queijo Nozinho")
--
-- Os DOIS caminhos da busca falhavam juntos, e nao por acaso: o dicionario
-- `portuguese` faz stemming, nao normaliza diacritico. Medido nas quatro
-- combinacoes contra a linha real:
--
--   "queijo nózinho" x "1 - Queijo Nozinho"
--     ilike cru=false   ilike+unaccent=TRUE
--     fts   cru=false   fts+unaccent=TRUE
--
-- Nenhum dos dois casos e "o cliente escreveu outra coisa": os dois sao
-- casamento exato a menos do acento.
--
-- ===================== CAMADA 1: SO NO RAMO `ilike`, E ISSO E DELIBERADO ===
--
-- O ramo FTS **nao** e unaccentado, e a assimetria tem uma causa mecanica, nao
-- de gosto: existe `idx_produtos_busca`, um GIN sobre
-- `to_tsvector('portuguese', nome || ' ' || coalesce(descricao,''))`. Expressao
-- de indice precisa ser IMMUTABLE, e `extensions.unaccent` e STABLE (medido:
-- `provolatile = 's'`, nas duas assinaturas). Unaccentar o ramo FTS exigiria um
-- wrapper IMMUTABLE — ver a secao do indice, que explica por que isso e pior que
-- o problema.
--
-- E nao precisa: o ramo `ilike` sozinho fecha os DOIS casos conhecidos, medido
-- acima. A camada 1 e deterministica, sem limiar, e nao pode trazer resultado
-- errado.
--
-- O RANKING ACOMPANHA O FILTRO. O `ordenados` classifica por
-- "casou no nome" antes de "casou so na descricao". Se o filtro passa a ignorar
-- acento e o ranking nao, a ordem degrada em silencio — "pao de queijo" acharia
-- o item e o classificaria como se tivesse casado so na descricao.
--
-- ===================== CAMADA 2: SUGESTAO, NUNCA RESULTADO =================
--
-- A proximidade so roda quando a busca exata devolve ZERO, e o que ela produz
-- entra no texto rotulado como SUGESTAO.
--
-- O motivo e o que esta serie inteira ensinou. Hoje `0 encontrados` e um sinal
-- honesto que o prompt sabe ler ("o termo falhou", nao "falta produto"). Se a
-- proximidade virasse a busca, esse sinal sumiria: o agente receberia cinco
-- produtos plausiveis e ofereceria com conviccao, e ninguem saberia que a busca
-- errou. Seria trocar "nao achei" por "achei o errado" — falha silenciosa no
-- lugar da barulhenta.
--
-- POR ISSO `total_encontrado` CONTINUA 0 quando so ha sugestoes. A distincao
-- esta no DADO, nao numa instrucao de prompt: prompt ja provou duas vezes que
-- nao segura (o `[Used tools:]` fabricado, e a regra "Repita esse resumo ao
-- cliente" violada em 20/08 no caso que virou a migracao 49).
--
-- ===================== O LIMIAR: 0.4, E A EVIDENCIA E FRACA ================
--
-- ESCRITO AQUI DE PROPOSITO, porque quem for mexer precisa saber a qualidade da
-- evidencia que o produziu: **este numero nunca foi validado contra trafego.**
-- Ele saiu de 16 termos que EU inventei, medidos contra os 41 itens do
-- `emporio` — o unico tenant com catalogo de verdade, e com 84 saidas no total.
--
-- A janela medida:
--
--   pior termo que DEVE achar ....... "quejo"    word_similarity 0.500
--   melhor falso positivo ........... "cadeira"  word_similarity 0.250
--   JANELA UTIL ..................... (0.25 , 0.50]   largura 0.250
--
-- 0.4 e o PONTO MEDIO da janela: 0.10 de folga de cada lado. Simetrico, e e a
-- unica forma defensavel de escolher sem trafego. 0.35 desequilibra para achar
-- mais; 0.45 chega perto demais de perder "quejo".
--
-- A borda fragil e o teto do lixo (0.25): oito termos fora de catalogo nao sao
-- amostra. O que amortece e o rotulo — falso positivo vira sugestao ruim, nao
-- resposta errada.
--
-- GATILHO PARA RECALIBRAR: quando houver trafego real de busca com erro de
-- digitacao (o sinal e `total_encontrado = 0` com `houve_busca = true` em
-- `mensagens_log`), refazer a tabela com os termos REAIS. E ao entrar cliente de
-- outro ramo — o vocabulario de uma clinica nao e o de um emporio, e a janela
-- foi medida num catalogo de queijos, paes e bolos.
--
-- `word_similarity` E NAO `similarity`: os nomes tem prefixo numerico
-- ("1 - Queijo Nozinho"), entao `similarity` compara a string INTEIRA e afunda —
-- "quejo" marca 0.190 por `similarity` e 0.500 por `word_similarity`. Com
-- `similarity` o limiar teria de descer para a faixa onde o lixo aparece.
--
-- COMPARACAO EXPLICITA, e nao o operador `<%`: o operador depende do GUC
-- `pg_trgm.word_similarity_threshold`, que e estado de SESSAO. Uma busca
-- responderia diferente conforme quem conectou. O `>=` com constante e
-- deterministico.
--
-- ===================== O INDICE: NENHUM NOVO ===============================
--
-- Medido: o fallback sem indice custa **0.488 ms** (seq scan; 90 produtos na
-- tabela inteira, 41 do `emporio`). E o fallback so roda quando a busca exata
-- devolve zero.
--
-- E o wrapper IMMUTABLE em volta de `unaccent` — que seria o unico jeito de
-- indexar — e pior que lento: e MENTIR AO PLANNER. `unaccent` e STABLE porque o
-- dicionario pode mudar (`ALTER TEXT SEARCH DICTIONARY`); um wrapper marcado
-- IMMUTABLE faz o indice guardar valores velhos e passar a devolver resultado
-- errado SEM ERRO NENHUM. E a mesma classe de falha silenciosa que esta serie
-- vem matando, trocada por 0.5 ms.
--
-- GATILHO PARA REVISITAR: qualquer tenant passar de ~2.000 produtos, ou a query
-- do fallback aparecer no `pg_stat_statements` (ja instalado).
--
-- `idx_produtos_busca` NAO E TOCADO e continua valido — e a razao de a camada 1
-- ficar so no `ilike`. Nota de contexto: ele tem `idx_scan = 0`, nunca foi usado,
-- porque o `OR` entre `ilike` e FTS faz o planner preferir
-- `idx_produtos_tenant_nome` e filtrar. Isolado, ele ate e usado — e fica mais
-- lento (3.486 ms contra 0.524 ms) nesta escala. Nao e motivo para dropa-lo: e
-- motivo para nao gastar migracao com ele.
--
-- ===================== AS EXTENSOES: ONDE, E QUEM PODE USAR ================
--
-- Schema `extensions`, junto de `pgcrypto`, `vector`, `uuid-ossp` e
-- `pg_stat_statements`. Convencao do projeto e do Supabase; `public` nao recebe
-- extensao.
--
-- NENHUM GRANT E NECESSARIO, e isto foi medido, nao assumido:
--
--   - os quatro roles ja tem USAGE em `extensions`
--     (`has_schema_privilege('n8n_agent','extensions','USAGE') = true`, idem
--     service_role, authenticated e anon);
--   - `unaccent` nasce com ACL `{=X/supabase_admin, supabase_admin=X, postgres=X*}`
--     — o `=X` e PUBLIC com EXECUTE, padrao de extensao;
--   - e de todo modo `api_n8n_buscar_produtos` e SECURITY DEFINER de dono
--     `postgres`, entao a chamada interna corre como `postgres`. Mesmo raciocinio
--     da 48 com `pausa_vigente`.
--
-- `search_path` NAO E TOCADO. A funcao continua com `SET search_path TO 'public'`
-- e as funcoes de extensao sao chamadas QUALIFICADAS (`extensions.unaccent`,
-- `extensions.word_similarity`). Acrescentar `extensions` ao search_path de uma
-- funcao SECURITY DEFINER ampliaria a resolucao de nome para o corpo inteiro
-- para resolver duas chamadas; qualificar toca so as linhas que precisam.
--
-- ===================== O ROLLBACK NAO DROPA AS EXTENSOES ===================
--
-- Medido em transacao abortada: `DROP EXTENSION unaccent` **passa sem reclamar**
-- da funcao que a usa, porque plpgsql e late-binding e `pg_depend` nao registra
-- vinculo nenhum (contagem = 0). Depois disso a funcao CONTINUA EXISTINDO e
-- falha por dentro com `42883: function extensions.unaccent(text) does not
-- exist` — para todo tenant com vendas, na primeira busca.
--
-- Rollback que vira incidente e pior que rollback incompleto: quem o roda ja
-- esta num momento ruim. Entao o `_rollback.sql` restaura SO o corpo da funcao e
-- deixa as extensoes instaladas. Isso esta escrito la, em maiusculas, com a
-- ordem inversa obrigatoria para quem um dia quiser mesmo remove-las.
--
-- E O FATO E MAIOR QUE ESTA MIGRACAO: nenhuma funcao plpgsql deste projeto tem
-- dependencia registrada com as extensoes que usa. Vale para qualquer coisa em
-- `extensions`, nao so `unaccent`. Registrado em CLAUDE.md, secao Migracoes.
--
-- ===================== ORDEM DE IMPLANTACAO ================================
--
-- SQL sozinho. Nao ha mudanca de workflow, de prompt nem de painel: o consumidor
-- e o no `Consulta Catalogo` do `tool-consultar-catalogo`, e ele nao muda — a
-- mesma chamada passa a achar mais e a explicar melhor o zero. Sem janela de
-- quebra em nenhuma ordem.

begin;

-- ---------------------------------------------------------------------------
-- 1. As extensoes. `if not exists` para a migracao ser reexecutavel.
-- ---------------------------------------------------------------------------
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- 2. A funcao. MESMA assinatura, MESMAS 5 colunas de retorno, MESMO
--    `search_path`, MESMO volatility (STABLE) e MESMO SECURITY DEFINER.
-- ---------------------------------------------------------------------------
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
$function$;

comment on function public.api_n8n_buscar_produtos(uuid, text) is
  'Busca no catalogo do tenant. Ignora acento no ramo ilike (migracao 50) — o ramo '
  'FTS NAO, porque idx_produtos_busca indexa aquela expressao e indice exige '
  'IMMUTABLE. Quando a busca exata da zero, acrescenta ate 5 PARECIDOS por '
  'word_similarity >= 0.4, rotulados como SUGESTAO; total_encontrado continua 0. '
  'O limiar nunca foi validado contra trafego — ver o cabecalho da migracao 50.';

-- Sem `drop function`, o ACL nunca foi apagado e nao ha nada para reconceder.
-- As linhas ficam por seguranca e sao idempotentes. `n8n_agent` e o role pelo
-- qual o agente conecta — nao e `service_role`, e era essa a que faltava na 40 e
-- na 41.
grant execute on function public.api_n8n_buscar_produtos(uuid, text) to service_role;
grant execute on function public.api_n8n_buscar_produtos(uuid, text) to n8n_agent;

commit;
