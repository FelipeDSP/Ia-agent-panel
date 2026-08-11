# Benchmark Teórico — abordagens alternativas e trade-offs

> Data: **2026-08-06**. Comparação de desenho, não medição de relógio. A unidade aqui é
> **round-trip de rede** — contável a partir do código, portanto verificável. Onde aparece
> milissegundo, é número que o projeto já mediu (citado com a fonte); em nenhum lugar
> inventei latência. Nada foi alterado.

## Por que round-trips e não milissegundos

Todo caminho quente deste projeto é dominado por I/O, não por CPU
([`AUDIT-COMPLEXIDADE.md`](AUDIT-COMPLEXIDADE.md)). Num sistema assim, "quantas vezes
esperamos a rede" é a métrica que prediz a latência; o resto é ruído. Round-trip dá para
contar lendo o código e conferir depois. Milissegundo, sem profiler rodando contra o banco
de produção, seria chute com aparência de rigor.

Cada comparação abaixo traz uma coluna **Legibilidade** com o custo em complexidade de
leitura, porque em vários casos a versão atual é a certa justamente por ser a mais óbvia.

---

## 1. Caminho de autenticação — o achado principal

**É o caminho mais quente do sistema:** 18 arquivos em `src/app/` chamam `exigir*`, e o
layout chama de novo em cima. Contando os round-trips de **um** carregamento de
`/painel/conhecimento` por um `tenant_admin`:

| # | Onde | Chamada | RT |
|---|---|---|---|
| 1 | `middleware.ts` | `getUser()` | 1 auth |
| 2 | `(app)/layout.tsx` → `exigirUsuario` | `getUser()` | 1 auth |
| 3 | idem → liveness do tenant | `select deletado_em, ativo from tenants` | 1 DB |
| 4 | `(app)/layout.tsx` | `select nome from tenants` | 1 DB |
| 5 | `conhecimento/page.tsx` → `exigirTenantAdmin` | `getUser()` | 1 auth |
| 6 | idem → liveness do tenant **de novo** | `select deletado_em, ativo from tenants` | 1 DB |
| 7 | `conhecimento/page.tsx` | query dos chunks | 1 DB |

**Total: 7 round-trips, dos quais 3 são redundantes** — o segundo e o terceiro `getUser()`
revalidam o mesmo token no mesmo request, e a liveness roda duas vezes. Pior: a linha lida
no passo 3 é **a mesma linha** do passo 4; falta só uma coluna no `select`.

| Abordagem | RT | Legibilidade | Segurança | Veredito |
|---|---|---|---|---|
| **A. Atual** | 7 | ✅ trivial — cada função busca o que precisa | ✅ máxima | correta, mas paga caro por clareza |
| **B. `cache()` do React em `obterUsuarioAtual`** | **4** | ✅ um import, zero mudança de semântica | ✅ idêntica | **recomendada** |
| **C. B + fundir liveness e `nome` num `select`** | **3** | 🟡 acopla o dado da sidebar ao guard de auth | ✅ idêntica | boa, mas só depois de B |
| **D. Confiar só no JWT (sem liveness)** | 2 | ✅ mais simples | ❌ tenant excluído/suspenso mantém acesso até o JWT expirar | **rejeitada** — o código já rejeita, com comentário |
| **E. `getSession()` no lugar de `getUser()`** | 1 | ✅ | ❌❌ aceita cookie forjado | **proibida** pelo `CLAUDE.md` |

**Por que B é a escolha.** `import { cache } from 'react'` memoiza por request: layout e
página passam a compartilhar uma execução de `obterUsuarioAtual` em vez de duas. Some 3 RT
por navegação sem alterar uma linha de lógica — o corpo da função fica idêntico, só
embrulhado. É o caso raro em que performance e legibilidade não se opõem: não há trade-off
a discutir, só um `cache()` faltando.

Duas ressalvas honestas: (1) o `getUser()` do middleware **não** é deduplicado — é outro
processo, então o piso é 4, não 3; (2) `cache()` vale dentro de um render, não entre Server
Actions — cada action continua pagando os seus 2 RT, o que está certo, porque uma action
precisa mesmo revalidar.

D e E ficam aqui só para registrar que foram consideradas e por que não passam. O
comentário nas linhas 53-57 de `auth.ts` já explica a de baixo: sem a liveness, o admin de
um cliente "excluído" continuaria logando.

## 2. Busca vetorial

O `CLAUDE.md` já documenta o estado atual e as saídas. O que falta é a comparação lado a
lado, com o custo de cada uma:

| Abordagem | Recall | Custo de busca | Custo de manutenção | Legibilidade |
|---|---|---|---|---|
| **A. HNSW global + filtro de tenant (atual)** | ✅ **perfeito** | O(chunks do tenant) — **33 ms com 158 chunks** (medido, `CLAUDE.md`) | ✅ zero | ✅ um índice, nada a explicar |
| **B. HNSW parcial por tenant** | ✅ perfeito | ~O(log n) | ❌ **um índice por cliente** — provisionamento vira passo de onboarding | 🟡 exige entender por que há N índices |
| **C. `iterative_scan = relaxed_order`** | ✅ preserva o `limit` | melhor que A, pior que B | ✅ um `set` | 🟡 comportamento não óbvio para quem lê |
| **D. `iterative_scan = off` + forçar HNSW** | ❌ **devolve menos que o `limit`, calado** | melhor | ✅ | ❌ armadilha |
| **E. IVFFlat** | 🟡 aproximado, exige `lists` calibrado | boa | ❌ recalibrar conforme cresce | 🟡 |

**A é a escolha certa hoje e continuará sendo por um bom tempo.** O ponto que o
`CLAUDE.md` faz merece repetição num documento de benchmark: **D parece a otimização óbvia
e é a pior opção da tabela** — ganha velocidade devolvendo menos resultados sem erro
nenhum, e o agente responde sem base de conhecimento com log limpo.

Entre B e C, quando chegar a hora: C custa uma linha, B custa um índice por cliente. Eu
começaria por C. Nos dois casos vale a regra do `CLAUDE.md` — `npm run teste:recall` antes
e depois, comparando números.

## 3. Agrupamento de documentos (`PaginaConhecimento`)

Hoje: busca **todos os chunks** do tenant e agrupa por `origem` num `Map` em JS.

| Abordagem | RT | Linhas trafegadas | Legibilidade | Quando adotar |
|---|---|---|---|---|
| **A. Atual — fetch-all + `Map`** | 1 | **O(chunks)** | ✅ o agrupamento está à vista no componente | até ~1.000 chunks/tenant |
| **B. RPC com `GROUP BY origem`** | 1 | **O(documentos)** | 🟡 lógica migra para SQL, longe do render | quando A doer |
| **C. Tabela `documentos` de verdade** | 1 | O(documentos) | ✅ modelo mais honesto — hoje "documento" é uma ficção derivada | mudança de schema; alto custo, n8n envolvido |
| **D. View materializada** | 1 | O(documentos) | ❌ refresh a agendar, dado defasado | não compensa nesta escala |

A troca A→B é a de melhor relação neste documento depois do `cache()`: mesmo número de
round-trips, mas para de arrastar 70 (hoje) ou 50.000 (depois) linhas pela rede para
renderizar uma lista de ~10 itens. O preço é o de sempre ao empurrar lógica para o banco:
some do arquivo que você está lendo. Com o comentário certo na RPC, é preço justo.

C é a resposta "correta" de modelagem — a base não tem tabela de documento, o documento é
o conjunto de chunks que compartilham `origem` — mas mexe em `kb_documentos`, que o n8n lê.
Não vale o risco pelo ganho.

## 4. Contagens da lista de tenants

Hoje: `2T+1` queries, todas em `Promise.all`.

| Abordagem | RT (profundidade) | Conexões | Legibilidade |
|---|---|---|---|
| **A. Atual — `2T+1` paralelo** | **1** (paralelo) | **O(T)** simultâneas | ✅ óbvia |
| **B. RPC única com `GROUP BY`** | 1 | 1 | 🟡 SQL a mais |
| **C. Contadores denormalizados + trigger** | 1 | 1 | ❌ dois lugares para o mesmo número; risco de divergir |

Detalhe que muda a leitura: como o `Promise.all` paraleliza, **a latência de A não cresce
com o número de tenants** — o que cresce é o número de conexões simultâneas ao pooler. O
gargalo não é o usuário esperando, é o pool saturando. Isso empurra a urgência de B para
mais longe do que o "N+1" sugere. O próprio código já antecipa a troca num comentário.

C é o clássico que parece esperto e envelhece mal: todo `INSERT`/`DELETE`/soft-delete de
chunk passa a ter que acertar o contador, e o dia em que uma migração mexer em
`kb_documentos` por fora, o número mente sem avisar.

## 5. Persistência da ingestão

Hoje: acumula tudo em memória e faz **uma** RPC atômica (delete físico + insert).

| Abordagem | Memória de pico | Atomicidade | Legibilidade |
|---|---|---|---|
| **A. Atual — buffer único + RPC** | **O(chunks)** — ~42 KB/chunk ([`AUDIT-MEMORIA.md`](AUDIT-MEMORIA.md)) | ✅ total | ✅ uma chamada, um invariante |
| **B. Lotes dentro de uma transação** | O(lote) — constante | ✅ total | 🟡 controle de transação explícito na função |
| **C. Insert por lote, sem transação** | O(lote) | ❌ **quebra o invariante** — falha no meio deixa meio documento | ✅ |
| **D. Staging table + swap final** | O(1) na função | ✅ total | ❌ tabela extra, limpeza de resíduo |

**A está certa pelo motivo certo** — a atomicidade do swap é o que impede um
reprocessamento de deixar o tenant com meio documento indexado, e essa garantia vale mais
que a memória. C é a "otimização" que troca uma garantia por RAM: rejeitar.

B é o upgrade natural **se e quando** um documento grande aparecer. Antes disso, os dois
guard-rails baratos da `AUDIT-MEMORIA.md` (piso no passo do chunker, teto de chunks por
job) cobrem o caso realista por muito menos trabalho.

## 6. Progresso do job

Hoje: `setInterval` de 2,5 s enquanto houver job ativo, desligando sozinho.

| Abordagem | RT durante 60 s de ingestão | Complexidade | Legibilidade |
|---|---|---|---|
| **A. Atual — polling 2,5 s** | ~24 | ✅ nenhuma | ✅ 20 linhas com cleanup correto |
| **B. Supabase Realtime** | ~1 (websocket) | ❌ conexão a gerenciar, RLS no canal, reconexão | ❌ |
| **C. SSE de rota própria** | 1 | ❌ rota + conexão longa (ruim em serverless) | 🟡 |
| **D. Polling com backoff (2 s → 10 s)** | ~12 | ✅ baixa | ✅ |

**A ganha**, e por larga margem, porque o número que importa não é 24 requests — é **24
requests durante um evento raro e explicitamente iniciado pelo usuário**. B compra uma
redução de tráfego irrelevante ao preço de uma conexão persistente com autorização própria.
D é uma micro-otimização honesta se algum dia incomodar; hoje trocaria feedback responsivo
por nada.

## 7. Validação de formulário

Hoje: leitura manual de `FormData` nas 6 funções `validar*`, puras, sem dependência.

| Abordagem | Bundle | Legibilidade | Segurança de tipo |
|---|---|---|---|
| **A. Atual — manual** | **0 kB** | 🟡 verbosa, repete `String(fd.get(x) ?? '').trim()` | 🟡 tipo afirmado à mão |
| **B. Zod** | ~14 kB | ✅ declarativa, mensagem embutida | ✅ tipo **derivado** do schema |
| **C. Zod só no servidor** | 0 kB no cliente | ✅ | ✅ | 

Este é o único caso do documento em que a alternativa vence em legibilidade e **perde** em
performance — o inverso de todos os outros. E mesmo assim eu ficaria em A por ora, por dois
motivos específicos deste projeto: `MODELOS_PERMITIDOS` é importado pelo formulário client
(`schema.ts:4` documenta), então B arrastaria Zod para o bundle a menos que se faça C; e a
`AUDIT-COBERTURA.md` mostra que essas funções têm **zero testes** — trocar a implementação
de uma regra não testada, cuja violação quebra o agente em produção (o `modelo` não tem
`CHECK` no banco), é fazer na ordem errada. **Teste primeiro, refatore depois.**

---

## Consolidado

| # | Troca | Ganho | Risco | Esforço |
|---|---|---|---|---|
| 1 | `cache()` em `obterUsuarioAtual` | **7 → 4 RT** por página | **nenhum** — semântica idêntica | ~15 min |
| 2 | Fundir liveness + `nome` do tenant | 4 → 3 RT | baixo | ~20 min |
| 3 | `PaginaConhecimento` → RPC `GROUP BY` | O(chunks) → O(docs) trafegados | baixo | ~30 min |
| 4 | Guard-rails do chunker (passo mínimo + teto) | fecha custo e memória | nenhum | ~20 min |
| 5 | `iterative_scan = relaxed_order` | busca vetorial | **médio — re-rodar `teste:recall`** | ~30 min |
| — | Zod, Realtime, contadores denormalizados, staging table | — | — | **não fazer agora** |

O item 1 é o único que eu chamaria de óbvio: reduz o caminho mais executado do sistema em
43% dos round-trips, sem alterar comportamento, sem alterar leitura. Os demais são
condicionais a crescimento que ainda não aconteceu — com 158 chunks e 6 tenants, nada aqui
é urgente.

**A conclusão geral desta comparação é que as escolhas atuais estão certas quase sempre, e
por razões articuladas nos comentários do próprio código.** O padrão que aparece nas sete
seções é o mesmo: a alternativa mais rápida costuma comprar velocidade com uma garantia
(recall silencioso na §2, atomicidade na §5, revalidação de token na §1) — e este projeto
tem consistentemente recusado essa troca. A exceção é a §1, onde havia round-trip
redundante puro, sem garantia nenhuma pendurada nele.

---

## Método

Round-trips contados por leitura do código, seguindo cada `await` que cruza processo
(`getUser` bate no servidor de auth; toda query PostgREST é HTTP). Os 33 ms da busca
vetorial vêm do `explain (analyze, buffers)` registrado no `CLAUDE.md` (2026-08-05, 158
chunks); os tamanhos de bundle de Zod são a ordem de grandeza publicada, não medição local.
Nenhuma outra latência foi estimada. As alternativas rejeitadas estão listadas com o motivo
para que a próxima pessoa não precise reconsiderá-las do zero.
