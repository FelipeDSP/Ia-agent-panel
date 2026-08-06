# Auditoria de Performance — ChatYou · IA

> Investigação apenas — **nada otimizado**. Medições reais do banco de produção
> (contagens, tamanhos, índices via `pg_catalog`) e leitura do código. Data: 2026-08-04.

## TL;DR

**Não há problema de performance hoje** — o volume é minúsculo e a base está
**muito bem indexada**. Os achados são todos de **escala**: dois padrões (N+1 de
contagens no admin e listagens sem paginação/limite) que quebram primeiro quando o
número de clientes e de linhas por cliente crescer. O hot path caro (busca vetorial do
n8n) **já tem índice HNSW** e escala bem.

## Medições reais (produção, hoje)

| Tabela | Linhas | Tamanho |
|---|---|---|
| kb_documentos | 158 | 2.7 MB |
| conversas | 69 | 128 kB |
| podcast_agendamentos | 13 | 64 kB |
| mensagens_log | 8 | 48 kB |
| tenants | 6 | 96 kB |
| tenant_tools | 6 | 64 kB |
| prompt_versoes / precos_modelo | 3 | 48 kB |
| jobs_ingestao / uso_ingestao / usuarios_painel | 2 | 48–96 kB |

Chunks por tenant: 70 (maior), 12, 3. **Tudo cabe em memória trivialmente; qualquer
consulta hoje é sub-milissegundo.**

Bundle (do `next build` desta sessão): **First Load JS compartilhado 103 kB**; por rota
1.7–6.4 kB (ex.: `/painel` 113 kB, `/painel/conhecimento` 114 kB, `/admin/tenants/[id]`
120 kB total). Enxuto — na linha de base do Next.

## O que está BOM (confirmado, não presumido)

- **Índices** (lidos de `pg_indexes`): todos os compostos começam por `tenant_id`
  (regra 3): `conversas(tenant_id, atualizado_em DESC)`, `conversas(tenant_id, status)`,
  `kb_documentos(tenant_id, origem) WHERE deletado_em IS NULL`, `(tenant_id, criado_em
  DESC)`, `jobs_ingestao(tenant_id, criado_em DESC)` + índice parcial de pendentes,
  `mensagens_log(tenant_id, criado_em DESC)`, etc. Cobrem os filtros e ordenações usados.
- **Busca vetorial:** `idx_kb_embedding USING hnsw (embedding vector_cosine_ops)` — o
  caminho mais caro (semântica a cada mensagem, via `api_n8n_buscar_kb`) é indexado com
  HNSW (sublinear). Escala para 100x chunks sem virar full scan. + GIN em `metadata`.
- **I/O paralelo:** `painel/page.tsx`, `admin/tenants/page.tsx`, `configuracoes/page.tsx`,
  `conversas/[id]/page.tsx` usam `Promise.all`. **Nenhuma sequencialidade desnecessária.**
- **Ingestão de arquivo assíncrona:** upload → Storage → job → Edge Function em background
  (`EdgeRuntime.waitUntil`), painel faz polling. Não bloqueia request.
- **Cache:** só `revalidatePath` (invalidação por caminho). **Nenhum cache que ignore o
  escopo do tenant** — ou seja, nenhum cache perigoso hoje (o risco que você citou não
  existe porque não há cache de dados).

## Achados (priorizados por impacto × esforço)

| ID | Arquivo:linha | Achado | Hoje | Com escala (100x dados / 50x usuários) | Esforço fix |
|---|---|---|---|---|---|
| **P1** | `admin/tenants/page.tsx:62-82` | **N+1 de contagens**: 2 counts por tenant (`Promise.all` paraleliza, mas são 2×N round-trips ao PostgREST por load). | 6 tenants → 12 counts, ~ms. | 600 tenants → **1200 counts por abertura** da tela de Clientes; latência de segundos + pressão no pooler. **Quebra primeiro.** | Baixo–médio: uma RPC/`view` agregando `count(*) group by tenant_id` num round-trip, ou materialized view. |
| **P2** | `conhecimento/page.tsx:15-40` | **Consulta sem limite**: carrega TODOS os chunks do tenant (`select origem, metadata, criado_em ... order by criado_em desc`) e agrupa por `origem` em JS a cada visita. | 70 linhas, trivial. | 7.000+ chunks/tenant → milhares de linhas trafegadas + agrupamento em JS a cada page view. Lento. | Baixo: agregar no SQL (`group by origem` com `count`, `max(criado_em)`) — devolve N documentos, não N chunks. |
| **P3** | `conversas/page.tsx` (listagem) | **Listagem sem paginação**: lista todas as conversas do tenant (ordenação usa o índice `(tenant_id, atualizado_em DESC)`, mas o payload é ilimitado). | 69 linhas. | Milhares de conversas → payload grande + render de todas as linhas no cliente. | Baixo: paginação/`range()` + índice já existe. |
| **P4** | `conhecimento/acoes.ts:107-157` (`ingerirTexto`) | **Trabalho síncrono no request**: o caminho "colar texto" espera a Edge Function embutir todos os chunks (chamadas à OpenAI) dentro do ciclo do request. Capado em 50k chars. | Ok (texto curto). | Sob concorrência (50x), muitas ingestões síncronas seguram tempo de função serverless; texto perto de 50k = vários segundos por request. | Médio: mandar texto pelo mesmo caminho assíncrono do arquivo (job + polling). |
| **P5** | (arquitetura) | **Sem cache de dados**: toda visita de dashboard consulta o banco. Consultas são indexadas e rápidas, mas sob 50x usuários há carga desnecessária repetida (ex.: contagens do `painel/page.tsx`). | Irrelevante. | Carga de leitura repetida no Postgres; amplificada pelo P1. | Médio (e **cuidado**: qualquer cache aqui **precisa** ser chaveado por `tenant_id`, senão vira vazamento — hoje não há cache, então não há esse risco). |
| P6 | `conversas/acoes.ts` (`limparMemoriaConversas`) | Fetch síncrono ao n8n com timeout de 15s dentro da action. | Raro. | Se o n8n estiver lento, a action pende até 15s. Baixo (ação pouco frequente). | Baixo: aceitar como está ou tornar fire-and-forget. |

## Payloads / serialização
- Respostas das telas retornam campos enxutos (selects nomeados, não `select *`), exceto
  o caso do P2 (todos os chunks). `verConteudoDocumento` carrega o `text` de todos os
  chunks de **um** documento — limitado pelo tamanho do doc, ok.
- Sem serialização pesada; sem export/relatório grande.

## Frontend / bundle / assets
- Bundle enxuto (números acima). Sem dependência pesada (lucide tree-shaken, supabase-js,
  next). **Nada a lazy-load com urgência.**
- Logos servidos via `<img>` (não `next/image`) — PNGs pequenos; otimização daria ganho
  marginal. Favicon `icon.png` ok. **Baixa prioridade.**

## Projeção de escala — o que quebra primeiro, em ordem
1. **`/admin/tenants`** (super_admin) — o N+1 de contagens (P1). Com centenas de clientes,
   é a primeira tela a ficar lenta e a pressionar o pooler. Impacto concentrado no
   super_admin, mas é o gargalo nº 1.
2. **`/painel/conhecimento`** — a consulta sem limite (P2) cresce linearmente com os chunks
   do tenant; um cliente com base grande sente primeiro.
3. **`/painel/conversas`** — listagem sem paginação (P3) cresce com o volume de conversas.
4. **Ingestão de texto** (P4) sob concorrência — segura tempo de função serverless.
5. **Busca vetorial (n8n)** — **NÃO** quebra cedo: HNSW é sublinear; é o caminho mais caro
   por natureza, mas o índice segura 100x. Só vira tema em volumes muito acima disso
   (aí: tuning de `ef_search`, ou `ivfflat` com listas, ou particionamento).

O que **não** é gargalo: conexões (o app usa PostgREST/supabase-js + pooler do Supabase,
não conexões diretas; serverless escala horizontal). O tema de escala é **padrão de
consulta** (P1–P3), não infra de conexão.

---

## Prioridade recomendada (impacto × esforço)
1. **P1** (N+1 admin) — maior impacto de escala, esforço baixo (1 RPC agregada). Fazer antes de passar de ~algumas dezenas de clientes.
2. **P2** (chunks sem limite) — esforço baixo (agregar no SQL), remove crescimento linear na tela mais usada pelo cliente.
3. **P3** (paginação de conversas) — esforço baixo, índice já existe.
4. **P4** (ingestão de texto assíncrona) — esforço médio; só relevante sob concorrência real.
5. **P5** (cache tenant-scoped) — só depois dos anteriores, e com chave por `tenant_id`.

### Nota de método
Volume atual é KB-escala, então não faz sentido `EXPLAIN ANALYZE` (o planner faz seqscan
em tabela de 158 linhas porque é mais barato — não indica falta de índice). Os índices
existem e têm o formato certo para escala; a projeção acima é a partir do crescimento de
linhas × padrão de consulta lido no código, não de latência medida hoje (que é ~0).
