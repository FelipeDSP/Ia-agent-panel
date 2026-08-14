-- Migracao 36 — billing da ingestao deixa de contar o mesmo job duas vezes
--
-- O ACHADO. A auditoria de confiabilidade (04/08) disse que a ingestao e
-- idempotente pelo swap, e isso e verdade PARA OS CHUNKS: `kb_reindex_documento`
-- apaga por (tenant, origem) e reinsere, entao rodar duas vezes produz a mesma
-- base vetorial. O BILLING ao lado dele nao herda essa propriedade. O insert em
-- `uso_ingestao` (processar-ingestao/index.ts, logo depois do swap) e puro, sem
-- chave: o mesmo job processado duas vezes grava duas linhas e cobra os tokens
-- de embedding em dobro.
--
-- A janela e estreita mas real: um job que falha DEPOIS do swap e antes do
-- `status = concluido` fica em erro; o botao "Reprocessar" roda de novo, o swap
-- reescreve os mesmos chunks (de graca, correto) e o billing soma outra vez.
--
-- POR QUE `job_id` E A CHAVE, sem inventar nada. Um job de ingestao produz
-- exatamente UMA linha aqui — a Edge Function acumula `tokensEmbedding` ao longo
-- de todos os lotes de 20 chunks e grava uma vez so, no fim. Entao "um job, uma
-- cobranca" ja e a regra; ela so nao estava escrita em lugar nenhum que o banco
-- pudesse fazer valer. A coluna existe desde a migracao 15 e ja vem preenchida.
--
-- POR QUE NAO UMA CHAVE MAIS LARGA — e isto NAO e escolha de desenho, e a unica
-- chave que a tabela aceita. Descoberto ao sabotar o teste: trocar a chave por
-- `(tenant_id)` faz o `create unique index` estourar 23505 CONTRA O DADO REAL,
-- porque as 2 linhas de producao sao do mesmo tenant. O mesmo vale para
-- (tenant_id, modelo) e (tenant_id, tokens): as duas linhas sao o mesmo
-- documento reindexado em 30/07 e 04/08, 10.333 tokens cada, jobs diferentes.
-- Sao duas cobrancas CORRETAS — a OpenAI foi chamada duas vezes. Qualquer chave
-- mais larga que `job_id` nao sobe; se subisse, nao evitaria cobranca a mais,
-- produziria cobranca a menos — pior, porque ninguem reclama de fatura baixa.
--
-- BACKFILL: nenhum. As 2 linhas existentes tem `job_id` distintos e nao-nulos, o
-- indice sobe limpo. `job_id` e nullable e continua sendo: no Postgres, NULLs
-- sao distintos entre si num indice unico (o default e `nulls distinct`), entao
-- uma eventual linha sem job nao colide com outra — que e o que se quer, porque
-- "sem job" nao identifica nada.
--
-- INDICE NAO-CONCORRENTE de proposito. A tabela tem 2 linhas; o lock de
-- `create unique index` dura milissegundos. `concurrently` nao roda dentro de
-- transacao e nos custaria a atomicidade da migracao inteira em troca de nada.
-- Se um dia a tabela crescer para milhoes de linhas, a conta se inverte — mas ai
-- o indice ja existe. E este o argumento para fazer agora: barato hoje, janela
-- de manutencao depois.
--
-- SEGUNDA CAMADA, nao unica. O `on conflict do nothing` do lado da Edge Function
-- (processar-ingestao/index.ts) e a primeira linha; este indice e a autoridade.
-- Mesma divisao de RLS x filtro explicito: as duas rodam.
--
-- ORDEM DE DEPLOY: ESTA MIGRACAO PRIMEIRO, deploy da Edge Function depois.
-- Nao e simetrico, e a assimetria foi medida (transacao abortada, 14/08):
--
--   indice primeiro, Edge ainda com insert puro
--     job ja cobrado (retry) -> 23505, e a linha da 1a execucao ESTA la (n=1).
--                               Nada se perde: 23505 so dispara porque ja cobrou.
--     job novo               -> passa normal.
--     = correto, com um console.error barulhento no retry.
--
--   Edge com upsert primeiro, indice ainda inexistente
--     job ja cobrado -> 42P10
--     job NOVO       -> 42P10 tambem  <-- o ponto
--     = `on conflict (job_id)` sem indice unico e recusado SEMPRE, nao so em
--       duplicata. E como o insert e best-effort (`if (usoErro) console.error`),
--       a ingestao termina bem e NENHUMA linha de cobranca e gravada, para
--       todos os clientes, durante toda a janela.
--
-- A ordem A erra so no que ja estava cobrado. A ordem B perde tudo.
--
-- ROLLBACK: 20260814150000_36_uso_ingestao_idempotente_rollback.sql

begin;

create unique index if not exists uq_uso_ingestao_job
  on public.uso_ingestao (job_id);

comment on index public.uq_uso_ingestao_job is
  'Um job de ingestao cobra uma vez. Reprocessar reescreve os chunks de graca; '
  'sem esta chave, somava os tokens de novo. NULLs seguem distintos — linha sem '
  'job nao identifica cobranca nenhuma.';

commit;
