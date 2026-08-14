# CLAUDE.md

Painel de gestão de agentes de IA multi-tenant. Uma agência provisiona agentes
conversacionais para empresas clientes; cada cliente administra seu próprio prompt e
base de conhecimento sem tocar em SQL.

Leia `docs/especificacao/ESPECIFICACAO.md` antes de escrever código. Ele contém o
modelo de dados, as decisões de arquitetura já tomadas e as fases de implementação.
Toda a documentação vive em `docs/` (veja `docs/README.md` para o índice).

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

## Superfície de tool

**Toda superfície que uma tool traz — item de menu, rota, seção de tela,
indicador, Server Action — só existe para quem contratou aquela tool.**

É propriedade, não lista. Uma lista das tools de hoje envelhece na próxima; a
propriedade vale para ela também, sem ninguém precisar lembrar. Vale para toda
tool futura.

**Superfície não é sinônimo de rota.** `foto_produto` não tem rota nenhuma — é
uma seção dentro do catálogo, e obedece à mesma regra. Rota é o caso mais comum,
não o conceito.

**Esconder não é o mesmo que não poder.** Um item de menu escondido não impede
digitar a URL, e uma rota recusada não impede chamar a Server Action, que é
entrada própria e não passa por página nenhuma. As três precisam da mesma
checagem — `src/lib/tools/contratacao.ts`, uma verdade e três consumidores.

**"Pode desligar" não é derivado de "é vendida."** `busca_conhecimento` não
desliga por limitação técnica; `transferir_humano` desliga por escolha de
negócio, sem ser módulo vendido. São campos separados no registry (`contratavel`,
`desligavel`), e quem pode desligar tem de aparecer em algum lugar da tela —
senão é decisão do cliente sem onde ser tomada.

**Onde a declaração mora:** `rotasPainel` no registry (`src/lib/tools/registro.ts`).
Não em `catalogo_tools` — o painel do cliente não lê aquela tabela (super-only por
RLS), e pôr regra de exibição dele ali exigiria afrouxar policy para ganhar nada.

**Como é verificado** (regra escrita em doc não sobrevive a seis meses):

- o menu do painel é montado a partir do registry, então esquecer de declarar faz
  o item **não aparecer para ninguém** — o esquecimento vira ausência, que alguém
  nota, em vez de vazamento, que ninguém nota;
- `npm run teste:superficie` reprova rota sob `/painel/` que não seja declarada
  por uma tool nem esteja em `ROTAS_SEMPRE_VISIVEIS`, e reprova Server Action de
  superfície de tool sem checagem de contratação;
- `npm run teste:descontratar` prova que descontratar não apaga dado.

**Se a resolução de contratação falhar no servidor, falha FECHA:** sobram as
rotas sempre-visíveis e as condicionais somem. Mostrar demais leva o cliente a
clicar num item que a rota recusa; mostrar de menos é sintoma que ele relata na
hora. A mesma escolha vale no guard de rota — divergir produziria menu que mostra
o que a rota nega.

**Descontratar esconde superfície, nunca apaga dado.** Produtos, pedidos e fotos
ficam onde estão e recontratar devolve tudo; `definirContratacao` só vira o
booleano. Se alguém descontratar por engano e o catálogo evaporar, o cliente
perde trabalho de cadastro que ninguém consegue devolver.

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
  ordem descrita em `docs/especificacao/ESPECIFICACAO.md` seção 5.2 — adicionar coluna nova, popular,
  trocar constraints, renomear. Teste em branch do Supabase antes de produção.
- Toda migração precisa de caminho de rollback.
- **O nome do arquivo tem que bater com a versão em
  `supabase_migrations.schema_migrations`.** Até 2026-08-05 nenhum batia: as
  migrações vinham sendo aplicadas por SQL avulso (editor/MCP), que grava o
  ledger com o próprio timestamp, e os arquivos ficavam com outro. O efeito é que
  `supabase db push` enxergava seis migrações já aplicadas como novas e as
  replayaria contra produção. Foram renomeadas; ao aplicar uma migração nova
  fora do CLI, confira o ledger e renomeie o arquivo para a versão registrada.
- As migrações 01–08 nunca foram versionadas. A reconstrução delas está em
  `supabase/baseline/` — é o que permite levantar um ambiente novo sem tocar em
  produção. Leia o README de lá antes de mexer em migração.
- **Acrescentar parâmetro com DEFAULT a uma função exige `drop function` da
  assinatura antiga, explícito, antes do `create or replace`.** `or replace` só
  substitui a função de mesma aridade: com o parâmetro novo, as duas ficam vivas,
  e a chamada com a contagem ANTIGA de argumentos passa a ser **ambígua** — que é
  exatamente a chamada que o n8n faz hoje. Falha em runtime, no primeiro cliente,
  e não na migração. Aconteceu na 28 (`fechar_pedido`), foi evitado na 32
  (`api_n8n_registrar_mensagem`) e de novo na 37. Drope pela lista completa de
  tipos (`drop function if exists f(uuid, bigint, text, ...)`), não pelo nome —
  dropar pelo nome com várias assinaturas vivas erra ou derruba a errada. Mantenha
  o `create or replace` depois do drop: sem ele a migração não é reexecutável, e
  o teste que aplica em transação abortada para de rodar assim que ela entra em
  produção.

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
- Não existe caminho para reindexar um documento já **concluído**: a Edge Function
  responde 409 para job `concluido` e o botão "Reprocessar" só aparece em job com
  erro. Mudar `CHUNK_ALVO_CHARS` hoje exige re-subir cada documento à mão.

## Busca vetorial

O índice `idx_kb_embedding` é HNSW **global**, sem `tenant_id`. Toda query real
filtra por tenant, e nessa combinação o planner descarta o HNSW: ele resolve por
`idx_kb_origem` e ordena os vetores do tenant em memória. Foi verificado com
`explain (analyze, buffers)` em 2026-08-05 — 158 chunks, 33 ms.

**Isso é correto e é lento.** O recall é perfeito (compara todos os vetores do
tenant) e o custo cresce linear com o tamanho da base daquele cliente. A alguns
milhares de chunks por tenant vira o gargalo de cada mensagem do agente.

A armadilha está no conserto óbvio. Forçar o uso do HNSW com
`hnsw.iterative_scan = off` (o valor atual do banco) faz a busca **devolver menos
resultados do que o `limit` pedido, em silêncio**: o índice retorna os `ef_search`
vizinhos mais próximos globalmente e só depois o filtro de tenant descarta os de
outros clientes. Tenant pequeno numa tabela grande pode receber zero linhas sem
erro nenhum — o agente responde sem base de conhecimento e nada no log indica que
faltou contexto. É a mesma classe de falha que a migração 10 eliminou em
`match_kb_documentos`, reintroduzida por outra porta.

Se for mexer, os caminhos que preservam o recall são:

- índice HNSW **parcial por tenant** (`where tenant_id = '<uuid>'`), que é o que
  o pgvector recomenda para multi-tenant, ao custo de um índice por cliente;
- `hnsw.iterative_scan = relaxed_order`, que faz o pgvector continuar varrendo o
  índice até completar o `limit` (pgvector 0.8.2 no banco — suporta).

Nos dois casos, re-rode o teste de recall (`npm run teste:recall`) antes e depois
e compare os números. Trocar plano de busca vetorial sem medir recall é como
trocar o tamanho do chunk sem medir: quebra calado.

## Testes

- Seed com **três** tenants, não um. Um tenant esconde todo bug de isolamento; dois
  escondem vazamento unidirecional.
- Todo recurso novo precisa de um teste que confirme que o tenant B não acessa o
  dado do tenant A — inclusive por URL direta e por chamada de API.
- **Afirme PROPRIEDADE, não estado do mundo.** `nenhum tenant tem áudio
  contratado` era verdade no dia em que foi escrito e virou falsa quando alguém
  contratou pelo painel — como deveria. Teste que fica vermelho porque o sistema
  funcionou é a forma mais rápida de todo mundo parar de olhar a suíte.

  O reescrito mede a propriedade: *aplicar a migração não contrata para
  ninguém* (conta antes × depois). O mesmo vale para "zero pedidos", "zero
  conversas pausadas", "catálogo vazio" — pausar conversa e cadastrar produto são
  operações normais.

  Quando o estado do mundo importa mesmo, há duas saídas: declará-lo explícito e
  versionado (ver `PEDIDOS_HISTORICOS` em `tests/trava-vendas.mjs`), ou emitir
  **aviso** em vez de falha. Aviso informa sem treinar ninguém a ignorar vermelho.
- **Teste que não consegue falhar é pior que teste ausente**, porque compra
  confiança. Se escrever uma asserção nova, sabote-a uma vez e confirme que ela
  reprova — já houve `|| true` numa condição e um regex casando com o comentário
  em vez do código.

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
