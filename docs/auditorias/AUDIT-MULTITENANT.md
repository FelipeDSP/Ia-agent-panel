# Auditoria de Isolamento Multi-tenant — ChatYou · IA

> Investigação apenas. Nada foi corrigido. Verificado contra o **banco de produção**
> (`SUPABASE_DB_URL`, leitura via `pg`), o código-fonte e as migrations do repo.
> Data: 2026-08-04.

## Veredito

**A postura de isolamento é forte.** O padrão "tenant_id do JWT + filtro explícito +
RLS com `FORCE`" é aplicado de forma consistente nas tabelas de dados do tenant, e
nenhuma policy usa `USING (true)` nem deriva o tenant do request. Não há vazamento
cross-tenant explorável nas tabelas de dados.

O achado mais grave é a **exposição do `chatwoot_token`** (credencial da agência
legível pelo tenant via coluna na linha que ele já lê) — confirmado ao vivo. Os
demais são fragilidades de defesa-em-profundidade e higiene.

---

## 1. Mapa de tabelas (schema `public`)

| Tabela | Coluna de tenant | RLS | FORCE RLS | Policies | Escopo |
|---|---|---|---|---|---|
| conversas | `tenant_id` | ✅ | ✅ | 1 | tenant + super |
| jobs_ingestao | `tenant_id` | ✅ | ✅ | 1 | tenant + super |
| kb_documentos | `tenant_id` | ✅ | ✅ | 1 | tenant + super |
| prompt_versoes | `tenant_id` | ✅ | ✅ | 1 | tenant + super |
| tenant_tools | `tenant_id` | ✅ | ✅ | 1 | tenant + super |
| usuarios_painel | `tenant_id` | ✅ | ✅ | 4 | próprio + tenant + super |
| tenants | (é o próprio `id`) | ✅ | ✅ | 4 | próprio + super |
| mensagens_log | `tenant_id` | ✅ | ✅ | 1 | **só super** (via função p/ tenant) |
| uso_ingestao | `tenant_id` | ✅ | ⚠️ **false** | 1 | só super |
| precos_modelo | — (global) | ✅ | ⚠️ false | 1 | só super |
| podcast_agendamentos | — (não é multi-tenant) | ✅ | ⚠️ false | **0** | deny-all (fail-closed) |

Todas as tabelas com dado de tenant têm RLS + policy. `podcast_agendamentos` é de
outra funcionalidade (formulário de podcast, contém PII) que compartilha o mesmo banco.

## 2. Avaliação das policies

Nenhuma `USING (true)`. Padrão das tabelas de tenant (USING e WITH CHECK):
`auth_is_super_admin() OR (tenant_id = auth_tenant_id())` — `auth_tenant_id()` lê do
JWT (`app_metadata`), não do request. Correto.

- **mensagens_log / precos_modelo / uso_ingestao:** `auth_is_super_admin()` puro — o
  tenant não lê custo/token. Correto (isolamento de faturamento).
- **tenants:** SELECT/UPDATE = `auth_is_super_admin() OR (id = auth_tenant_id())`;
  INSERT/DELETE só super. **Consequência:** o tenant lê a própria linha inteira de
  `tenants` — ver Achado **A1** (chatwoot_token).
- **usuarios_painel:** SELECT = `id = auth.uid() OR super OR tenant_id = auth_tenant_id()`
  (tenant vê co-admins da própria org — ok). UPDATE = `auth_is_super_admin() OR
  id = auth.uid()` **sem restrição de coluna** — ver Achado **M1**.
- **INSERT com `USING = <null>`** (`p_tenants_insert`, `p_usuarios_insert`): normal —
  INSERT usa `WITH CHECK` (= `auth_is_super_admin()`), não USING. **Não é falha.**

## 3. service_role / bypass de RLS

- Único ponto: `src/lib/supabase/admin.ts:19` (`criarClienteAdmin`, com `import
  'server-only'` + validação de que a chave não é pública). Usado só em
  `src/app/(app)/admin/acoes.ts:93,213,250,289` — todas ações **super_admin**
  (`createUser`, `generateLink`, `deleteUser`). Nenhuma leitura de dado de tenant passa
  por service_role; leitura de tenant usa sempre o cliente RLS (publishable key + JWT).
- **Funções SECURITY DEFINER** (bypassam RLS): todas com `search_path` fixo (sem
  hijack). Grants de EXECUTE conferidos no banco:
  - `api_n8n_*` → só `n8n_agent`/`service_role`/`postgres`. **`authenticated`/`anon` NÃO
    podem chamar** → tenant não forja mensagem/uso/credencial de outro. ✅
  - `billing_consumo_mensal` (custo USD) → grant a `authenticated`, mas o corpo faz
    `if not auth_is_super_admin() then raise 42501`. Tenant recebe exceção. ✅
  - `billing_volume_mensal`, `conversa_historico` → filtram por `auth_tenant_id()`. ✅
  - `agendar_podcast` → grant a `authenticated` — ver Achado **B3**.
  - `tenants_versionar_prompt` (trigger) → grant a PUBLIC/anon — ver Achado **B2**.

## 4. IDOR (rotas / server actions / route handlers)

Não há route handlers de dados além de `auth/confirmar` (troca de token, sem ID de
recurso). Todas as server actions:
- chamam `exigirTenantAdmin()`/`exigirSuperAdmin()` na 1ª linha (papel do JWT);
- ações do tenant que recebem ID do cliente filtram por `usuario.tenantId` do JWT
  **e** têm RLS `FORCE` como rede: `conhecimento/acoes.ts` (`excluirDocumento`,
  `verConteudoDocumento`, `dispensarJob`, `reprocessar` — todos `.eq('tenant_id', …)`),
  `conversas/acoes.ts` (`definirStatusConversa`, `limparMemoriaConversas` re-resolvem
  os IDs escopados por tenant), `tenants/prompt-acoes.ts:33,71` (rejeita `tenantId` do
  argumento que não bate com o JWT);
- ações super_admin que recebem `tenant_id`/`user_id` do form validam ownership contra
  o banco antes: `carregarAdminDoTenant` (`admin/acoes.ts:178`) confirma que o alvo é
  `tenant_admin` daquele tenant — bloqueia ID forjado.
- Detalhe de conversa: `conversa_historico` (DEFINER) filtra por `auth_tenant_id()`.

**Nenhum IDOR encontrado.** Mesmo que uma action esquecesse o filtro, o RLS `FORCE`
nas tabelas de tenant barra cross-tenant.

## 5. Storage (bucket `kb-arquivos`)

- Bucket **privado** (`public=false`), `file_size_limit` + `allowed_mime_types`.
- `storage.objects` com RLS on; policies escopam por
  `(storage.foldername(name))[1] = auth_tenant_id()::text` — pasta = `tenant_id`.
- Upload monta o path a partir do JWT: `conhecimento/acoes.ts:61`
  (`${usuario.tenantId}/uuid.ext`), nunca do request.
- **Não há geração de signed URL** de download no código (o "Ver conteúdo" lê chunks do
  banco, não do Storage). Sem vetor de URL assinada cross-tenant.
- Um tenant não lê/escreve na pasta de outro. ✅

## 6. Cache / revalidação / memoização

- Nenhum `unstable_cache`, `revalidateTag`, `export const revalidate`, `React.cache`,
  `force-cache` ou `generateStaticParams` no código.
- Só `revalidatePath(...)` (invalida caminho; **não** compartilha dado entre tenants).
- Server Components consultam por request via cliente RLS (dinâmico). **Sem vazamento
  de cache entre tenants.** ✅

---

## Achados (ordenados por severidade)

| ID | Arquivo:linha | Descrição | Severidade | Cenário de exploração | Correção sugerida |
|---|---|---|---|---|---|
| **A1** | `tenants.chatwoot_token` (schema base) + policy `p_tenants_select` + `src/app/(app)/admin/acoes.ts` | RLS filtra **linha**, não **coluna**. O tenant_admin lê a própria linha de `tenants` (`id = auth_tenant_id()`), logo lê `chatwoot_token` (credencial de Agent Bot da agência) em plaintext. **Confirmado ao vivo:** `GET /rest/v1/tenants?select=chatwoot_token` com publishable key + JWT do tenant → 200 + token. | **Alta** | tenant_admin autenticado extrai o token do Chatwoot da agência pelo browser e passa a postar como o bot naquela conta. | Segregar credenciais em tabela sem policy de tenant (só super + n8n via função), como já feito com `mensagens_log`. **(fix pronto na branch `fix/segregar-chatwoot-token`.)** Rotacionar o token. |
| **M1** | policy `p_usuarios_update` (schema base) | UPDATE permite `id = auth.uid()` **sem restrição de coluna** e `usuarios_painel` **não tem trigger-guard** (diferente de `tenants`). Um tenant_admin pode `UPDATE usuarios_painel SET papel='super_admin', tenant_id='<outro>' WHERE id=auth.uid()`. **Hoje NÃO escala privilégio** (a autz vem do JWT/`app_metadata`; não há trigger `usuarios_painel → app_metadata`), mas é frágil. | **Média** | Se qualquer código futuro passar a confiar em `usuarios_painel.papel`/`tenant_id` para autorização/exibição, vira escalonamento ou visão de outro tenant. É a projeção sendo escrita pelo próprio usuário. | Restringir o `WITH CHECK` do UPDATE para não-super a colunas seguras (nome), ou adicionar trigger-guard como `tenants_guard_colunas`. Idealmente `papel`/`tenant_id` só mutáveis por super/trigger. |
| **M2** | `supabase/migrations/20260724160000_09_api_n8n.sql:21-26,330-345` | Credencial única `n8n_agent` (SECURITY DEFINER, recebe `p_tenant_id` arbitrário) é o maior ponto único de falha. Se a senha vazar / n8n for comprometido, lê KB/credencial e forja billing de **todos** os tenants. Tradeoff consciente ("Opção C"). | **Média** | Comprometer o n8n = acesso cross-tenant total pela API `api_n8n_*`. | Restringir rede (só o host do n8n alcança o Postgres) + rotação periódica da senha do role. |
| **B1** | DB: `uso_ingestao`, `precos_modelo`, `podcast_agendamentos` | `FORCE ROW LEVEL SECURITY` ausente (as demais tabelas de tenant têm). O owner (`postgres`) bypassa RLS. Hoje o app nunca conecta como owner (usa publishable key/`authenticated` ou service_role), então risco baixo. | **Baixa** | Uma query futura rodada como owner da tabela (migração mal feita, script) leria/escreveria sem RLS. | `ALTER TABLE ... FORCE ROW LEVEL SECURITY` em `uso_ingestao` (tabela de tenant) por consistência; opcional nas globais. |
| **B2** | função `tenants_versionar_prompt` (grant PUBLIC/anon/authenticated) | Função de trigger com EXECUTE concedido a PUBLIC. Não é explorável (fora de contexto de trigger ela erra em `NEW`/`TG_OP`), mas o grant é mais amplo que o necessário. | **Baixa** | Nenhum caminho de exploração prático. Higiene. | `REVOKE EXECUTE ON FUNCTION tenants_versionar_prompt() FROM public, anon, authenticated`. |
| **B3** | função `agendar_podcast` (grant `authenticated`) | SECURITY DEFINER que insere PII (nome/empresa/whatsapp) em `podcast_agendamentos`, executável por **qualquer** usuário logado do painel (qualquer tenant). Não vaza dado (a tabela é deny-all na leitura), mas qualquer tenant pode consumir as 6 vagas/dia do podcast. | **Baixa** | Um tenant_admin qualquer ocupa/gasta as vagas do evento de podcast (feature não relacionada). | Se o painel não deve agendar podcast, `REVOKE` de `authenticated` e deixar só o canal público pretendido (anon/serviço específico). |
| **OBS** | `podcast_agendamentos` | Tabela de PII de **outra aplicação** no mesmo banco do painel multi-tenant. Hoje fail-closed (RLS on, 0 policies → não lê via API), mas aumenta o blast-radius de um comprometimento do banco. | Observação | — | Separar em outro projeto/banco Supabase, ou ao menos documentar e minimizar acessos. |

---

## As 5 correções que eu faria primeiro (e por quê)

1. **A1 — Segregar `chatwoot_token`** (Alta). É o único vazamento **real e confirmado**:
   credencial da agência escapando para parte de menor confiança. Fix já pronto na
   branch `fix/segregar-chatwoot-token`; falta aplicar (branch do Supabase + deploy
   coordenado) e **rotacionar o token**.

2. **M1 — Fechar o UPDATE de `usuarios_painel`** (Média). Hoje não escala, mas é uma
   bomba-relógio: a projeção editável pelo próprio usuário é exatamente o tipo de
   "policy que só checa `auth.uid()`" que vira escalonamento assim que alguém confiar
   nela. Barato de corrigir (guard de coluna) e remove a fragilidade.

3. **M2 — Endurecer o `n8n_agent`** (Média). Maior blast-radius do sistema. Não é bug,
   mas isolar a rede do Postgres ao host do n8n + rotacionar a senha reduz drasticamente
   o impacto de um comprometimento — alto retorno para baixo esforço.

4. **B1 — `FORCE RLS` em `uso_ingestao`** (Baixa, mas trivial). Alinha a última tabela de
   tenant ao padrão das demais; fecha a brecha teórica de bypass por owner e custa um
   `ALTER TABLE`.

5. **B3/OBS — Tirar `agendar_podcast` de `authenticated` e planejar a separação de
   `podcast_agendamentos`** (Baixa). Reduz o blast-radius de PII de um app não
   relacionado que hoje divide o banco do painel — dívida de arquitetura que só cresce.

---

### Notas de método
- RLS/policies e grants lidos direto do catálogo do Postgres (`pg_policies`, `pg_class`,
  `pg_proc.proacl`) em produção — não inferidos do código (o schema base 01–08/11 não
  está versionado no repo, o que é um débito de auditabilidade à parte).
- `chatwoot_token` confirmado por chamada real ao PostgREST com sessão de tenant.
- Nada foi alterado nesta auditoria.
