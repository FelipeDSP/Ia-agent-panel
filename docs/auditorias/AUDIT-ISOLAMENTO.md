# Auditoria de Isolamento de Dados — ChatYou · IA

> Investigação apenas — **nada corrigido**. Baseado em leitura do código e no catálogo
> do Postgres em produção (RLS, policies, grants, FORCE RLS) e na Edge Function.
> Data: 2026-08-04.

## 1. Qual é a fronteira de isolamento?

**A fronteira é o `tenant`** (uma empresa cliente da agência). Não há sub-fronteira de
time/projeto dentro do tenant.

- A identidade de tenant vem **sempre do JWT** (`app_metadata.tenant_id`), nunca do
  request — resolvida por `auth_tenant_id()` no banco e por `exigirTenantAdmin()` no app
  (`lib/auth.ts`).
- Papéis: `tenant_admin` (preso a 1 tenant), `super_admin` (agência, cross-tenant, sem
  tenant), mais os roles Postgres `n8n_agent` (integração) e `service_role` (server-only).
- Um usuário (`usuarios_painel`) pertence a exatamente um tenant (ou é super_admin).

## 2. Entidades persistidas — classificação

| Entidade | Classe | Chave de dono |
|---|---|---|
| conversas | do tenant | `tenant_id` |
| kb_documentos | do tenant | `tenant_id` |
| jobs_ingestao | do tenant | `tenant_id` |
| prompt_versoes | do tenant | `tenant_id` |
| tenant_tools | do tenant | `tenant_id` |
| uso_ingestao | do tenant | `tenant_id` |
| mensagens_log | do tenant (só super lê) | `tenant_id` |
| Storage `kb-arquivos/<tenant>/*` | do tenant | pasta = `tenant_id` |
| tenants | é a própria org | `id` |
| usuarios_painel | usuários de um tenant | `tenant_id` / `id` |
| precos_modelo | **global** (agência) | — (só super) |
| podcast_agendamentos | **de outra app** (não multi-tenant) | — |

**Compartilhadas entre tenants: nenhuma.** Não existe recurso cross-tenant compartilhado.

## 3. Onde o filtro de propriedade é aplicado (e consistência)

Três camadas, aplicadas de forma **consistente**:
1. **Banco (RLS `FORCE` + policy):** todas as tabelas do tenant. É a rede de segurança.
2. **Data access (Server Actions/Components):** filtro **explícito** `.eq('tenant_id', usuario.tenantId)` (do JWT) além do RLS — regra 6 do CLAUDE.md.
3. **Guard de papel** na 1ª linha de toda action (`exigir*`).

Inconsistências encontradas:
- **`restaurarVersaoPrompt`** (`lib/tenants/prompt-acoes.ts:71`) lê `prompt_versoes` por `id` **sem** `.eq('tenant_id')` explícito, comparando `tenant_id` em JS depois (dupla camada, correto, mas destoa do padrão). Cosmético.
- **`uso_ingestao`** tem RLS mas **sem `FORCE`** (as demais do tenant têm) — inconsistência de defesa em profundidade (ver Achado I3).

## 4. Regras de banco lidas uma a uma

Padrão das tabelas do tenant (USING **e** WITH CHECK):
`auth_is_super_admin() OR (tenant_id = auth_tenant_id())` — restringe **escopo** (tenant),
não só identidade. Correto.

- `mensagens_log`, `precos_modelo`, `uso_ingestao`: `auth_is_super_admin()` puro — tenant não lê. Correto.
- `tenants`: SELECT/UPDATE `auth_is_super_admin() OR (id = auth_tenant_id())`. Restringe escopo. **Mas** SELECT devolve a **linha inteira**, incluindo `chatwoot_token` → Achado **I1**.
- **`usuarios_painel` UPDATE**: `auth_is_super_admin() OR (id = auth.uid())` — checa **identidade, não escopo de coluna**: o usuário pode reescrever `papel`/`tenant_id` da própria linha → Achado **I2** (exatamente o padrão "checa identidade mas não restringe o que ela pode mudar").
- **Nenhuma policy `USING (true)`**. Policies de INSERT com USING nulo são normais (usam WITH CHECK = super). Não é falha.
- Sem `FORCE`: `uso_ingestao`, `precos_modelo`, `podcast_agendamentos` → Achado **I3**.

## 5. Credencial administrativa / bypass do mecanismo padrão

- **service_role** (`lib/supabase/admin.ts`, `import 'server-only'`): usado só em 4 ações **super_admin** (`admin/acoes.ts:93,213,250,289`) para Admin API (createUser/generateLink/deleteUser). **Nenhuma leitura de dado de tenant** por service_role — leitura sempre pelo cliente RLS. Escopo reimposto: as ações validam ownership do alvo (`carregarAdminDoTenant`). Não burlável por input.
- **Funções SECURITY DEFINER** (bypassam RLS): todas com `search_path` fixo. Grants verificados no banco:
  - `api_n8n_*` → só `n8n_agent`/`service_role` (não `authenticated`/`anon`) → tenant não chama para forjar dado de outro. Reimpõem escopo via `p_tenant_id` + `n8n_assert_tenant`.
  - `billing_consumo_mensal` → gate `if not auth_is_super_admin() then raise 42501`.
  - `billing_volume_mensal`, `conversa_historico` → filtram por `auth_tenant_id()`.
  - `kb_reindex_documento` → só service_role; sobrescreve `metadata.tenant_id` com `p_tenant_id` (não confia no request).
  - `agendar_podcast` → `authenticated` (feature não relacionada) → Achado **I4**.

## 6. Arquivos / blobs

Bucket `kb-arquivos` **privado**. Policies de `storage.objects`:
`(storage.foldername(name))[1] = auth_tenant_id()::text` (SELECT/INSERT/UPDATE/DELETE).
Path montado do JWT (`conhecimento/acoes.ts:61` → `${tenantId}/uuid.ext`). **Não há signed
URL de download** no código. Um tenant não lê/escreve na pasta de outro. **Sem acesso cruzado.**

## 7. Cache / memoização / módulo / singletons

- `criarClienteServidor()` e `criarClienteAdmin()` são **funções** — criam client **novo por request**, lendo os cookies da request atual (`next/headers`). **Nenhum singleton de client** em escopo de módulo → sem vazamento de sessão entre requests.
- Estado de módulo é só **constante estática** (`ROTAS_PROTEGIDAS`, `NOMES_MES`, `STATUS_VALIDOS`, `ATIVO`) — nenhum dado por dono, nenhum `Map`/cache mutável, nenhum `global.`.
- Sem `unstable_cache`/`revalidateTag`/`React.cache`/`force-cache` (só `revalidatePath`, que invalida caminho e não compartilha dado). **Sem vazamento por cache.**

## 8. Busca / listagem / exportação / relatório / agregação

- **Listagens do tenant:** `painel/page.tsx` (counts `head:true` com `.eq('tenant_id')`), `conversas/page.tsx` (`.eq('tenant_id')`), `conhecimento/page.tsx` (chunks `.eq('tenant_id')`), jobs (`.eq('tenant_id')`). Todas escopadas.
- **Agregações:** `billing_volume_mensal` (tenant, via `auth_tenant_id()`), `billing_consumo_mensal` (super-only, raise 42501).
- **Admin:** `admin/tenants/page.tsx` lista **todos** os tenants — correto, é super_admin (RLS devolve tudo só para super; um tenant_admin veria só a própria linha).
- **Exportação/relatório/busca textual:** **não existem** endpoints desse tipo.
- Nenhum ponto de listagem/agregação esquece o filtro.

---

## Achados

| ID | Arquivo:linha | Achado | Sev | Cenário concreto de vazamento |
|---|---|---|---|---|
| **I1** | `tenants.chatwoot_token` + policy `p_tenants_select` | RLS é por linha, não por coluna: o tenant lê a própria linha de `tenants`, logo lê `chatwoot_token` (credencial da agência). **Confirmado ao vivo.** | **Alta** | tenant_admin faz `GET /rest/v1/tenants?select=chatwoot_token` com a publishable key + seu JWT → recebe o token do Agent Bot da agência e passa a agir como o bot no Chatwoot. |
| **I2** | policy `p_usuarios_update` | UPDATE por `id=auth.uid()` sem restrição de coluna; sem trigger-guard. Usuário reescreve `papel`/`tenant_id` da própria projeção. Hoje **não** escala (autz vem do JWT; sem sync reverso p/ `app_metadata`). | **Média** | Um `UPDATE usuarios_painel SET tenant_id='<outro>'` na própria linha não vaza hoje (o `auth_tenant_id()` vem do JWT), mas se algum código futuro passar a confiar na projeção, vira visão/edição de outro tenant. |
| **I3** | DB: `uso_ingestao` (e `precos_modelo`, `podcast_agendamentos`) | `FORCE ROW LEVEL SECURITY` ausente (owner bypassa). App não conecta como owner hoje. | **Baixa** | Um script/migração futura rodando como owner da tabela leria uso de todos os tenants sem RLS. |
| **I4** | função `agendar_podcast` (grant `authenticated`) | Executável por qualquer usuário logado (qualquer tenant); insere PII numa tabela de outra app. | **Baixa** | tenant_admin de A ocupa as 6 vagas/dia do podcast; não vaza dado de tenant, mas cruza fronteira de feature. |
| OBS | `podcast_agendamentos` | PII de outra aplicação no mesmo banco (RLS deny-all na leitura — fail-closed). | Obs | Aumenta blast-radius de um comprometimento do banco; hoje não é lida via API. |

**Nenhum vazamento cross-tenant explorável nas tabelas de dados do tenant.** O único
vazamento **real** é I1 (credencial da agência → tenant), já com fix na branch
`fix/segregar-chatwoot-token`.

---

## Teste automatizado de regressão

Coloque em `supabase/tests/isolamento_tenant.sql` (mesmo estilo do
`isolamento_api_n8n.sql` já existente). Roda como o role `authenticated` simulando o JWT
de cada tenant e afirma que B não enxerga A. Falha o CI se a RLS regredir.

```sql
-- Teste de isolamento entre tenants. Deve rodar em transação e dar ROLLBACK.
-- Simula o JWT de um tenant setando request.jwt.claims + role authenticated.
begin;

-- Dois tenants de teste (idempotente).
insert into public.tenants (id, nome, slug, ativo)
values ('00000000-0000-0000-0000-00000000000a','Tenant A','tenant-a-teste',true),
       ('00000000-0000-0000-0000-00000000000b','Tenant B','tenant-b-teste',true)
on conflict (id) do nothing;

-- Um dado que pertence ao Tenant A.
insert into public.conversas (tenant_id, conversation_id, contact_name, status)
values ('00000000-0000-0000-0000-00000000000a', 999999001, 'Contato de A', 'ativo')
on conflict do nothing;

-- === Assume a identidade do Tenant B (não é super_admin) ===
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-0000-0000-0000000000b1",
    "app_metadata":{"tenant_id":"00000000-0000-0000-0000-00000000000b","papel":"tenant_admin"}}';

do $$
begin
  -- 1) B NÃO enxerga conversa de A.
  if exists (select 1 from public.conversas
             where tenant_id = '00000000-0000-0000-0000-00000000000a') then
    raise exception 'FALHA ISOLAMENTO: Tenant B leu conversa do Tenant A';
  end if;

  -- 2) B NÃO enxerga a linha (nem o token) do Tenant A em tenants.
  if exists (select 1 from public.tenants
             where id = '00000000-0000-0000-0000-00000000000a') then
    raise exception 'FALHA ISOLAMENTO: Tenant B leu a linha de tenants do Tenant A';
  end if;

  -- 3) B enxerga a PRÓPRIA conversa? (sanidade: RLS não pode ser restritiva demais)
  --    (nenhuma conversa de B foi inserida, então esperamos 0 — ajuste se semear B)

  -- 4) B NÃO lê custo/token (mensagens_log é só super).
  if exists (select 1 from public.mensagens_log limit 1) then
    raise exception 'FALHA ISOLAMENTO: Tenant B leu mensagens_log (custo/token)';
  end if;

  raise notice 'OK: isolamento por RLS mantido para o Tenant B.';
end $$;

reset role;
rollback;
```

**Assertion de coluna (Achado I1)** — a SQL acima cobre *linha*, não *coluna*. Enquanto
`chatwoot_token` viver em `tenants`, adicione uma verificação de que o tenant **não**
consegue lê-la. Depois do fix (coluna movida para `tenant_credenciais` sem policy de
tenant), esta asserção deve passar:

```sql
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"...b1","app_metadata":{"tenant_id":"...000b","papel":"tenant_admin"}}';
do $$
begin
  -- Deve dar 0: a credencial não pode ser legível pelo tenant.
  if exists (select 1 from public.tenant_credenciais
             where tenant_id = '00000000-0000-0000-0000-00000000000b') then
    raise exception 'FALHA: tenant_admin leu a própria credencial (deveria ser bloqueado)';
  end if;
end $$;
reset role;
```
> Hoje, com o token ainda em `tenants`, o equivalente (`select chatwoot_token from tenants
> where id = auth_tenant_id()`) **retorna o token** — é o teste que prova o Achado I1 e que
> passa a barrar após o rollout da branch.

**Complemento de integração (opcional):** um teste E2E que, autenticado como tenant B via
publishable key + JWT, faz `GET /rest/v1/tenants?select=chatwoot_token` contra o PostgREST
e espera **coluna inexistente / vazio** — cobre a superfície real (browser), não só o SQL.

### Como rodar no CI
`supabase db execute --file supabase/tests/isolamento_tenant.sql` (ou `psql` com a service
connection) em um **branch do Supabase** semeado com ≥2 tenants. Falhar o job se qualquer
`raise exception` disparar. Recomendo semear **3** tenants (CLAUDE.md): um tenant só
esconde bug de isolamento; dois escondem vazamento unidirecional.
