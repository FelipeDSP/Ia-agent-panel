# Auditoria de Confiabilidade / Modos de Falha — ChatYou · IA

> Investigação apenas — **nada corrigido**. Baseado em leitura do código (actions,
> `lib/{ingestao,n8n,chatwoot}.ts`, Edge Function `processar-ingestao`) e das migrations/
> funções no banco. Data: 2026-08-04.

## TL;DR
O caminho crítico de ingestão é surpreendentemente robusto (retry com backoff, swap
atômico, timeouts nas chamadas a Chatwoot/n8n, `erro_msg` visível). Os modos de falha
reais são: **jobs presos em `processando`** quando a função serverless morre, **billing
não-idempotente** (retry duplica), **ausência de error boundaries** no front, **sem
timeout** na invocação da Edge Function no caminho síncrono, e **observabilidade fraca**.

## O que está BOM (confirmado)
- **Retry + backoff** na chamada à OpenAI: `embeddarLote` tenta 3x com `500ms×tentativa` (`index.ts:167-202`).
- **Swap atômico** de chunks: `kb_reindex_documento` (DELETE por `tenant+origem` + INSERT numa transação) — nunca deixa geração parcial.
- **Timeouts** em chamadas externas do app: Chatwoot `AbortSignal.timeout(10s)` (`chatwoot.ts:56`), n8n `15s` (`n8n.ts:59`), ambos com tratamento gracioso.
- **Limpeza de órfão**: `subirArquivo` remove o arquivo do Storage se o INSERT do job falhar (`conhecimento/acoes.ts:84-86`).
- **Lock de concorrência** exemplar: `agendar_podcast` usa `pg_advisory_xact_lock` + UNIQUE (`whatsapp`) — sem race na "6ª vaga".
- **`uso_ingestao` best-effort**: se o billing falhar, não derruba a ingestão (documento já indexado) (`index.ts:279-287`).
- **Catches vazios são intencionais e documentados** (cookie `setAll` em Server Component — `server.ts:29`).

---

## Modos de falha (por categoria)

### 1. Transacionalidade (escrita em mais de um lugar)
- **T1 — `subirArquivo`** (Storage + `jobs_ingestao` + invoke): bem tratado. Falha no INSERT → arquivo órfão removido; falha no invoke → job marcado `erro` (reprocessável). **Gap menor:** se o processo morrer entre o INSERT do job e o invoke, fica um job `pendente` que **ninguém repega** (não há scheduler que varra pendentes).
- **T2 — `ingerirTexto`** (`conhecimento/acoes.ts:107-157`): job insert + invoke **síncrono**. Se o `fetch` falhar na rede, retorna erro ao usuário mas **não marca o job como `erro`** (diferente do `subirArquivo`) → job `pendente` órfão.
- **T3 — Edge `processar`**: transições de status + swap + `uso_ingestao`. Swap é atômico; `uso_ingestao` é best-effort. **Consistente**, exceto o caso de morte da função (ver R1).
- **T4 (branch) — `conectarChatwoot`** na branch `fix/segregar-chatwoot-token`: passa a escrever `tenants` (account/url) **e** `tenant_credenciais` (token) em **dois writes não transacionais**. Se o 2º falhar, conta salva sem token. (No `main` é um único `update`, atômico.)

### 2. Chamadas externas
- Chatwoot / n8n: **timeout sim**, retry/backoff/circuit breaker **não**. Falha → mensagem amigável, sem estado corrompido.
- **E1 — invoke da Edge Function (`ingestao.ts:33`) SEM timeout.** No caminho **texto** (síncrono), se a função estiver lenta, a Server Action pendura até o timeout da plataforma (Vercel) — usuário vê erro genérico e pode sobrar job `processando`. (No caminho arquivo o invoke responde 202 rápido, sem pendurar.)
- **E2 — OpenAI (`index.ts:171`) sem timeout por request** (tem retry, mas um socket pendurado numa tentativa não é abortado). Download do Storage idem. Baixo.
- **Sem circuit breaker** em lugar nenhum — aceitável nesta escala.

### 3. Idempotência
- **I1 — `api_n8n_registrar_mensagem` NÃO é idempotente** (`09_api_n8n.sql:262-297`): INSERT puro em `mensagens_log`, sem chave/ON CONFLICT. Um **retry de webhook** (n8n re-executa o fluxo, ou Chatwoot re-entrega) **duplica a mensagem** e **conta o token 2x** no billing (`uso` deriva de `mensagens_log`). Também polui o histórico do tenant (`conversa_historico`).
- **Reprocessar job / replay do webhook da Edge Function: idempotente** (swap por `tenant+origem`). ✅
- **I2 — duplo submit de upload/texto:** cria documentos duplicados (cada upload = `origem` uuid nova); sem dedup. Baixo.
- Criação de tenant / conexão Chatwoot: UNIQUE (`slug`, `chatwoot_account_id`) barra duplicata. ✅

### 4. Concorrência / race conditions
- **C1 — `salvarTransferirHumano`** (`painel/acoes.ts:83-117`): read-modify-write do `config` **sem lock**. Dois saves simultâneos → o último sobrescreve o `config` inteiro do outro. Baixo (normalmente 1 admin).
- Reindex concorrente do mesmo `origem`: o swap trava a linha no DELETE; o 2º espera e re-swapa — converge sem duplicata. Baixo.
- Status de conversa / config: last-write-wins, aceitável.
- `agendar_podcast`: protegido (advisory lock). ✅

### 5. Tratamento de erro
- **ER1 — sem error boundaries**: não há `error.tsx`/`global-error.tsx` no App Router. Um erro não tratado num Server Component cai na página de erro padrão do Next (em prod, "Application error" genérico; sem UI de recuperação/branding). Ocorrência alta em qualquer falha inesperada.
- **ER2 — `error.message` cru vazando ao usuário**: várias actions retornam `Não foi possível salvar: ${error.message}` (ex.: `painel/acoes.ts:52`, `conhecimento/acoes.ts`, `admin/acoes.ts`). Não é stack trace, mas expõe detalhe interno do Postgres/PostgREST (nomes de constraint, etc.) e é UX ruim. Baixo.
- Erros silenciados são poucos e justificados (cookie setAll; `uso_ingestao` best-effort com `console.error`).

### 6. Jobs / background
- **R1 — job preso em `processando`**: `processar` seta `processando` no início e depende do `catch` para marcar `erro`. Se a **função serverless for morta** pela plataforma (timeout/OOM, comum em arquivo/texto grande), o `catch` **não roda** e o job fica **`processando` para sempre**. O painel faz polling indefinido daquele job. **Não há reaper** que expire `processando` antigo. **Principal modo de falha de background.**
- **R2 — sem retry automático / max-attempts / dead-letter**: falha = status `erro`, e só. Recuperação é **manual** (botão Reprocessar). Um erro transitório precisa de humano; nenhum DLQ ou limite de tentativas.
- Visibilidade: `erro_msg` por job (bom), mas sem painel agregado de taxa de falha nem alerta.

### 7. Observabilidade
- **O1 — instrumentação mínima**: sem Sentry/APM, sem log estruturado, sem request-id/correlação. Só `console.error` em ~2 pontos server-side (vai pro log da Vercel/Coolify). Falha de chamada ao n8n/Chatwoot volta ao usuário mas **não é logada com contexto**. Diagnosticar um incidente = garimpar logs da Vercel + Supabase + n8n na mão. `erro_msg` do job é o único sinal persistido. **Lacuna real para resposta a incidente em produção.**

### 8. Migrations / deploy
- **D1 — migration destrutiva (branch 16, `chatwoot_token`)**: `DROP COLUMN chatwoot_token`. Incompatível com a versão **anterior** do app rodando em paralelo durante um deploy rolling/blue-green: pods antigos leem uma coluna que sumiu → erro na janela de deploy. Precisa de rollout coordenado (migration + código juntos; idealmente two-phase: adiciona/backfill/troca-leituras/dropa depois). Está isolado na branch — não afeta `main` hoje.
- **D2** — `17_clamp_match_count` é `create or replace function`, retrocompatível. ✅ Demais migrations são aditivas. Migrations rodam com role que bypassa RLS (correto, CLAUDE.md).

---

## Tabela priorizada

| ID | Local | Modo de falha | Impacto ao usuário | Probabilidade | Mitigação sugerida |
|---|---|---|---|---|---|
| **R1** | Edge `processar` (`index.ts:215-303`) | Função morta → job preso em `processando` | Documento nunca indexa; painel fica "processando" eterno; usuário não sabe se deu certo | **Média** (serverless morre em arquivo/texto grande) | Reaper: marcar `erro` jobs `processando` há > N min (cron/edge). Registrar `iniciado_em` e ter timeout lógico. |
| **I1** | `api_n8n_registrar_mensagem` | Retry de webhook duplica mensagem e **dobra o billing** | Cobrança inflada; histórico duplicado | **Média** (depende do retry do n8n) | Chave de idempotência (ex.: id externo da mensagem do Chatwoot) + `ON CONFLICT DO NOTHING`. |
| **ER1** | App Router (sem `error.tsx`) | Erro não tratado → tela de erro crua | Usuário vê "Application error" sem recuperação | **Média/Alta** (qualquer falha inesperada) | Adicionar `error.tsx` por segmento + `global-error.tsx` com UI amigável e botão de retry. |
| **E1** | `ingestao.ts:33` (invoke sem timeout) | Edge lenta pendura a action (texto síncrono) | "Colar texto" trava até timeout da plataforma; possível job `processando` órfão | **Média** | `AbortSignal.timeout(...)` no invoke; mover texto para o caminho assíncrono (job + polling). |
| **O1** | Geral | Observabilidade fraca | Incidente difícil de diagnosticar; MTTR alto | **Alta** (quando algo falhar) | Sentry (server + edge), log estruturado com `tenant_id`/`job_id`, request-id, alerta em taxa de falha de job. |
| **D1** | Migration 16 (branch) | Drop de coluna incompatível com deploy paralelo | Erros na janela de deploy (super_admin editando Chatwoot) | **Média** (se deploy não coordenado) | Rollout coordenado / two-phase; aplicar em branch do Supabase antes; deploy do código junto. |
| **T2** | `ingerirTexto` | Falha de rede no invoke deixa job `pendente` órfão | Texto "some" sem virar documento nem erro visível | **Baixa** | Marcar job `erro` no `!r.ok` (como faz o `subirArquivo`). |
| **R2** | `jobs_ingestao` | Sem retry automático/DLQ | Falha transitória exige ação manual | **Baixa/Média** | Retry automático limitado + contador de tentativas; DLQ lógico (status `falha_definitiva`). |
| **ER2** | Várias actions | `error.message` do Postgres vaza ao usuário | Detalhe interno exposto; UX ruim | **Alta** (em qualquer erro de banco) | Mensagem genérica ao usuário + log do detalhe server-side. |
| **C1** | `salvarTransferirHumano` | Read-modify-write sem lock | Config de transferência de um save sobrescreve o outro | **Baixa** | `SELECT ... FOR UPDATE` ou merge no banco (jsonb) em vez de reconstruir no app. |
| **E2** | Edge → OpenAI/Storage | Sem timeout por request (tem retry) | Ingestão pode pendurar numa tentativa | **Baixa** | `AbortSignal.timeout` por tentativa. |
| **T1** | `subirArquivo` | Morte entre insert e invoke → job `pendente` não repegado | Arquivo enviado não processa | **Baixa** | Scheduler que repega `pendente` antigo (casa com o reaper do R1). |

---

## Prioridade recomendada
1. **R1 (reaper de `processando`)** + **E1 (timeout no invoke)** — juntos matam o pior sintoma: ingestão que "trava" sem feedback. Esforço baixo-médio.
2. **I1 (idempotência do billing)** — evita cobrança inflada; é dinheiro. Esforço baixo (chave + ON CONFLICT), depende de um id estável vindo do Chatwoot.
3. **ER1 (error boundaries)** — rede de segurança de UX para qualquer falha; esforço baixo.
4. **O1 (observabilidade)** — sem isso, todo incidente é caça ao tesouro. Esforço médio (plugar Sentry + log estruturado).
5. **D1** — só relevante no rollout da branch do `chatwoot_token`; garantir deploy coordenado.

### Nota de método
Não simulei falhas em produção (não derrubei serviços). Os modos de falha vêm da leitura
dos caminhos de erro no código e das garantias (ou ausência delas) no banco/Edge Function.
Probabilidades são qualitativas, baseadas em como cada componente é acionado.
