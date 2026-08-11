# Auditoria de Complexidade — loops, recursão e operações pesadas

> Data: **2026-08-06**. Varredura de todos os `for`/`while`/`.map`/`.reduce`, detecção de
> recursão e leitura das funções que fazem trabalho real, em `src/`, `scripts/`, `tests/`
> e a Edge Function. Complementa [`AUDIT-PERFORMANCE.md`](AUDIT-PERFORMANCE.md), que mediu
> o banco; aqui o foco é o **código**. Nada foi alterado.

## Resumo

**Não existe problema algorítmico neste projeto, e não é por sorte.** Os números:

- **Zero recursão.** Nenhuma função do projeto chama a si mesma, direta ou
  indiretamente. Não há risco de stack overflow em lugar nenhum.
- **Zero O(n²).** Nenhum loop aninhado sobre a mesma coleção; nenhum `.find()`/`.includes()`
  dentro de `.map()`/`.filter()` sobre dados de tamanho variável. As duas agregações do
  app usam `Map` (O(n)) onde o caminho ingênuo seria busca aninhada.
- **Das 131 funções exportadas, ~105 são O(1)** — componentes de render, wrappers de
  cliente Supabase, formatadores. A tabela abaixo cobre só as ~25 que fazem trabalho.

**O custo real deste sistema não é CPU, é I/O.** Toda função "pesada" é pesada por
round-trip de rede ou volume de linha transferida, não por trabalho computacional. Por
isso a análise útil não é O(n) de instruções e sim **O(n) de idas ao banco / à OpenAI** —
é assim que a tabela da §2 está organizada.

Dois achados que merecem ação, ambos de escala e nenhum urgente:

1. **`PaginaConhecimento` transfere O(chunks) para renderizar O(documentos).** É a query
   que cresce mais rápido do painel.
2. **O custo da ingestão é inversamente proporcional a `ALVO − OVERLAP`.** O loop infinito
   já está protegido, mas um `CHUNK_OVERLAP_CHARS` mal configurado ainda multiplica o
   número de chunks e de chamadas à OpenAI por centenas — sem erro nenhum.

---

## 1. O que foi procurado e não existe

| Padrão | Resultado |
|---|---|
| Recursão (função que se invoca) | **nenhuma** em todo o repositório |
| Loop aninhado sobre a mesma coleção | **nenhum** em `src/` |
| `.find`/`.some`/`.includes` dentro de `.map`/`.filter` sobre dado variável | **nenhum** |
| Concatenação de string em loop sem limite | **nenhuma** (ver §3, o acumulador é limitado) |
| `await` dentro de `for` no caminho do usuário | **nenhum** em `src/` (só em `scripts/`, §4) |

As duas únicas ocorrências de `includes` dentro de `filter` estão em
`scripts/import-producao.mjs:186,196`, sobre `COLUNAS_DOCUMENTOS` e `MAPA_CONVERSAS` —
arrays constantes de ~10 elementos. É O(k·m) com k e m fixos em código: O(1) na prática.

## 2. Complexidade por função

`n` = linhas retornadas · `C` = chunks do tenant · `D` = documentos · `T` = tenants ·
`RT` = round-trips (a métrica que importa).

### Caminho do usuário — `src/app/`

| Função | Tempo (CPU) | I/O | Nota |
|---|---|---|---|
| `PaginaTenants` (`admin/tenants/page.tsx:29`) | O(T) | **O(T) RT**, profundidade 1 | `2T+1` queries via `Promise.all` — paralelas, então a latência não cresce, mas o número de conexões sim |
| `PaginaConhecimento` (`painel/conhecimento/page.tsx:15`) | O(C) | 1 RT, **O(C) linhas** | ⚠️ ver §3 |
| `PaginaCatalogo` (`admin/catalogo/page.tsx:14`) | O(n+m) | 2 RT paralelos | contagem por `Map`, não por busca aninhada — correto |
| `PaginaConsumoAdmin` / `PaginaConsumoTenant` | O(meses) | 1–2 RT | agregação delegada às RPCs `billing_*` (GROUP BY em SQL) — o padrão certo |
| `PaginaConversa`, `PaginaConversas`, `PaginaPainel`, `PaginaConfiguracoes` | O(n) | 1–2 RT | listagem simples |
| `GestaoConhecimento` (`componentes.tsx:200`) | O(jobs) por tick | **1 RT / 2,5 s** enquanto houver job ativo | `setInterval` desliga sozinho quando nenhum job está ativo; ~24 requests numa ingestão de 60 s |
| demais 26 componentes client + 20 `ui/*` | O(props) | — | render puro |

### Núcleo — `src/lib/`

| Função | Tempo | I/O |
|---|---|---|
| `obterUsuarioAtual` (`auth.ts:19`) | O(1) | **2 RT** (`getUser` + perfil) — executa em toda página e toda action |
| `exigirUsuario` / `exigirSuperAdmin` / `exigirTenantAdmin` | O(1) | herda os 2 RT acima |
| `validarCriacaoTenant`, `validarEdicaoTenantAdmin`, `validarConfigTenantSuper` | O(campos) | **0** — puras |
| `validarTransferirCliente` / `validarTransferirAgencia` | O(campos) | **0** — puras |
| `normalizarSlug` (`schema.ts:25`) | O(len) | 0 — regex linear, sem backtracking |
| `formatarDestino` / `numeroParaExibir` | O(len) | 0 |
| `definicaoTool` (`registro.ts:33`) | O(1) | 0 — lookup em objeto literal |
| `acharPorEmail` (`admin-usuarios.ts:52`) | O(tentativas) | **O(tentativas) RT sequenciais** — retry com espera, por desenho |
| `criarClienteServidor/Browser/Admin`, `atualizarSessao` | O(cookies) | 0–1 RT |
| `cn`, `formatarData`, `formatarDataHora` | O(classes) / O(1) | 0 |

### Server Actions

As 31 são O(1) em CPU. O custo é o número de queries: 1–2 para as de escrita simples,
3–4 para as que validam antes de gravar. `subirArquivo` e `ingerirTexto` adicionam 1
upload ao Storage + 1 invocação da Edge Function (assíncrona — não bloqueiam a resposta).

### Edge Function — `processar-ingestao`

O único trabalho computacional de verdade do sistema.

| Etapa | Tempo | I/O |
|---|---|---|
| `extrairTexto` (PDF via unpdf / DOCX via mammoth) | O(bytes) | 1 download do Storage |
| `chunk` (`index.ts:112`) | **O(len)** | 0 — ver §3 |
| `embeddarLote` (`:167`) | O(lote) | **1 RT à OpenAI**, até 3 tentativas com backoff |
| laço de embedding (`:261`) | O(C) | **⌈C/20⌉ RT à OpenAI + ⌈C/20⌉ UPDATE** de progresso |
| `kb_reindex_documento` (RPC) | — | **1 RT** — delete+insert num swap transacional |
| `segredoConfere` (`:323`) | O(len) | 0 — comparação de tempo constante, intencionalmente sem short-circuit |

O laço de embedding é o gargalo e está **corretamente em lote**: 20 chunks por request.
Um PDF de 50 páginas (~300 chunks) são 15 chamadas à OpenAI, não 300. O que dobra o
custo de I/O é o `UPDATE` de progresso por lote — 15 escritas extras para alimentar a
barra de progresso do painel. É uma troca consciente de round-trips por feedback, e a
20:1 ela se paga.

### Busca vetorial

Já documentada no `CLAUDE.md` e medida com `explain (analyze, buffers)`: o planner
descarta o HNSW global e resolve por `idx_kb_origem`, ordenando os vetores do tenant em
memória. **O(C) por consulta**, recall perfeito, 33 ms com 158 chunks. Linear no tamanho
da base *daquele* cliente — é o que vira gargalo primeiro, a alguns milhares de chunks
por tenant. Os dois caminhos de conserto que preservam recall estão no `CLAUDE.md`.

## 3. O chunker — a única função com complexidade não trivial

```ts
// index.ts:139-145
let i = 0;
while (i < par.length) {
  const fim = Math.min(i + ALVO_CHARS, par.length);
  pedacos.push(par.slice(i, fim).trim());
  if (fim >= par.length) break;
  i = fim - OVERLAP_CHARS;          // passo = ALVO − OVERLAP
}
```

**Tempo O(len).** O acumulador `atual` do outro ramo é descarregado sempre que passa de
`ALVO_CHARS`, então nunca cresce além de ~2×ALVO — a concatenação repetida não vira O(n²).

**O que não é linear é o tamanho da saída:**

```
chunks ≈ len / (ALVO_CHARS − OVERLAP_CHARS)
```

O denominador é configurável por env. Se `OVERLAP ≥ ALVO`, o passo fica ≤ 0 e o `while`
nunca avança — **loop infinito**. Isso **já está protegido**, na linha 48, com o comentário
nomeando exatamente essa falha:

```ts
const OVERLAP_CHARS = Math.min(envInt('CHUNK_OVERLAP_CHARS', 120), ALVO_CHARS - 1);
```

⚠️ **Mas o guard garante terminação, não custo.** Ele força o passo a ser ≥ 1, e no pior
caso permitido o passo *é* 1:

| `CHUNK_OVERLAP_CHARS` | passo | chunks de um doc de 100 kB | requests à OpenAI |
|---|---|---|---|
| 120 (padrão) | 330 | ~303 | 16 |
| 400 | 50 | ~2.000 | 100 |
| 449 | **1** | **~100.000** | **5.000** |

Uma variável de ambiente digitada errado transforma um job de 16 chamadas em um de 5.000,
grava 100 mil linhas em `kb_documentos` e destrói o recall — **sem erro, sem log, sem
timeout óbvio**. É a mesma classe de falha silenciosa que o `CLAUDE.md` descreve para o
`hnsw.iterative_scan`. Um piso no passo (`ALVO − OVERLAP ≥ ALVO/4`, digamos) fecharia isso
com uma linha.

## 4. `scripts/` — O(n) round-trips sequenciais, e tudo bem

`import-producao.mjs` faz **um `INSERT` por linha** dentro de `for (const r of rows)`
(`:342` para chunks, `:424` para conversas) — O(n) round-trips sequenciais, sem lote. Para
os volumes reais (158 chunks, 74 conversas) são segundos. É script de migração one-shot,
roda uma vez por cliente importado; agrupar em `INSERT ... VALUES` múltiplos seria
otimização sem demanda.

`teste-recall.mjs:90` faz 1 embedding + 1 query por pergunta, sequencial — O(perguntas)
RT. São 5 perguntas. `uuidV5` é O(len) de SHA-1, chamado uma vez por linha importada.

Os três testes de isolamento fazem O(tenants × recursos) queries por desenho — é o
propósito deles (provar que B não vê o dado de A exige tentar).

---

## Sugestão de ordem

| # | Item | Quando vira problema | Custo |
|---|---|---|---|
| 1 | Piso no passo do chunker (§3) | já — é um typo de env | 1 linha |
| 2 | `PaginaConhecimento`: trocar o `select` de chunks por RPC com `GROUP BY origem` | alguns milhares de chunks/tenant | ~30 min + teste |
| 3 | `PaginaTenants`: `2T+1` → uma RPC agregando | algumas dezenas de tenants | ~1 h (já previsto em comentário no código) |
| 4 | Índice HNSW parcial por tenant ou `iterative_scan = relaxed_order` | milhares de chunks/tenant | ver `CLAUDE.md`; **re-rodar `npm run teste:recall`** |

Nada aqui é urgente com o volume atual (158 chunks, 6 tenants, 69 conversas). O item 1 é o
único que não depende de crescimento — depende só de alguém editar uma env.
