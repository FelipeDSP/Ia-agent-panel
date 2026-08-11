# Simulação de Migração — schema atual → v2

> Data: **2026-08-06**. **Documento de planejamento — nada foi executado.** Nenhuma
> migração criada, nenhum SQL rodado, nenhuma conexão aberta com o banco. Todo o
> levantamento saiu de `supabase/baseline/`, `supabase/migrations/` e do código.

## Premissa (leia antes)

O alvo não foi especificado, então escolhi um e declaro: **simulo a migração para um
schema "v2" composto pelas mudanças que as auditorias desta sessão identificaram como
justificadas** — não um redesenho arbitrário. Cada mudança abaixo aponta para o achado que
a motivou.

**A migração que a especificação previa não é candidata.** `ESPECIFICACAO.md` §5.2 descreve
converter `tenants.id` de BIGINT para UUID, mas o `ADENDO_ESTADO_ATUAL.md` a substitui:
nunca houve migração in-place, e `tenants.id` já é `uuid primary key default
gen_random_uuid()`. Não há BIGINT a converter.

Se o alvo pretendido era outro (schema por tenant, renomeação pt→en, novo projeto
Supabase), o método e a planilha de esforço deste documento transferem — troca-se a lista
de mudanças da §3.

---

## 1. Ponto de partida

| Item | Quantidade |
|---|---|
| Tabelas em `public` | **11** |
| Funções | **15** (incl. 3 `api_n8n_*`, 5 chamadas pelo app) |
| Query sites no código | **130** |
| Migrações versionadas | 12 (09–20) + baseline 01–08 |
| Volume em produção | 158 chunks · 6 tenants · 69 conversas |

**Query sites por tabela** — é o que dimensiona o retrabalho:

| Tabela | Sites | Tabela | Sites |
|---|---|---|---|
| `tenants` | **35** | `usuarios_painel` | 8 |
| `tenant_tools` | **30** | `catalogo_tools` | 8 |
| `kb_documentos` | **16** | `prompt_versoes` | 6 |
| `jobs_ingestao` | 13 | `precos_modelo` | 2 |
| `conversas` | 11 | `uso_ingestao` | 1 |
| | | `mensagens_log` | **0** (só via RPC) |

## 2. A restrição que domina o plano inteiro

**O n8n lê este mesmo banco.** Isso não é detalhe de implementação — é o que decide a forma
de toda a migração. Consequências práticas:

1. **Não existe janela de downtime aceitável.** O agente da Acqua responde a clientes reais.
2. **Não se pode usar `ALTER TABLE ... RENAME` direto** em nada que o n8n leia: entre o
   commit e o redeploy do workflow, o agente quebra.
3. **Toda mudança tem que ser classificada** como *transparente ao n8n* ou *exige cutover
   coordenado*. Isso muda o custo por um fator de 3.
4. O padrão obrigatório é **expand/contract**: adicionar o novo, popular, migrar leitores
   um a um, só então remover o antigo. Nunca trocar em um passo.

O que o n8n toca hoje: `kb_documentos` (via `api_n8n_buscar_kb` e via node PGVector, que
filtra por `metadata`), `conversas`, `tenants`, e as funções `api_n8n_tenant_por_chatwoot`,
`api_n8n_credencial_chatwoot`, `api_n8n_tools_ativas`, `api_n8n_config_tool`.

## 3. O schema v2

### M1 — Normalizar `documentos` 🔴 *a mudança grande*

**Motivação:** hoje "documento" é ficção. O comentário em `painel/conhecimento/page.tsx:12`
diz literalmente: *"a base nao tem tabela separada de documento, o documento e o conjunto de
chunks que compartilham origem"*. A consequência medida em
[`auditorias/AUDIT-COMPLEXIDADE.md`](auditorias/AUDIT-COMPLEXIDADE.md) §2: a tela busca
**O(chunks)** linhas para renderizar **O(documentos)** itens.

```sql
-- NOVO
create table public.documentos (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  nome          text not null,
  origem        text not null,
  arquivo_path  text,
  chunks        integer not null default 0,
  criado_em     timestamptz not null default now(),
  deletado_em   timestamptz,
  unique (tenant_id, origem)
);
create index idx_documentos_tenant on public.documentos (tenant_id, criado_em desc)
  where deletado_em is null;

-- kb_documentos ganha o FK; `origem` PERMANECE durante toda a transição
alter table public.kb_documentos
  add column documento_id uuid references public.documentos(id) on delete cascade;
```

**Classificação n8n:** *transparente*, **desde que `origem` e `metadata` permaneçam**. O
node PGVector filtra por `metadata`, não por `origem` — mas isso precisa ser **confirmado no
workflow antes**, não presumido. É a única verificação bloqueante do plano.

### M2 — `CHECK` em `tenants.modelo` 🟡

**Motivação:** [`auditorias/AUDIT-COBERTURA.md`](auditorias/AUDIT-COBERTURA.md) §3 — a
whitelist `MODELOS_PERMITIDOS` existe **só em JS**, e o `schema.ts` lista os CHECKs em que
se apoia sem incluir `modelo`. É a única regra sem rede no banco cuja violação quebra o
agente em produção (o n8n lê `tenants.modelo` para escolher o LLM).

```sql
-- Verificar ANTES: select distinct modelo from tenants;
alter table public.tenants
  add constraint tenants_modelo_check
  check (modelo in ('gpt-4.1-mini','gpt-4.1','gpt-4o-mini', ...));
```

⚠️ Duplica a whitelist em dois lugares. A alternativa correta é uma tabela
`modelos_permitidos` com FK — mais trabalho, mas sem divergência silenciosa. Recomendo a
tabela.

**Classificação n8n:** *transparente* (constraint não muda leitura).

### M3 — Índice HNSW parcial por tenant 🟡

**Motivação:** documentada no próprio `CLAUDE.md`. O HNSW global é descartado pelo planner
quando há filtro de tenant; a busca é O(chunks do tenant), correta e linear.

**Classificação n8n:** *transparente*, mas **exige re-rodar `npm run teste:recall` antes e
depois**, comparando números. Trocar plano de busca vetorial sem medir recall quebra calado.

Custo escondido: um índice por cliente vira **passo de provisionamento** em `criarTenant`.

### M4 — Desambiguar as duas migrações "18" 🟢

**Motivação:** o próprio commit `c8c2407` registra: existem `18_indice_historico_conversa` e
`18_seguranca_tenant_tools` com timestamps distintos, e recomenda revisar **antes do próximo
`db push`**. Renomeação de arquivo + alinhamento com o ledger.

### M5 — Nomenclatura híbrida ⚪ *recomendo NÃO fazer*

`arquivo_path` e `debounce_segundos` misturam português e inglês sem imposição externa
([`auditorias/AUDIT-A11Y-I18N.md`](auditorias/AUDIT-A11Y-I18N.md) não; foi a auditoria de
nomenclatura). Incluo para registrar que foi considerado e **descartado**: é renomeação
cosmética em colunas que o n8n pode ler, com risco de cutover e ganho zero de comportamento.

---

## 4. Queries que precisam mudar

### 4.1 M1 — `documentos` normalizada (o grosso do trabalho)

| Arquivo | O que muda |
|---|---|
| `painel/conhecimento/page.tsx:15-40` | **reescrita completa** — hoje busca todos os chunks e agrupa por `origem` num `Map`; passa a ser `select … from documentos where tenant_id = …`. Some o loop de agrupamento. |
| `painel/conhecimento/acoes.ts` › `excluirDocumento` | recebe `documentoId` em vez de `origem`; delete no `documentos` cascateia para chunks |
| `painel/conhecimento/acoes.ts` › `verConteudoDocumento` | filtra por `documento_id` em vez de `.eq('origem', origem)` |
| `painel/conhecimento/acoes.ts` › `subirArquivo` / `ingerirTexto` | cria a linha em `documentos` antes de enfileirar o job |
| `painel/conhecimento/componentes.tsx` | `Documento` passa a ter `id`; handlers trocam `origem` por `id` (afeta `DocumentoItem`, `BotaoExcluirDocumento`) |
| `admin/tenants/page.tsx:161` | contagem de documentos: `count` em `documentos`, não `distinct origem` em `kb_documentos` |
| `painel/page.tsx` | idem, métrica do dashboard |
| **Edge Function** `processar-ingestao/index.ts:281` | `kb_reindex_documento` passa a receber `p_documento_id` |
| **RPC** `kb_reindex_documento` | assinatura e corpo: swap por `documento_id` em vez de `(tenant_id, origem)` |
| `scripts/import-producao.mjs:319-410` | cria `documentos` a partir de `metadata->>'fonte'` antes de inserir chunks |
| `tests/isolamento-fase2.mjs` | acrescentar `documentos` à matriz de isolamento (**obrigatório** — tabela nova com `tenant_id` exige policy e teste) |

**28 referências a `origem`** em 7 arquivos precisam ser revisadas uma a uma — nem todas
mudam (`origem` continua existindo como coluna), mas cada uma precisa ser classificada.

**Migrações necessárias: 3** (expand → backfill → contract), cada uma com rollback.

### 4.2 M2 — CHECK em `modelo`

| Arquivo | O que muda |
|---|---|
| `lib/tenants/schema.ts:14` | `MODELOS_PERMITIDOS` passa a ser derivada da tabela (ou documentada como espelho do CHECK) |
| Migração nova | constraint + verificação prévia de `select distinct modelo` |

Queries do app: **nenhuma muda**. É constraint, não leitura.

### 4.3 M3 — HNSW parcial

| Arquivo | O que muda |
|---|---|
| `admin/acoes.ts` › `criarTenant` | passa a criar o índice parcial do tenant novo |
| `admin/acoes.ts` › `excluirTenant` | passa a dropar o índice |
| Migração nova | índice para os 6 tenants existentes |

Queries: **nenhuma muda** — o planner escolhe. O que muda é a medição de recall.

---

## 5. Plano de execução (expand/contract)

| Fase | O que | Reversível? |
|---|---|---|
| **0. Verificação bloqueante** | Confirmar no workflow do n8n que o node PGVector filtra por `metadata` e **não** por `origem`. Se filtrar por `origem`, M1 muda de *transparente* para *cutover coordenado* e o esforço sobe ~40%. | — |
| **1. Branch do Supabase** | Levantar branch a partir de `supabase/baseline/` + migrações; nunca testar em produção | sim |
| **2. Expand** | Criar `documentos`, adicionar `documento_id` nullable, criar policies + índices. Nada lê ainda. | sim (drop) |
| **3. Backfill** | Uma linha em `documentos` por `(tenant_id, origem)` distinto; popular `documento_id`. Em prod: ~15 documentos a partir de 158 chunks. | sim (delete) |
| **4. Migrar leitores** | App passa a ler `documentos`; Edge Function passa a gravar `documento_id`. `origem` continua populada. | sim (revert de código) |
| **5. Validar** | `teste:isolamento` + `teste:seguranca-tools` + `teste:recall` + teste novo de `documentos` | — |
| **6. Contract** | Tornar `documento_id` `not null`. **Não** remover `origem` — o n8n pode usá-la e ela custa pouco. | parcial |

M2, M3 e M4 são independentes e podem ir em qualquer ordem, antes ou depois. **M1 é a única
que exige sequência.**

## 6. Estimativa de esforço

**Premissas da estimativa** (mudam o número se forem falsas): um desenvolvedor já
familiarizado com o repositório; inclui escrita de teste e rollback, que o `CLAUDE.md`
exige; inclui validação em branch do Supabase; **não** inclui alteração no workflow do n8n;
não inclui tempo de espera por janela de deploy.

| # | Item | Horas | Confiança |
|---|---|---|---|
| **0** | Verificação do workflow n8n (bloqueante) | **1–2** | alta |
| **M1.a** | 3 migrações (expand/backfill/contract) + rollbacks + policies | **4–6** | média |
| **M1.b** | Reescrever `kb_reindex_documento` + Edge Function | **3–4** | média |
| **M1.c** | Reescrever as 7 telas/actions de conhecimento | **5–8** | **baixa** — 28 refs a `origem` a classificar |
| **M1.d** | Teste de isolamento para `documentos` (3 tenants) | **2–3** | alta |
| **M1.e** | `import-producao.mjs` | **1–2** | alta |
| **M2** | Tabela `modelos_permitidos` + FK + ajuste no `schema.ts` | **3–4** | alta |
| **M3** | Índice parcial + provisionamento em criar/excluir tenant | **3–4** | média |
| **M3.v** | Rodar e comparar `teste:recall` antes/depois | **1–2** | alta |
| **M4** | Renumerar as duas "18" + alinhar ledger | **1–2** | alta |
| **V** | Validação em branch + ensaio de rollback | **3–5** | média |
| **C** | Cutover em produção + observação | **2–3** | média |
| | **TOTAL** | **29–45 h** | |

**Ponto médio: ~37 horas** — cerca de **uma semana de trabalho** para um dev dedicado.

### Onde a estimativa é frágil

- **M1.c (5–8h) é o item de menor confiança.** As 28 referências a `origem` estão
  espalhadas por telas, actions e componentes; algumas somem, outras viram `documento_id`,
  outras ficam. Só a leitura fina dirá. É onde eu colocaria uma margem de +50%.
- **A fase 0 pode mudar tudo.** Se o n8n filtrar por `origem`, M1 vira cutover coordenado
  com o workflow: some a transparência, entra janela de sincronia, e o total sobe para
  **~45–60h**.
- **Se M1 for descartada, o resto some.** M2+M3+M4+validação são **~12–18h** — e cobrem os
  dois riscos reais (whitelist de `modelo` sem rede, numeração de migração ambígua) sem
  tocar em `kb_documentos`.

### Recomendação

Se o objetivo é reduzir risco pelo menor custo, **faça M2, M3 e M4 (12–18h) e adie M1.**
Com 158 chunks e 6 tenants, o problema que M1 resolve — O(chunks) trafegados para renderizar
O(documentos) — **ainda não existe**: são 70 linhas na maior base. M1 é a coisa certa a
fazer, na hora errada. O gatilho natural é o primeiro tenant passar de ~1.000 chunks.

## 7. Riscos e rollback

| Risco | Mitigação |
|---|---|
| n8n filtra por `origem` e quebra | fase 0 é bloqueante; `origem` nunca é removida |
| Backfill gera documento duplicado | `unique (tenant_id, origem)` na criação da tabela |
| Tabela nova sem policy vaza | policy na **mesma migração** (regra 2 do `CLAUDE.md`) e teste de isolamento na fase 5 |
| Recall cai com HNSW parcial | `teste:recall` antes/depois, com números comparados |
| CHECK de `modelo` rejeita linha existente | `select distinct modelo` antes de aplicar |
| Migração aplicada com RLS ativo | rodar com role que bypassa RLS (regra do `CLAUDE.md`) |

**Rollback por fase:** 2 e 3 revertem por `drop`/`delete` sem perda — `origem` continua
sendo a fonte da verdade até a fase 6. A partir da 4, o rollback é revert de código, não de
schema. A fase 6 é a única que estreita o schema, e mesmo ela mantém `origem`.

---

## Método

Inventário de tabelas e funções por leitura de `supabase/baseline/*.sql` e
`supabase/migrations/*.sql`; contagem de query sites por `grep` de `from('<tabela>')` e SQL
cru, por tabela; referências a `origem` contadas em `src/` e na Edge Function. As
motivações de cada mudança vêm das auditorias desta sessão, citadas por seção. **Nenhuma
consulta foi feita ao banco** — os volumes de produção citados (158 chunks, 6 tenants, 69
conversas) vêm de `auditorias/AUDIT-PERFORMANCE.md`, medidos em 2026-08-04. As horas são
estimativa de engenharia, com as premissas declaradas na §6; trate-as como faixa, não como
compromisso.
