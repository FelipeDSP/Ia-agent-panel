# Auditoria de Memória — leaks, estado global e objetos de longa duração

> Data: **2026-08-06**. Análise **teórica**, por inspeção de código: varredura de estado
> mutável de módulo, timers, listeners, ciclo de vida de conexões e acumuladores, mais
> estimativa de alocação de pico do pipeline de ingestão. **Nenhum profiler foi rodado** —
> os números de MB são cálculo, não medição. Nada foi alterado.

## Resumo

**Não foi encontrado nenhum memory leak.** E, diferente do que costuma acontecer, isso é
verificável em poucas linhas:

| Verificação | Resultado |
|---|---|
| `let`/`var` no topo de módulo (estado global mutável) | **zero em todo o repositório** |
| Timers sem `clearInterval`/`clearTimeout` | **zero** |
| Listeners sem `removeEventListener` | **zero** |
| `setState` acumulativo (`prev => [...prev, x]`) | **zero** |
| Recursão (crescimento de stack) | **zero** (ver `AUDIT-COMPLEXIDADE.md`) |
| Conexões `pg` não fechadas | **zero** na prática (ver §3) |
| Cache global que cresce | **nenhum** |

O único estado de módulo do projeto são **3 `Set` e 1 `Record` constantes**, todos
somente-leitura, todos com um punhado de entradas. Não há cache, memoização, pool caseiro,
nem singleton mutável em lugar nenhum — que são as quatro origens usuais de vazamento em
app Next.

**O que existe é outra coisa, e não é leak: o pipeline de ingestão é inteiramente
bufferizado.** A memória de pico da Edge Function cresce linear com o tamanho do texto
extraído, e o limite que existe hoje (10 MB) é sobre o **arquivo**, não sobre o texto —
duas grandezas que podem diferir por uma ordem de magnitude. É a §4, e é o único item
desta auditoria que merece ação.

---

## 1. Estado global — o que persiste entre requests

### No servidor Next

**Nada.** Não há uma única variável mutável de módulo em `src/`. Todo estado vive no
Postgres ou no ciclo de vida do request:

- `criarClienteServidor()` cria um cliente novo por request e o entrega ao GC no fim. Não
  há cliente compartilhado entre requests — o que é o correto, porque o cliente carrega os
  cookies de sessão **daquele** usuário. Um singleton aqui seria vazamento de sessão entre
  tenants, não só de memória.
- `criarClienteAdmin()` idem, criado sob demanda dentro das Server Actions de super_admin.

Os três objetos de módulo são tabelas de consulta imutáveis:

| Objeto | Onde | Tamanho |
|---|---|---|
| `ATIVO` (`Set`) | `painel/conhecimento/componentes.tsx:42` | 2 strings |
| `STATUS_VALIDOS` (`Set`) | `painel/conversas/acoes.ts:11` | 3 strings |
| `REGISTRO_TOOLS` (`Record`) | `lib/tools/registro.ts:14` | 2 entradas |

Nenhum é escrito depois da definição. Custo total desprezível e constante.

### Na Edge Function

O isolate Deno é **reaproveitado entre invocações**, então o que está no topo do módulo
sobrevive a várias ingestões. Há exatamente um objeto assim:

```ts
// index.ts:66 — único objeto de longa duração do projeto
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
```

É o padrão certo: criar o cliente por invocação desperdiçaria handshake a cada job. E é
seguro — `persistSession: false` e `autoRefreshToken: false` garantem que ele não acumula
estado de sessão nem agenda timer de refresh. Todo o resto no topo do arquivo é escalar
(`ALVO_CHARS`, `DIMENSAO`, chaves de env).

### No browser

Nenhum estado de módulo. Os componentes client guardam só `useState` de tamanho limitado
pelos dados do tenant, e nenhum deles acumula — o polling faz `setJobs(atuais)`
(substitui), nunca `setJobs(prev => [...prev, ...])`.

## 2. Timers e listeners — todos com cleanup

Três no projeto inteiro, todos corretos:

```tsx
// conhecimento/componentes.tsx:244 — polling de progresso
const timer = setInterval(async () => { … }, 2500);
return () => { vivo = false; clearInterval(timer); };
```

Além do `clearInterval`, a flag `vivo` impede `setState` depois do unmount — o callback
async pode resolver quando o componente já saiu. É a segunda metade do cleanup, a que
costuma faltar. O efeito ainda depende de `temAtivo`, então o timer nem é criado quando
não há job em andamento.

```tsx
// sidebar.tsx:82-86  e  :94-96
mq.addEventListener('change', sincronizar);
return () => mq.removeEventListener('change', sincronizar);

window.addEventListener('keydown', aoTeclar);
return () => window.removeEventListener('keydown', aoTeclar);
```

O `setTimeout` em `lib/supabase/admin-usuarios.ts:17` é o `espera(ms)` do retry — vive
dentro de uma Promise que sempre resolve. Não retém nada.

## 3. Conexões `pg` nos scripts

`import-producao.mjs` fecha as duas pontas em `finally` (`:605-607`) — correto mesmo em
caso de erro no meio da importação.

`teste-recall.mjs` chama `client.end()` só no caminho feliz (`:123`), fora de `finally`.
Isso **parece** um vazamento — uma conexão aberta mantém o event loop vivo e o processo
pendurado. Não é: tanto `abortar()` (`:39`) quanto o `main().catch()` do fim do arquivo
chamam `process.exit(1)`, então o processo sempre termina e o SO recolhe o socket. Vale
saber que a garantia vem do `process.exit`, não do código de limpeza — se alguém remover o
`exit` para deixar o script retornar código de saída naturalmente, aí vira pendura.

## 4. O pipeline de ingestão — alocação de pico, não vazamento

Este é o único ponto com uso de memória relevante, e a distinção importa: **nada fica
retido depois do job**; o problema é quanto se aloca *durante*.

A função acumula todos os chunks com seus vetores num array e só então faz **uma** chamada
RPC:

```ts
// index.ts:258-285
const linhas: { text; embedding: number[]; chunk_index; metadata }[] = [];
for (let i = 0; i < pedacos.length; i += LOTE_EMBEDDING) { … linhas.push(…) }
await admin.rpc('kb_reindex_documento', { p_chunks: linhas });
```

Isso é **deliberado e correto**: o swap é atômico (delete físico + insert na mesma
transação), e é o que garante que um reprocessamento nunca deixe o tenant com meio
documento indexado. Streamar os inserts quebraria o invariante. O custo é que o documento
inteiro, vetorizado, precisa caber na memória de uma vez.

### Estimativa por chunk

| Item | Cálculo | Tamanho |
|---|---|---|
| `embedding` | 1536 doubles (`PACKED_DOUBLE_ELEMENTS`) × 8 B | **~12,3 KB** |
| `text` | ~450 chars UTF-16 | ~0,9 KB |
| `metadata` + overhead do objeto | — | ~0,2 KB |
| **retido, por chunk** | | **~13,4 KB** |
| serialização JSON do RPC | 1536 floats × ~19 chars | **~29 KB** transitórios |

O pico acontece no instante do `rpc()`, quando `linhas` e a string JSON coexistem:
**~42 KB por chunk**.

### O que isso dá em documento real

| Documento | Chunks (passo 330) | Pico estimado |
|---|---|---|
| PDF de 50 páginas (~100 mil chars) | ~300 | **~13 MB** ✅ |
| ~1 milhão de chars | ~3.000 | **~127 MB** ⚠️ |
| `.txt` de 10 MB (o limite atual) | **~30.000** | **~1,2 GB** ❌ |

O caso documentado no `CLAUDE.md` (PDF de 50 páginas, 30-60 s) é confortável. O terceiro
não é: Edge Functions do Supabase rodam com teto de memória na casa das centenas de MB, e
o job morreria por OOM depois de já ter feito ~1.500 chamadas pagas à OpenAI.

### Por que o limite de 10 MB não protege

```ts
// painel/conhecimento/acoes.ts:50 — na Server Action, não na Edge Function
if (arquivo.size > LIMITE_BYTES) { … }   // 10 MB
```

Três lacunas:

1. **O limite é sobre bytes do arquivo; a memória escala com chars do texto extraído.**
   Para `.txt` a razão é ~1:1 (10 MB → 10 M chars → ~30 mil chunks). Para **DOCX é muito
   pior**: é XML zipado, e 10 MB de DOCX podem virar dezenas de milhões de caracteres.
2. **A Edge Function não repete a checagem.** Ela recebe um `job_id`, baixa por path do
   Storage e processa o que vier. O guard mora só no caminho do painel.
3. **Não há teto de número de chunks** em lugar nenhum do pipeline.

O caminho de texto colado, em contraste, **está protegido**: `ingerirTexto` corta em
50.000 chars (`acoes.ts:120`), o que dá ~152 chunks e ~6 MB de pico. O raciocínio
registrado ali é sobre timeout, não memória, mas o efeito protege as duas coisas.

### Composição com o achado do chunker

Isto agrava o item da `AUDIT-COMPLEXIDADE.md` §3 e tem a mesma raiz. O número de chunks é
`len / (ALVO − OVERLAP)`; um `CHUNK_OVERLAP_CHARS` mal configurado reduz o denominador e
multiplica **tanto o custo em chamadas à OpenAI quanto a memória de pico**. Com
`OVERLAP = ALVO − 1` o passo vira 1, e mesmo um documento pequeno estoura. **Um piso no
passo resolve os dois sintomas de uma vez.**

## 5. Sugestão

| # | Ação | Efeito |
|---|---|---|
| 1 | Piso no passo do chunker (`ALVO − OVERLAP ≥ ALVO/4`) | limita chunks **e** memória; já sugerido em `AUDIT-COMPLEXIDADE.md` |
| 2 | Teto de chunks por job na Edge Function (ex.: 5.000) com erro claro no `jobs_ingestao` | falha barata e legível em vez de OOM depois de gastar OpenAI |
| 3 | Repetir a checagem de tamanho **dentro** da Edge Function, sobre o texto extraído | fecha o caminho que não passa pelo painel |
| 4 | Se o teto atrapalhar documentos legítimos: inserir em lotes dentro de **uma** transação SQL | preserva a atomicidade sem buffer único |

Os itens 1 e 2 são poucas linhas e cobrem o cenário realista. O 4 só vale a pena se
aparecer um cliente com documento grande de verdade.

---

## Método

`grep` por `^let`/`^var`/`^const … = new Map|Set|[]` para estado de módulo;
`setInterval|setTimeout|addEventListener|subscribe|matchMedia` para timers e listeners,
com leitura do `return` de cada `useEffect`; `new Client|Pool|.end()|finally` para
conexões; `set[A-Z]…(prev => [...` para acumulação em estado React. Estimativas de bytes
derivadas da representação de arrays de double na V8 e do tamanho da serialização JSON —
**cálculo, não medição**. Confirmar com o painel de execução da Edge Function antes de
dimensionar o teto do item 2.
