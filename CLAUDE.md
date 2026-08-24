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
- **Ao dropar ou renomear coluna, varra `tests/` junto com o schema.** A migração
  21 tirou `chatwoot_token` de `tenants` e a varredura de impacto cobriu funções,
  views, policies e índices — foi exemplar no schema e **não olhou os testes**.
  Uma asserção de isolamento continuou apontando para a coluna morta; o select
  passou a errar, `data` virou `null`, e `(null ?? []).length === 0` é `true`.
  Seis dias verde sem executar nada, guardando justamente o token do Chatwoot, e
  nos mesmos seis dias em que quatro clientes foram conectados.

  O erro não foi de execução: a varredura estava certa e o **escopo** estava
  errado. Teste é consumidor do schema como o n8n é — só que não reclama quando
  a coluna some, porque o cliente PostgREST devolve erro em vez de lançar. Então:
  `grep -rn "<coluna>" tests/ src/ supabase/ n8n/` antes de dropar, e confira
  cada resultado, não só os de código de produção.
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

- **Toda tabela ou view nova em `public` nasce com TUDO liberado para `anon`.**
  Não é hipótese: `ALTER DEFAULT PRIVILEGES` deste projeto concede
  **`arwdDxtm`** (select, insert, update, delete, truncate, references, trigger)
  a `anon`, `authenticated` e `service_role` em todo objeto novo do schema —
  medido em 2026-08-21 criando uma view sem nenhum `grant` e lendo o `relacl`.

  A consequência é que **escrever `grant select ... to authenticated` não
  restringe nada** — o objeto já nasceu legível e gravável por `anon`, e o
  `grant` só reafirma o que já estava lá. Uma migração que "conceda com
  cuidado" e não revogue está fazendo decoração.

  O que segura hoje é a RLS: `anon` sem JWT tem `auth_tenant_id()` nulo e vê
  zero linhas. **Isso é a segunda camada fazendo o trabalho da primeira**, e a
  regra 6 já diz que não é assim que se faz.

  Então, em objeto novo com `tenant_id`:

  ```sql
  revoke all on public.<obj> from public;
  revoke all on public.<obj> from anon;
  revoke all on public.<obj> from authenticated;
  revoke all on public.<obj> from service_role;
  grant  select on public.<obj> to authenticated;   -- só o que precisa
  grant  select on public.<obj> to service_role;
  ```

  E confira pelo `relacl`, não pelo que você escreveu: `authenticated=r/postgres`
  é leitura só; `authenticated=arwdDxtm/postgres` é o default disfarçado de
  intenção.

  **Varrido em 2026-08-21**, os 21 objetos de `public`: nenhuma tabela vaza —
  todas têm RLS com policy, e `anon` lê **0 linhas** em 19 delas. Duas exceções,
  nenhuma delas incidente:

  - `podcast_agendamentos` tem RLS **sem policy nenhuma**, o que nega tudo:
    `anon` e `authenticated` leem 0, só `service_role` vê as 14 linhas. Negação
    implícita funciona, mas não está declarada em lugar nenhum;
  - `podcast_vagas` é view **sem `security_invoker`** e `anon` lê 9 linhas dela.
    **Não é vazamento**: ela expõe só agregado (`dia`, `ocupadas`,
    `vagas_restantes`), e a base com `nome`/`empresa`/`whatsapp` fica trancada.
    Mas **a proteção é a lista de colunas, não a permissão** — sem
    `security_invoker` ela roda como `postgres` (BYPASSRLS), então acrescentar
    `a.nome` ao `select` vazaria PII para `anon` na hora — **simulado, e saíram
    nomes reais**. Virou item próprio: `docs/PENDENCIA-PODCAST-VAGAS.md`, que
    também mede por que o conserto óbvio (`revoke` + `security_invoker`)
    **quebra a página em silêncio**.

- **View sobre tabela com RLS PRECISA de `security_invoker = true`.** Sem ela a
  view roda com os privilégios do DONO, que é `postgres` — e `postgres` tem
  `rolbypassrls = true` neste projeto (não é superusuário, mas tem o atributo).
  Medido com duas views idênticas lidas por `authenticated` com claims de um
  tenant: **sem a opção, 89 linhas de 5 tenants; com ela, 16 de 1.**

  E `FORCE ROW LEVEL SECURITY` na tabela **não salva**: FORCE sujeita o dono à
  policy, não vence `BYPASSRLS`. `conversas` tem FORCE ligado e vazou assim
  mesmo na sabotagem.

  Toda view nova sobre tabela escopada por tenant leva a opção, e o teste dela
  tem de ter a **sabotagem que a remove** — se tirar `security_invoker` não
  deixar o teste vermelho, ele não está medindo isolamento.

- **Nenhuma função plpgsql tem dependência registrada com as extensões que usa.**
  Vale para qualquer coisa em `extensions` — `unaccent`, `pg_trgm`, `pgcrypto`,
  `vector` —, não só para a que motivou a nota. plpgsql é late-binding: o corpo é
  uma string, resolvida na execução, e `pg_depend` fica **vazio** (contagem
  medida: 0).

  O efeito é que **`DROP EXTENSION` passa sem reclamar** de nenhuma função que a
  chame. Nada avisa. A função continua existindo e passa a falhar por dentro com
  `42883: function extensions.<f>(...) does not exist`, no caminho quente, para
  todo tenant. Medido em transação abortada antes de a migração 50 ser escrita —
  ninguém tinha olhado até então.

  Consequências práticas:

  - **rollback não dropa extensão.** Quem roda um rollback já está num momento
    ruim; trocar "rollback incompleto" por "catálogo de todos os clientes fora do
    ar" não é conserto. Extensão instalada e sem uso custa quase nada. Se um dia
    remover for mesmo necessário, é passo **manual e separado**, na ordem
    inversa: restaurar os corpos primeiro, conferir, depois dropar;
  - **a conferência não pode ser por memória nem por `pg_depend`.** O único lugar
    onde a dependência existe é o texto do corpo:

    ```sql
    select p.proname, n.nspname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosrc ilike '%<nome_da_funcao_da_extensao>%';
    ```

    É a mesma disciplina do `grep -rn "<coluna>" tests/ src/ supabase/ n8n/` antes
    de dropar coluna: a varredura tem de alcançar onde a referência de fato mora.

- **`DROP FUNCTION` APAGA TODOS OS GRANTS. Recriar restaura só o que o script
  listar.** É a quinta armadilha da mesma família (28, 32, 37, 40, 41) e a
  primeira cujo modo de falha **não** é ambiguidade de aridade: a chamada resolve
  certo e morre em `permission denied for function`.

  Toda `api_n8n_*` precisa de **duas** linhas, não uma:

  ```sql
  grant execute on function public.f(tipos) to service_role;
  grant execute on function public.f(tipos) to n8n_agent;
  ```

  `service_role` é o role do PostgREST/supabase-js. **O n8n não passa por ali —
  ele conecta como `n8n_agent`**, então é essa a linha que o agente usa em toda
  mensagem, e era essa que faltava. As migrações 40 e 41 saíram só com
  `service_role`: a 41 derrubou o catálogo do `emporio` na hora, e a 40 tinha
  deixado `api_n8n_ver_pedido` quebrada horas antes, sem ninguém esbarrar.

  **Verificar grant contra a lista que você espera é auto-confirmação.** A
  verificação da 41 conferiu `service_role`, `authenticated` e `anon` — os três
  que eu tinha escrito — e reportou "grants intactos". `n8n_agent` não estava na
  lista porque eu não sabia que existia. O que pega é **diff do ACL antes/depois
  do drop**, ou comparar com as funções irmãs, nunca com a própria expectativa.

  E chamar como superusuário não vale como teste: `postgres` ignora grant. A
  prova é `set local role n8n_agent` e chamar.

  **E o FILTRO da conferência é uma suposição como qualquer outra.** Em
  2026-08-24 a migração 52 saiu com `contato_exibivel` em
  `{=X/postgres, anon=X, authenticated=X}` — o laço que conferia ACL percorria
  `p.proname like 'api\_n8n\_%'`, e o helper não tem o prefixo. Não era
  vazamento (função pura, recebe texto e devolve texto, não toca no banco), mas
  ficou diferente da irmã `texto_normalizado`, de mesma natureza, criada na
  migração seguinte. É a mesma família do parágrafo acima, um nível acima:
  antes eu conferia contra a lista de roles que esperava; agora conferia a
  lista de FUNÇÕES que esperava. **Confira o que a migração cria, não o que o
  nome dela sugere** — a lista sai do arquivo, não do prefixo.

  `npm run teste:grants-n8n` varre `api_n8n_*` (não é lista fixa: função nova
  entra sozinha), exige o grant nos dois roles, confere que nenhuma abriu para
  `anon`/`authenticated` sem querer, e **chama de verdade** como `n8n_agent` —
  porque `has_function_privilege` diz o que o ACL contém e chamar diz o que
  acontece.

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

- **Três** tenants, não um. Um tenant esconde todo bug de isolamento; dois
  escondem vazamento unidirecional.
- **O teste cria os próprios tenants; não resolve seed por slug.** Até 17/08 os
  cinco de isolamento resolviam `restaurante-teste`, `sandbox-de-testes` e
  `clinica-teste` por slug — e quando dois foram soft-deletados pelo painel em
  13/08 a suíte ficou quatro dias cega. Use `tests/lib/tenants-efemeros.mjs`;
  `npm run teste:seed-independente` reprova quem voltar a citar slug de seed.
  Transação abortada (o padrão de `descontratar-preserva-dado`) é mais forte
  quando tudo passa por UMA conexão, e **não serve** quando o teste autentica por
  HTTP: outra conexão não enxerga transação não comitada.
- **Asserção negativa precisa de contraprova.** "O tenant A não vê o dado de B" é
  verdadeira por vacuidade quando B não tem dado — passa com a RLS ligada e com
  ela desligada. Semeie o conteúdo, confira que entrou, e só então afirme que o
  outro não o alcança. Duas asserções vácuas foram encontradas assim em 17/08,
  uma delas guardando o token de Chatwoot: mirava uma coluna que a migração 21
  havia removido, o select ERRAVA, `data` vinha `null`, e `(null ?? []).length
  === 0` é `true`. Seis dias verde sem executar nada.
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

  **A sabotagem não é zelo, é a única coisa que pega.** Só na semana de
  2026-08-14 ela encontrou seis defeitos que revisão não tinha achado: asserção
  tautológica comparando o resultado contra a própria implementação; sabotagem
  que não mutou nada (CRLF, e regex multi-linha com `\n` nunca casa neste repo);
  teste que pulava todos os casos e imprimia verde; prefixo `/painel` tornando a
  regra vacuosa; checagem duplicada de uma que já existia; e asserção que
  afirmava estado do mundo — escrita **quatro horas depois** de esta seção ser
  escrita, pela mesma pessoa. Ler o próprio teste não basta, e escrever a regra
  também não.

  **Em 2026-08-17 a contagem chegou a oito, e os dois novos fecham o argumento.**
  O sétimo: `tests/migracao-audio.mjs` reaplicava a migração 32 sozinha para
  provar idempotência, mas a 37 já havia substituído a assinatura — o replay de
  um elo ressuscitava a assinatura de 8 argumentos e tornava **ambígua** a chamada
  de 7 que o n8n faz. Vermelho por três dias sem defeito nenhum em produção. Se
  o teste replaya migração, replaye a **cadeia**, na ordem em que produção a viu
  (e o rollback na ordem inversa).

  O oitavo é o que vale escrever: `tests/migracao-foto-agente.mjs` afirmava que
  ninguém tinha `foto_produto` contratada, e quebrou quando a agência vendeu o
  módulo — **e veio no commit chamado "varredura de testes que afirmavam estado
  do mundo"**. A regra estava escrita, o commit era literalmente sobre ela, e o
  mesmo trabalho introduziu uma violação nova. Não é descuido de quem não leu: é
  a evidência de que **nota não protege nem quem a escreve**. O que protege é o
  teste ARRANJAR o estado que vai medir — os dois consertos de hoje setam
  `contratado` e descontratam dentro da transação revertida, em vez de confiar em
  como o banco por acaso está.

  Corolário para quando esta contagem crescer de novo: se a asserção depende de
  algo que uma pessoa pode mudar pela interface, ela não é sobre propriedade —
  ou o teste arranja aquele algo, ou está contando com sorte.

  **A contagem cresceu de novo em 2026-08-24: NOVE.** `tests/migracao-anti-loop.mjs`
  afirmava `a 53 ainda não está em produção`. Verdade quando foi escrita, falsa
  **quatro horas depois**, quando a migração foi aplicada — pelo mesmo trabalho,
  no mesmo dia. E é a segunda vez que este defeito exato aparece na entrega em
  que a regra é citada: o oitavo veio no commit chamado "varredura de testes que
  afirmavam estado do mundo", e o nono veio de uma entrega cujo próprio texto
  invocava o corolário acima.

  Não acrescenta lição nova — acrescenta a evidência de que a lição **não pega
  por leitura**, nem quando ela acabou de ser lida em voz alta. O conserto é
  sempre o mesmo e é mecânico: rodar o ROLLBACK da própria migração dentro da
  transação abortada, que é idempotente e põe o banco no estado pré-migração
  tendo ela sido aplicada ou não. Se o teste de migração não começa com o
  rollback, ele está afirmando o calendário.

  **E o CRLF derrubou uma guarda de verdade, não só uma sabotagem.** Em
  2026-08-24 o `teste:comparacoes-tipo` passou a acusar o **próprio comentário**
  que explica a armadilha que ele caça. A proteção contra auto-casamento está
  escrita e está certa; o que a matou foi o arquivo virar CRLF: `split('
')`
  deixa um `` no fim da linha, e em JavaScript **`.` não casa ``** (é
  terminador de linha), então `/\/\/.*$/` não encontra onde ancorar e não
  strippa comentário nenhum. `/\/\/.*$/.test("  // x")` é `true`;
  `.test("  // x")` é `false`.

  Ninguém editou nada — o git mudou o fim de linha (174 arquivos do repo estão
  em CRLF contra 96 em LF) e a guarda morreu **sem aparecer em diff**. Então:
  **todo varredor de arquivo usa `split(/?
/)`**, nunca `split('
')`, e a
  sabotagem que prova um varredor tem de rodar nos DOIS fins de linha. Item
  próprio em `docs/PENDENCIA-AUTOCASAMENTO-CRLF.md`.

  **E o que descobriu os três vermelhos que ninguém via não foi revisão: foi
  rodar tudo.** Em 2026-08-24, a primeira execução de todos os `teste:*` de uma
  vez achou `teste:acqua-pronta` (4 falhas), `teste:comparacoes-tipo` (1) e
  `teste:migracao-foto` (1) — nenhum deles relacionado ao que estava sendo
  entregue, todos vermelhos havia dias. O rodapé de entrega lista os testes que
  quem entrega ESCOLHE rodar, e a escolha é sempre a vizinhança da mudança. É
  estruturalmente cego para regressão à distância.

  **Limpeza de teste é escopada por tenant, sempre.** Até 2026-08-17 quatro
  limpezas rodavam sem escopo, como `service_role` (que ignora RLS): duas
  apagavam `produtos` por padrão de NOME na tabela inteira, uma apagava `pedidos`
  por `conversation_id` — que **não é único entre tenants**, e o teste de pedidos
  existe justamente para provar isso — e uma apagava o histórico de prompt
  inteiro de um cliente. O que separava o catálogo do Empório do catálogo do
  teste era o nome ser improvável. `tests/deletes-escopados.mjs` planta uma isca
  que casa com o critério de limpeza mas pertence a outro tenant, roda os testes
  de verdade e exige que ela sobreviva; tirar o filtro faz a isca morrer, o que
  foi verificado nos quatro. Padrão de nome continua útil — ele separa um teste
  do outro **dentro** dos mesmos tenants —, mas nunca é o único filtro.

  Complemento, em outra camada: `npm run guarda -- <comando>` tira um retrato
  (md5 por linha) de cada tenant antes e depois de qualquer comando e reprova se
  ele tocou tenant que não criou. **Detecta, não previne** — quando o alarme toca
  a linha já sumiu. Serve para rodar suíte nova ou script duvidoso.

  Duas exigências práticas que saíram desses casos:

  - **Confirme que a mutação entrou** antes de acreditar no resultado. Imprima
    a linha alterada, ou o md5 antes/depois. "Rodou e não falhou" com a
    sabotagem que não aplicou é falso verde — aconteceu duas vezes.
  - **Rejeição inesperada tem que virar FALHA, não crash.** `await` cru numa
    chamada que a sabotagem faz estourar derruba o processo antes das asserções
    seguintes, e você fica sem saber qual propriedade quebrou.

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

- **`npm run teste`** — a suite inteira, sequencial, ~3 minutos. Ele varre o
  `package.json` pelo prefixo `teste:`, entao teste novo entra sozinho; nao ha
  lista para manter. Rodar so os testes da vizinhanca da mudanca e o que deixou
  o `teste:retomada-pausa` tres dias vermelho enquanto quatro migracoes eram
  aplicadas, e a primeira execucao do runner achou tres vermelhos que ninguem
  via. As exclusoes sao duas, declaradas com motivo sobre a NATUREZA do script
  (nao sobre ele estar vermelho): `teste:recall` custa OpenAI por execucao,
  `teste:acqua-pronta` e relatorio e nao teste
- `npm run build` passa sem erro de tipo
- Teste de isolamento entre os 3 tenants do seed passa
- Nenhuma `service_role` key em código client
- Migração tem rollback escrito
