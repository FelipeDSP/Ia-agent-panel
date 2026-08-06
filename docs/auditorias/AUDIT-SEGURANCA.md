# Auditoria de Segurança — ChatYou · IA

> Investigação apenas — **nada foi corrigido nesta auditoria**. Achados baseados em
> leitura do código-fonte e verificação direta no banco de produção (RLS, policies,
> grants via `pg_catalog`) e na Edge Function. Achados não confirmados estão isolados
> na seção **Inconclusivo**. Data: 2026-08-04.

## Metodologia
Li os arquivos (não presumi por nome): `middleware.ts`, `lib/supabase/{middleware,server,admin,config}.ts`, `lib/auth.ts`, `(auth)/acoes.ts`, todas as server actions de `(app)/**`, `lib/tenants/schema.ts`, `lib/{n8n,ingestao,chatwoot}.ts`, `next.config.ts`, e a Edge Function `processar-ingestao`. RLS/policies/grants lidos do Postgres em produção.

---

## 1. Autenticação
- **Sessão:** Supabase GoTrue via `@supabase/ssr` (cookies). Criada em `signInWithPassword` (`(auth)/acoes.ts:39`).
- **Validação:** `getUser()` (revalida no servidor) no middleware (`lib/supabase/middleware.ts:41-43`), nos layouts e em toda action. **Nenhum `getSession()`** (grep global confirma). Um cookie forjado não passa.
- **Renovação:** refresh no middleware, com cuidado de preservar os `Set-Cookie` de rotação no redirect (`middleware.ts:60-66`). Correto.
- **Expiração:** TTL do token GoTrue + rotação do refresh.
- **Rotas protegidas:** middleware bloqueia `/painel` e `/admin` sem sessão (`middleware.ts:68-74`) **e** cada layout/página/action re-verifica (defesa em profundidade). Nenhuma verificação de dado feita só no client — componentes `'use client'` são só UI e chamam actions com guard.
- **Recuperação de senha:** anti-enumeração (resposta genérica, `acoes.ts:96`); link → `/auth/confirmar` (verifyOtp) → `/nova-senha` (exige sessão). **Open redirect por backslash JÁ FOI corrigido** nesta sessão (ver Resolvidos).
- Nota menor (M-x abaixo não; observação): `definirNovaSenha` (`acoes.ts:118-126`) aceita qualquer sessão válida, não só a de recovery — aceitável (troca a própria senha).

## 2. Autorização — matriz papel × recurso × operação
Papéis: `anon`, `tenant_admin`, `super_admin` (JWT `app_metadata`), `n8n_agent` (role Postgres), `service_role` (server-only).

| Recurso | anon | tenant_admin | super_admin | Onde é imposto |
|---|---|---|---|---|
| tenants (própria) | — | R / U (colunas whitelist) | CRUD | RLS `p_tenants_*` + trigger `tenants_guard_colunas` + guard action |
| tenants (outras) | — | ❌ | CRUD | RLS (`id = auth_tenant_id()`) |
| conversas / kb_documentos / jobs / prompt_versoes / tenant_tools | — | CRUD do próprio tenant | CRUD | RLS `tenant_id = auth_tenant_id()` (FORCE) + `.eq(tenant)` |
| mensagens_log / uso_ingestao / precos_modelo (custo) | — | ❌ | CRUD | RLS `auth_is_super_admin()` |
| usuarios_painel | — | R do próprio tenant; U da **própria linha** | CRUD | RLS (ver M2) |
| billing custo (USD) | — | ❌ (raise 42501) | ✅ | `billing_consumo_mensal` gate interno |
| Storage `kb-arquivos/<tenant>/*` | — | RW da própria pasta | — | RLS storage por `foldername = auth_tenant_id()` |
| api_n8n_* (RPC) | ❌ | ❌ | ❌ (só `n8n_agent`) | `REVOKE` de authenticated/anon |

**Checagem sempre ANTES da operação** (guard na 1ª linha da action) e **nunca depende de valor do request** para papel/tenant (vêm do JWT). Ações super_admin que recebem `tenant_id`/`user_id` do form validam ownership no banco antes (`carregarAdminDoTenant`, `admin/acoes.ts:178`).

## 3. IDOR
Todo endpoint com identificador do cliente foi verificado:
- `definirStatusConversa(conversationId)` — `.eq('tenant_id', JWT).eq('conversation_id', id)` + rowcount guard (`conversas/acoes.ts:41-47`).
- `limparMemoriaConversas(ids|'todas')` — re-resolve os ids do banco escopados por tenant; lista crua do request nunca vira alvo (`conversas/acoes.ts:99-116`).
- `excluirDocumento/verConteudoDocumento/dispensarJob/reprocessar` — todos `.eq('tenant_id', JWT)` (`conhecimento/acoes.ts`).
- `restaurarVersaoPrompt(id)` — lê e compara `tenant_id` contra o JWT (`prompt-acoes.ts:71`).
- Ações admin — `exigirSuperAdmin` + validação de ownership do alvo.
**Nenhum IDOR.** RLS `FORCE` é a rede caso uma action esqueça o filtro.

## 4. Validação de entrada / mass assignment
- Validadores em `lib/tenants/schema.ts` extraem **campos nomeados** e validam (modelo contra whitelist, temperatura 0–2, debounce 1–60, slug normalizado). **Nunca espalham o FormData inteiro** → **sem mass assignment**.
- Ações de update montam o objeto só com campos validados (`painel/acoes.ts:40-46`, `salvarTransferirHumano` preserva a `sessao`/infra da agência — cliente não injeta).
- Backstop: CHECKs no banco + trigger `tenants_guard_colunas` bloqueia colunas privilegiadas.

## 5. Injeção
- Queries via query builder do supabase-js (parametrizadas) e RPCs com parâmetros tipados. **Nenhuma concatenação de SQL** no código.
- Sem execução de shell. Sem deserialização insegura.
- Sem renderização de template com input do usuário no app (o template de e-mail é do GoTrue; a Edge Function insere via RPC parametrizada `kb_reindex_documento`). **Limpo.**

## 6. Upload de arquivo
- `subirArquivo` (`conhecimento/acoes.ts:40-101`): valida por **extensão** (mapa `TIPOS`), limite **10 MB**, path = `${tenantId}/${randomUUID()}.${ext}` (sem path traversal — nome original só vira rótulo do job, não o path). Bucket **privado**, servido só via RLS por pasta = tenant.
- **Gap (Baixa):** validação é por extensão, não por conteúdo real (magic bytes). Mitigado por `allowed_mime_types` no bucket e pelo tratamento de erro de extração na Edge Function.

## 7. Segredos
- `admin.ts:1` `import 'server-only'` + rejeita chave pública; `chatwoot.ts`/`ingestao.ts`/`n8n.ts` server-only. **Nenhum secret hardcoded** no `src/`.
- Só `NEXT_PUBLIC_` seguros no bundle: URL, publishable key, site URL. `.gitignore` cobre `.env*.local`.
- **Achado (Média):** repositório é **público** e o histórico (commit `20ebe2e`) contém PII (telefone real de teste do export do n8n, depois removido do tracking). Segredos de app não vazaram, mas a PII permanece no histórico.

## 8. Rate limiting / brute force
- **Achado (Média):** **nenhum rate limiting a nível de aplicação**. Login (`signInWithPassword`) e recuperação dependem inteiramente dos limites do Supabase GoTrue. Há anti-enumeração no login/recover (bom), mas nenhuma proteção própria contra brute force nas actions.

## 9. Headers / CORS / CSRF
- **Achado (Média):** `next.config.ts` **não define nenhum header de segurança** — sem CSP, `X-Frame-Options` (clickjacking), `X-Content-Type-Options`, HSTS, `Referrer-Policy`, `Permissions-Policy`.
- **CSRF:** Server Actions do Next têm proteção nativa (checagem de Origin + refs de ação cifradas). Adequado.
- **CORS:** app é same-origin; não abre CORS próprio. O PostgREST do Supabase aceita a publishable key de qualquer origem, mas é protegido por RLS + JWT.

## 10. Webhooks / callbacks
- **Entrada:** Edge Function `processar-ingestao` — portão `x-ingestao-secret` com comparação **timing-safe** (`index.ts:312-319`) e `verify_jwt=false` por design. **Sem proteção anti-replay** (nonce/timestamp), mas reprocessar é idempotente (swap) e o segredo é server-only → risco baixo.
- **Saída:** `n8n.ts` (limpar memória) e `ingestao.ts` disparam com segredo compartilhado no header, timeout, `cache:no-store`. Isolamento por `tenant_id` do JWT. Sem injeção (corpo JSON).
- **Observabilidade:** nenhum SDK Sentry/analytics e nenhum `console.log/info/debug` no `src/` — não há terceiro recebendo dados nem tracking.

---

## Achados (ordenados por severidade)

| ID | Arquivo:linha | Achado | OWASP | Sev | Cenário de exploração | Correção sugerida |
|---|---|---|---|---|---|---|
| S1 | `tenants.chatwoot_token` + policy `p_tenants_select` + `admin/acoes.ts` | RLS filtra linha, não coluna: tenant_admin lê a própria linha de `tenants`, logo lê `chatwoot_token` (credencial de Agent Bot da agência). **Confirmado ao vivo** (GET PostgREST → 200 + token). | A01 | **Alta** | tenant_admin extrai o token pelo browser e posta como o bot no Chatwoot da conta. | Segregar credenciais em tabela sem policy de tenant (branch `fix/segregar-chatwoot-token` pronta) + rotacionar. |
| S2 | `next.config.ts:3-21` | Nenhum header de segurança (CSP, X-Frame-Options, HSTS, etc.). | A05 | **Média** | Clickjacking (painel embutido em iframe malicioso); sem CSP, um XSS teria alcance total. | Adicionar `headers()` com CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options`, HSTS, `Referrer-Policy`, `Permissions-Policy`. |
| S3 | `(auth)/acoes.ts:39` (login) / `:87` (recover) | Sem rate limiting a nível de app; depende 100% do GoTrue. | A07 | **Média** | Brute force de senha se os limites do Supabase estiverem frouxos/desligados. | Ativar Attack Protection no Supabase (CAPTCHA, leaked-password) e/ou throttle próprio; confirmar os Rate Limits. |
| S4 | commit `20ebe2e` (repo público) | PII (telefone real) no histórico do git de um repositório público. | Exposição de dados | **Média** | Qualquer um clona o repo e lê a PII do histórico. | Tornar o repo privado ou reescrever o histórico (filter-repo) + rotacionar o que for sensível. |
| S5 | policy `p_usuarios_update` (schema base) | UPDATE de `usuarios_painel` por `id=auth.uid()` sem guard de coluna; usuário edita `papel`/`tenant_id` da própria projeção. Hoje **não** escala (autz vem do JWT; sem trigger reverso), mas frágil. | A01 | **Média** | Vira escalonamento se algum código futuro confiar em `usuarios_painel.papel`. | Guard de coluna (como `tenants_guard_colunas`) ou restringir o `WITH CHECK`. |
| S6 | `09_api_n8n.sql:21-26,330-345` | Credencial única `n8n_agent` com acesso definer a todos os tenants. | A01/A05 | **Média** | Comprometer o n8n = acesso cross-tenant total. | Restringir rede ao host do n8n + rotação periódica. |
| S7 | `conhecimento/acoes.ts:54-65` | Upload validado por extensão, não por conteúdo real. | A05/A08 | **Baixa** | Arquivo renomeado passa da checagem de extensão. | Validar magic bytes; manter `allowed_mime_types` do bucket. |
| S8 | DB: `uso_ingestao`, `precos_modelo`, `podcast_agendamentos` | `FORCE ROW LEVEL SECURITY` ausente (owner bypassa). App não conecta como owner hoje. | A05 | **Baixa** | Query futura como owner leria sem RLS. | `ALTER TABLE ... FORCE ROW LEVEL SECURITY`. |
| S9 | Edge Function `processar-ingestao` | Sem proteção anti-replay no webhook (idempotente + segredo server-only mitigam). | A08 | **Baixa** | Replay de request capturada reprocessa um job (efeito nulo). | Nonce/timestamp assinado, se quiser defesa extra. |
| S10 | função `tenants_versionar_prompt` (grant PUBLIC) | EXECUTE de função de trigger concedido a PUBLIC/anon (não explorável; higiene). | A05 | **Baixa** | Nenhum caminho prático. | `REVOKE EXECUTE ... FROM public, anon, authenticated`. |
| S11 | função `agendar_podcast` (grant `authenticated`) | Qualquer usuário logado (qualquer tenant) agenda podcast (feature não relacionada; consome vagas). | A01 | **Baixa** | Tenant qualquer ocupa as 6 vagas/dia. | `REVOKE` de `authenticated`; expor só ao canal público pretendido. |

## Inconclusivo (não confirmado nesta auditoria)
- **Attack Protection / Rate Limits do Supabase** (CAPTCHA, leaked-password, valores dos limites) — configurados no dashboard, não verificados aqui. Impacta a severidade real de **S3**.
- **Headers na borda (Vercel/Coolify)** — o host pode injetar alguns headers de segurança que o app não define; não verificado. Impacta **S2**.
- **Schema base (migrations 01–08/11)** não versionado no repo — li as policies **vivas** (RLS confirmado), mas a DDL exata (CHECKs, constraints, defaults) não é auditável a partir da fonte.
- **Conteúdo dos logs de produção** (Coolify/Vercel runtime) — não revisei os logs em si; no código só há `console.error` sem PII.

## Resolvidos nesta sessão (não são achados abertos)
- **Open redirect** por backslash em `destinoSeguro`/`auth/confirmar` — corrigido no `main`.
- **`INGESTAO_SECRET` vazio** abriria o portão da Edge Function — guard adicionado.
- **`match_count` sem clamp** em `match_kb_documentos` — clamp aplicado.

---

## As 5 correções prioritárias

1. **S1 — Segregar `chatwoot_token`** (Alta). Único vazamento **real e confirmado**: credencial da agência acessível ao cliente. Fix pronto na branch; falta rollout coordenado + rotação. Maior risco, maior retorno.
2. **S2 — Headers de segurança** (Média, esforço baixo). Um `headers()` no `next.config.ts` fecha clickjacking e limita o raio de um XSS futuro; é a mitigação de maior alcance por menos esforço.
3. **S4 — PII no repositório público** (Média). Enquanto o repo for público, a PII no histórico é exposição contínua e fora do seu controle. Tornar privado é imediato.
4. **S3 — Brute force / Attack Protection** (Média). Endpoint de login público sem defesa própria; ativar CAPTCHA/leaked-password no Supabase e confirmar os rate limits protege as contas com pouco esforço.
5. **S5 — Guard de coluna em `usuarios_painel`** (Média). Remove a fragilidade de escalonamento antes que algum código futuro passe a confiar na projeção — barato agora, caro depois.

### Nota final
A base é **sólida**: multi-tenancy com RLS `FORCE` + filtro explícito + guard em toda action, `getUser()` em todo lugar, service_role isolado no servidor, sem injeção, sem mass assignment, sem IDOR. Os achados abertos são um vazamento real de credencial (S1) e, no restante, endurecimento de configuração e defesa em profundidade.
