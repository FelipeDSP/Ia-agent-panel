# Análise de Segurança Estática — injeção, XSS, CSRF e exposição de dados

> Data: **2026-08-06**. Varredura estática por vetor, a pedido: **SQL injection, XSS,
> CSRF, exposição de dados sensíveis e más práticas**. Apenas relatório — **nada foi
> corrigido**. Complementa [`AUDIT-SEGURANCA.md`](AUDIT-SEGURANCA.md) (2026-08-04), que
> cobre autenticação, autorização e a matriz papel × recurso; aqui não repito o que já
> está lá, foco nos cinco vetores pedidos.

> ## ⚠ ADENDO DE 2026-08-18 — a conclusão acima ficou desatualizada
>
> **"Nenhuma vulnerabilidade explorável" não vale mais.** Em 18/08 foi encontrada
> e **provada** uma exposição de credencial: `api_n8n_pode_transcrever` e
> `api_n8n_enviar_foto` são `SECURITY DEFINER`, devolvem `chatwoot_token` no
> retorno e estavam executáveis por `anon` — a chave publicável, a que vai no
> bundle do navegador.
>
> A prova não é de catálogo. Chamada real, por HTTPS, sem sessão nenhuma:
>
> ```
> POST /rest/v1/rpc/api_n8n_pode_transcrever {"p_tenant_id":"<uuid>", ...}
> → HTTP 200, chatwoot_token preenchido
> ```
>
> Com esse token se fala pelo WhatsApp da loja. **Corrigido pela migração 43**,
> aplicada no mesmo dia; a mesma chamada agora responde `42501`.
>
> **Por que esta varredura não pegou:** ela é de 06/08 e olhou o código da
> aplicação (SQL injection, XSS, CSRF, headers). As seis funções expostas
> nasceram nas migrações **26, 33, 35 e 38** — as três últimas posteriores a
> esta auditoria. O vetor também não estava na lista pedida: **ACL de função no
> Postgres** não é injeção nem XSS, é superfície de API, e só aparece
> consultando `pg_proc.proacl` ou chamando com a chave anônima.
>
> **Sobre a gravidade, com a avaliação corrigida:** o `tenant_id` não é segredo.
> Não vaza pelo painel do cliente, mas aparece em URL do admin e circula em
> conversa, log e suporte. É **identificador conhecido**, não credencial — o que
> significa que a exposição dependia apenas de alguém querer, não de alguém
> descobrir.
>
> **A origem não foi afrouxamento.** Ninguém abriu o que estava fechado: as
> funções nasceram assim, depois da migração 21 ter tirado a credencial do
> alcance do painel. O padrão correto existia **na cabeça de quem escrevia e não
> na verificação** — `tests/grants-n8n.mjs` varria só `api_n8n_*` e ainda tinha
> as três numa allowlist com justificativa falsa. É a mesma família do critério
> de prompt-versus-base do painel: a regra certa, existindo em lugar que não
> alcança quem precisa dela. Agora a asserção é sobre a classe (nenhuma
> `SECURITY DEFINER` executável por `anon`, sem allowlist), então função nova
> nasce coberta.
>
> **Pendente, e não é técnico:** rotacionar os tokens do Chatwoot. Fechar o ACL
> impede vazamento novo e não desfaz o antigo — a rota esteve pública desde a
> criação de cada função.

## Resumo

| Vetor | Achados | Severidade máxima |
|---|---|---|
| **SQL injection** | nenhum | — |
| **XSS** | nenhum explorável | — |
| **CSRF** | nenhum | — |
| **Exposição de dados sensíveis** | 1 (mensagens de erro do Postgres) | **Baixa** |
| **Más práticas / hardening** | 1 (ausência de headers de segurança) | **Média** |

**Nenhuma vulnerabilidade explorável foi encontrada nos quatro primeiros vetores.** Os
dois achados são de defesa em profundidade, não de exploração direta: o mais relevante é
que a aplicação **não emite nenhum header de segurança** — sem CSP, sem
`X-Frame-Options`, sem HSTS.

O que se confirma na varredura é que as defesas estruturais estão no lugar e são
consistentes: **toda** função `SECURITY DEFINER` fixa `search_path`, **toda** ação que
recebe id do cliente filtra por `tenant_id` **e** pelo id, o bucket de arquivos é privado
com policy por pasta de tenant, e não existe uma única query SQL montada por concatenação
de input.

---

## 1. SQL Injection — nenhum achado

| Superfície | Verificação | Resultado |
|---|---|---|
| Queries `pg` cruas (`scripts/`, `tests/`) | busca por `query(\`…\`)` com interpolação | **zero** — todas parametrizadas com `$1, $2` |
| PostgREST (`.eq`, `.filter`, `.or`) | busca por `.or()`/`.filter()`/`.textSearch()` com input | **zero** — os `.filter()` encontrados são de array JS, não de query |
| SQL dinâmico em migrações | `execute format(...)` | 3 ocorrências, todas sobre `pg_catalog` (`f.sig`), sem input externo |
| Funções `SECURITY DEFINER` | `set search_path` presente? | **25+ funções, 100% com `search_path` fixo** |

Uma interpolação existe e foi verificada — `import-producao.mjs:409` monta nomes de coluna
com `${m.conversation_id}` etc. O `m` é `MAPA_CONVERSAS`, um objeto literal **hardcoded**
(`:48-55`); os *valores* na mesma query usam `$1/$2`. Identificador constante, dado
parametrizado: correto.

**O ponto que mais merece destaque é o `search_path`.** Uma função `SECURITY DEFINER` sem
`search_path` fixo é o vetor clássico de escalação de privilégio no Postgres — um usuário
cria `public.now()` no próprio schema e a função privilegiada passa a executá-lo como
dono. Aqui **não há uma única exceção** nas 25+ funções das migrações 09 a 20, incluindo as
de rollback. É a classe de rigor que normalmente falha em pelo menos um arquivo.

## 2. XSS — nenhum achado explorável

Existe **um** `dangerouslySetInnerHTML` em todo o projeto:

```tsx
// src/app/layout.tsx:27,35
const SCRIPT_TEMA = `try{var t=localStorage.getItem('tema');…}catch(e){}`;
<script dangerouslySetInnerHTML={{ __html: SCRIPT_TEMA }} />
```

É uma **string constante sem interpolação nenhuma** — nenhum dado de usuário, de request
ou de banco entra ali. É o padrão consagrado de anti-flash de tema, que precisa rodar
antes da hidratação. Não é XSS.

Zero ocorrências de `innerHTML`, `eval`, `new Function` ou `document.write`. Todo o resto
do render passa por JSX, que escapa por padrão. Conteúdo controlado pelo tenant
(`system_prompt`, nome de documento, `conteudo` de mensagem) é renderizado como texto.

⚠️ **A consequência do script inline aparece no item 5:** ele obriga qualquer CSP futura a
usar `nonce` ou `'unsafe-inline'`. Não é problema hoje — é o custo a considerar quando a
CSP for escrita.

## 3. CSRF — nenhum achado

| Superfície | Proteção |
|---|---|
| 31 Server Actions | Next 15 valida `Origin` contra `Host` por padrão; `serverActions.allowedOrigins` não está configurado, ou seja, **só mesma origem** |
| Cookies de sessão | geridos por `@supabase/ssr` (`HttpOnly`, `Secure`, `SameSite=Lax` por padrão do GoTrue) |
| `GET /auth/confirmar` | muda estado (`verifyOtp`) via GET, mas exige `token_hash` de alta entropia, de uso único, entregue por email — não forjável por terceiro |

O padrão de cookies no middleware (`middleware.ts:20-28`) parece assimétrico à primeira
leitura — o primeiro laço itera sem `options` e o segundo com. Verifiquei: o primeiro
escreve em `request.cookies` (leitura downstream no mesmo passe, onde `options` não se
aplica) e o segundo em `resposta.cookies`, **com** `options`. É exatamente o padrão
canônico do `@supabase/ssr`. Nenhum atributo de cookie é perdido.

## 4. Exposição de dados sensíveis

### O que está protegido (verificado, não presumido)

| Dado | Proteção |
|---|---|
| `SUPABASE_SECRET_KEY` | só em `lib/supabase/admin.ts`, com `import 'server-only'`; importador único é uma action `'use server'` |
| `chatwoot_token` | **nunca** chega a componente client — lido apenas server-side em `admin/acoes.ts:340` para preservar no edit; o campo do form vai vazio |
| tokens de `mensagens_log` | a página **não lê a tabela**; usa a RPC `conversa_historico`, que retorna só `direcao, conteudo, criado_em` e filtra por `auth_tenant_id()` |
| arquivos da base de conhecimento | bucket **privado**, policies por `(storage.foldername(name))[1] = auth_tenant_id()`, `file_size_limit` 10 MiB e MIME whitelist no próprio bucket |
| `.env` | corretamente ignorado; só `.env.local.exemplo` versionado, com placeholders |
| variáveis `NEXT_PUBLIC_*` | apenas URL, publishable key e site URL — todas públicas por desenho |
| enumeração de usuário | login e recuperação de senha devolvem mensagem genérica, deliberadamente |
| IDOR nas actions com id do cliente | as 6 filtram por `tenant_id` **e** pelo id; `reprocessar` ainda valida o prefixo do path no Storage |

### 🟡 Achado — mensagem de erro do Postgres devolvida ao browser (Baixa)

**~20 ocorrências** em Server Actions no formato:

```ts
return { erro: `Não foi possível salvar: ${error.message}` };
```

`error.message` vem do PostgREST/Postgres e pode carregar nome de constraint, de coluna, de
tabela e às vezes o valor que violou a restrição. Exemplo do que pode vazar para a tela:
`duplicate key value violates unique constraint "tenants_chatwoot_account_id_key"`.

Severidade **baixa**: quem vê a mensagem já está autenticado, e o schema não é segredo. Mas
é reconhecimento gratuito — em particular na tela de super_admin, onde `error.message` pode
descrever estrutura que o tenant_admin nunca deveria inferir. O padrão saudável é logar o
`error` completo no servidor e devolver mensagem estável ao usuário.

Vale notar que o projeto **já faz isso certo** onde importa mais: `entrar` e
`pedirRecuperacao` descartam o erro real e respondem genericamente, com comentário
explicando que distinguir os casos entregaria emails ao atacante.

## 5. Más práticas / hardening

### 🟠 Achado — nenhum header de segurança configurado (Média)

`next.config.ts` não define `headers()`, e o middleware não injeta nada. A aplicação
responde **sem**:

| Header | Ausente | Consequência |
|---|---|---|
| `Content-Security-Policy` | ✔ | nenhuma contenção se um XSS aparecer no futuro |
| `X-Frame-Options` / `frame-ancestors` | ✔ | **clickjacking** — o painel pode ser embutido em iframe de terceiro |
| `Strict-Transport-Security` | ✔ | primeira visita sujeita a downgrade |
| `X-Content-Type-Options: nosniff` | ✔ | MIME sniffing |
| `Referrer-Policy` | ✔ | URL do painel (com ids de tenant) vaza no `Referer` para terceiros |

O mais concreto dos cinco é o **clickjacking**: sem `X-Frame-Options`/`frame-ancestors`, um
site hostil pode carregar `/painel` num iframe invisível e induzir cliques em ações
destrutivas — e há botões de exclusão de documento e de tenant no app.

Os quatro primeiros são uma entrada em `next.config.ts`. A CSP é o único que dá trabalho,
por causa do `<script>` inline do item 2 (exige `nonce` ou `'unsafe-inline'`) e dos estilos
inline do Next — vale escrever em `Report-Only` primeiro.

### 🔵 Observações menores

- **Sem rate limiting próprio no login.** `entrar` chama `signInWithPassword` sem
  throttle na aplicação. O GoTrue do Supabase aplica limite próprio, então não é buraco
  aberto — mas o painel não controla nem observa esse limite.
- **A checagem de tamanho de upload é dupla e ambas de arquivo**, não de texto extraído
  (Server Action `:50` e `file_size_limit` do bucket). Isso é melhor do que a
  [`AUDIT-MEMORIA.md`](AUDIT-MEMORIA.md) §4 sugeriu — o bucket também barra —, mas a
  observação de fundo continua: 10 MiB de DOCX podem virar dezenas de milhões de
  caracteres, e nada limita o texto extraído.
- **`definirNovaSenha` aceita qualquer sessão válida**, não só a de recovery. Já anotado
  na auditoria anterior; segue aceitável (o usuário troca a própria senha).
- **Nenhuma das defesas puras tem teste de regressão** — a correção de open redirect do
  commit `ffbd0dc` não veio acompanhada de teste, e a regex está duplicada em dois
  arquivos. Detalhado em [`AUDIT-COBERTURA.md`](AUDIT-COBERTURA.md) §4.

---

## Consolidado

| # | Achado | Severidade | Esforço |
|---|---|---|---|
| 1 | `X-Frame-Options`, `nosniff`, HSTS, `Referrer-Policy` em `next.config.ts` | **Média** | ~20 min |
| 2 | CSP (começar em `Report-Only`; exige nonce pelo script de tema) | Média | ~2 h |
| 3 | Parar de devolver `error.message` cru; logar no servidor | Baixa | ~1 h |
| 4 | Teste de regressão das defesas puras (redirect, `segredoConfere`) | Baixa | ver `AUDIT-COBERTURA.md` |

Nada aqui é exploração ativa nem exige ação de emergência. O item 1 é o de melhor relação
custo/benefício do documento — quatro linhas de configuração fecham o único vetor com
cenário de ataque concreto (clickjacking).

---

## Método

`grep` dirigido por vetor sobre `src/`, `scripts/`, `tests/`, `supabase/migrations/`,
`supabase/baseline/` e a Edge Function: interpolação em SQL, `dangerouslySetInnerHTML`/
`innerHTML`/`eval`, `security definer` + `search_path`, `sameSite`/`httpOnly`, `NEXT_PUBLIC_`,
`console.*`, `error.message`, e leitura integral de `middleware.ts`, `auth.ts`,
`(auth)/acoes.ts`, `admin.ts`, `config.ts` e das migrações 09/14/15/18. Cada suspeita foi
lida no arquivo antes de virar achado — três candidatos (cookies do middleware, o script
inline de tema, a interpolação em `import-producao.mjs`) foram descartados por leitura, e
estão registrados acima com o motivo para não serem reabertos. **Análise estática apenas:
nada foi executado contra o ambiente e nenhum teste de penetração foi realizado.**
