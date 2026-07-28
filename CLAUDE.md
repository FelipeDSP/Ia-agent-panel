# CLAUDE.md

Painel de gestão de agentes de IA multi-tenant. Uma agência provisiona agentes
conversacionais para empresas clientes; cada cliente administra seu próprio prompt e
base de conhecimento sem tocar em SQL.

Leia `ESPECIFICACAO.md` antes de escrever código. Ele contém o modelo de dados,
as decisões de arquitetura já tomadas e as fases de implementação.

## Stack

- Next.js 15 (App Router) + TypeScript strict
- Supabase: Postgres + Auth + Storage + Edge Functions
- `@supabase/ssr` para integração com App Router
- Tailwind + shadcn/ui
- OpenAI `text-embedding-3-small` (1536 dimensões, fixo)
- Deploy na Vercel

## Contexto crítico

**Existe um cliente em produção.** Acqua Lavanderia, `chatwoot_account_id = 56`,
12 documentos vetorizados, 74 conversas. O agente dele roda em n8n e lê deste mesmo
banco. Qualquer migração de schema precisa mantê-lo funcionando — não é ambiente limpo.

**O n8n é um segundo consumidor do banco.** O painel não é o único cliente. Toda
mudança em `kb_documentos`, `conversas` ou `tenants` pode quebrar o agente em produção.
Ao alterar essas tabelas, verifique o impacto no n8n antes.

## Regras de multi-tenancy

Estas não são preferências de estilo. Violar qualquer uma delas é vazamento de dados
entre clientes.

1. **`tenant_id` vem do JWT, nunca do request.** Se uma rota lê `tenant_id` do body,
   query string ou header, está errado. A origem é sempre
   `auth.jwt() -> 'app_metadata' ->> 'tenant_id'`. Exceção: rotas de super_admin, que
   ainda assim verificam o papel no servidor antes.

2. **Toda tabela com `tenant_id` tem RLS ativo com policy.** Tabela nova sem policy
   vaza. Ao criar uma migração que adiciona tabela, a policy vai na mesma migração.

3. **`tenant_id` é a primeira coluna de todo índice composto.** Postgres usa prefixo
   mais à esquerda. `(tenant_id, criado_em)` serve para "itens do tenant X" e para
   "itens do tenant X ordenados por data". `(criado_em, tenant_id)` não serve para nada.

4. **UUID para tudo que é escopado por tenant.** IDs sequenciais permitem enumerar
   recursos de outros clientes incrementando o número.

5. **`service_role` só no servidor.** Server Actions, Route Handlers, Edge Functions.
   Se aparecer em componente com `'use client'`, é incidente de segurança.

6. **Query SQL crua sempre com filtro explícito de tenant.** RLS é a rede de segurança,
   não a primeira linha de defesa. Rode as duas camadas.

## Padrões Supabase + Next.js

- Use `@supabase/ssr`, não o cliente antigo
- Em Server Components use `supabase.auth.getUser()`, nunca `getSession()` —
  `getSession()` não revalida o token no servidor
- Middleware faz refresh de sessão e protege rotas
- Operações de auth via Server Actions quando possível
- Nunca armazene tokens manualmente

## Migrações

- Rodar com role que bypassa RLS. Migração com RLS ativo faz `ALTER TABLE` afetar
  apenas a visão do tenant corrente, sem erro visível.
- A migração de BIGINT para UUID em `tenants` é destrutiva se feita direto. Siga a
  ordem descrita em `ESPECIFICACAO.md` seção 5.2 — adicionar coluna nova, popular,
  trocar constraints, renomear. Teste em branch do Supabase antes de produção.
- Toda migração precisa de caminho de rollback.

## Ingestão de documentos

- É assíncrona. Um PDF de 50 páginas leva 30-60s; não cabe em request HTTP.
- Status em `jobs_ingestao`, frontend faz polling.
- Embeddings em lote (20 chunks por request à OpenAI), não um por vez.
- O `metadata` do chunk precisa conter `tenant_id` — o node PGVector do n8n filtra
  por metadata, não por coluna. É redundante com a coluna de propósito.
- Chunking: alvo ~450 caracteres (~120 tokens), overlap ~120 caracteres.
  Configurável por env na Edge Function (`CHUNK_ALVO_CHARS`, `CHUNK_OVERLAP_CHARS`).
  **Não é o "~800 tokens" que constava aqui antes.** Os 12 chunks que o n8n já
  gravou em produção (Acqua) têm média de ~380 chars; o agente foi afinado com
  esse calibre. Como o n8n lê do mesmo banco, chunk muito maior quebra a paridade
  de recall — o teste de recall da Fase 4 mostrou 3/5 com chunk grande e 5/5 com
  chunk alinhado à produção. Ao mexer no tamanho, re-rode o teste de recall.

## Testes

- Seed com **três** tenants, não um. Um tenant esconde todo bug de isolamento; dois
  escondem vazamento unidirecional.
- Todo recurso novo precisa de um teste que confirme que o tenant B não acessa o
  dado do tenant A — inclusive por URL direta e por chamada de API.

## Convenções

- Nomes de tabela e coluna em português (o schema existente já é assim: `criado_em`,
  `atualizado_em`, `deletado_em`)
- Código, tipos e componentes em inglês
- Timestamps sempre `TIMESTAMPTZ`, nunca `TIMESTAMP`
- Soft delete via `deletado_em`, não `DELETE` físico, para `tenants` e para o
  registro de documento que o cliente removeu de propósito (recuperável).
  **Exceção — chunks vetoriais em `kb_documentos`:** um chunk é índice derivado,
  reconstruível a partir do arquivo no Storage. No reprocessamento de um documento
  os chunks antigos daquele `origem` são apagados com `DELETE` físico, sempre
  escopado por `tenant_id` **e** `origem`, e substituídos por chunks novos no mesmo
  swap transacional. Sem isso a tabela acumularia gerações mortas a cada reindex.
  A fonte da verdade continua sendo o arquivo no Storage — se o cliente apagar o
  documento em si, aí sim é soft delete.

## Antes de dar por pronto

- `npm run build` passa sem erro de tipo
- Teste de isolamento entre os 3 tenants do seed passa
- Nenhuma `service_role` key em código client
- Migração tem rollback escrito
