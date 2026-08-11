# Mapa de Rotas — navegação, parâmetros e guards

> Data: **2026-08-06**. Levantamento das rotas do App Router, parâmetros aceitos e do
> guard de autenticação de cada uma, verificado arquivo por arquivo. Complementa
> [`API-PUBLICA.md`](API-PUBLICA.md), que cobre as Server Actions (o outro caminho de
> entrada da aplicação). Nada foi alterado.

## Panorama

**16 rotas navegáveis + 1 route handler.** Não há rota de API própria além do handler de
confirmação: o painel escreve por Server Action, não por `fetch` para `/api/*`.

| Área | Rotas | Guard |
|---|---|---|
| Raiz | 1 | redireciona por papel |
| Autenticação | 3 | público (por desenho) |
| Painel (`tenant_admin`) | 6 | `exigirTenantAdmin` |
| Admin (`super_admin`) | 5 | `exigirSuperAdmin` |
| Route handler | 1 | token de uso único |

**Todas as 11 rotas de área logada têm guard, e o guard bate com o segmento.** Não há uma
única rota sob `(app)` sem verificação — o que é o resultado esperado, mas é o tipo de
coisa que costuma ter uma exceção esquecida.

---

## 1. Tabela de rotas

| Rota | Arquivo | Params | Guard de página | Middleware |
|---|---|---|---|---|
| `/` | `app/page.tsx` | — | `obterUsuarioAtual` → redireciona | — |
| `/login` | `(auth)/login/page.tsx` | `?proximo`, `?erro` | **nenhum** (público) | redireciona **se logado** |
| `/recuperar-senha` | `(auth)/recuperar-senha/page.tsx` | — | **nenhum** (público) | redireciona **se logado** |
| `/nova-senha` | `(auth)/nova-senha/page.tsx` | — | **nenhum** (ver §4) | — |
| `/auth/confirmar` | `auth/confirmar/route.ts` | `?token_hash`, `?type`, `?proximo` | token OTP | — |
| `/painel` | `painel/page.tsx` | — | `exigirTenantAdmin` | exige sessão |
| `/painel/conhecimento` | `painel/conhecimento/page.tsx` | — | `exigirTenantAdmin` | exige sessão |
| `/painel/conversas` | `painel/conversas/page.tsx` | — | `exigirTenantAdmin` | exige sessão |
| `/painel/conversas/[conversationId]` | `.../[conversationId]/page.tsx` | **`conversationId`** (rota) | `exigirTenantAdmin` | exige sessão |
| `/painel/consumo` | `painel/consumo/page.tsx` | — | `exigirTenantAdmin` | exige sessão |
| `/painel/configuracoes` | `painel/configuracoes/page.tsx` | — | `exigirTenantAdmin` | exige sessão |
| `/admin/tenants` | `admin/tenants/page.tsx` | — | `exigirSuperAdmin` | exige sessão |
| `/admin/tenants/novo` | `admin/tenants/novo/page.tsx` | — | `exigirSuperAdmin` | exige sessão |
| `/admin/tenants/[id]` | `admin/tenants/[id]/page.tsx` | **`id`** (rota) | `exigirSuperAdmin` | exige sessão |
| `/admin/catalogo` | `admin/catalogo/page.tsx` | — | `exigirSuperAdmin` | exige sessão |
| `/admin/consumo` | `admin/consumo/page.tsx` | — | `exigirSuperAdmin` | exige sessão |

**Layouts** — o guard também vive neles, e é o que garante cobertura mesmo se uma página
nova esquecer o seu:

| Layout | Guard |
|---|---|
| `app/layout.tsx` (raiz) | — (só `<html>` e script de tema) |
| `(auth)/layout.tsx` | — |
| `(app)/layout.tsx` | **`exigirUsuario`** |
| `(app)/admin/layout.tsx` | **`exigirSuperAdmin`** |

## 2. Camadas de guard

Cada rota de `/admin/**` passa por **três** verificações independentes, e é deliberado:

```
1. middleware.ts        → tem sessão? senão → /login?proximo=<caminho>
2. (app)/layout.tsx     → exigirUsuario()        → senão → /login
   (app)/admin/layout.tsx → exigirSuperAdmin()   → senão → /painel
3. a própria page.tsx   → exigirSuperAdmin()     → senão → /painel
4. RLS no Postgres      → policy por papel/tenant
```

A repetição do passo 3 sobre o passo 2 não é redundância acidental — o comentário em
`auth.ts:88-92` explica: **middleware não é fronteira de segurança**. Ele não roda em
invocação direta de Server Action e o matcher pode ser contornado. A checagem que vale é a
que fica junto do acesso ao dado.

### Middleware — o que ele faz e não faz

```ts
// lib/supabase/middleware.ts
const ROTAS_PROTEGIDAS   = ['/painel', '/admin'];
const ROTAS_AUTENTICACAO = ['/login', '/recuperar-senha'];
```

| Situação | Ação |
|---|---|
| sem sessão + rota protegida | `redirect('/login?proximo=<caminho>')` |
| com sessão + rota de autenticação | `redirect('/')` (que reencaminha por papel) |
| qualquer outro caso | segue, **renovando o token** |

O matcher cobre **tudo** exceto estáticos e imagens — de propósito: o middleware não serve
só para bloquear, é ele que faz o refresh do token. Por isso ele roda também em `/login`.

Detalhe de implementação que evita um bug clássico: os redirects passam por `redirecionar()`
(`:60-66`), que **copia os `Set-Cookie`** que o `getUser()` acabou de gravar. Um
`NextResponse.redirect` cru descartaria a rotação do refresh token e a sessão morreria na
navegação seguinte.

## 3. Parâmetros aceitos

### De rota (dynamic segments)

| Param | Rota | Tipo | Validação |
|---|---|---|---|
| `conversationId` | `/painel/conversas/[conversationId]` | `string` → `Number` | **`Number.isFinite` → `notFound()`** (`:27`); depois `!conversa → notFound()` (`:50`) |
| `id` | `/admin/tenants/[id]` | `string` (UUID) | sem parse; vai para `.eq('id', id)`, e `!tenant → notFound()` (`:49`) |

Ambos são **escopados por tenant/papel antes de virar dado**: a conversa é lida sob RLS com
o JWT do usuário, e o detalhe do tenant exige `super_admin`. Um id alheio na URL devolve
404, não dado de terceiro — que é exatamente a via 3 testada em
`tests/isolamento-fase2.mjs`.

### De query string

| Param | Onde | Uso | Proteção |
|---|---|---|---|
| `proximo` | `/login`, `/auth/confirmar` | destino pós-login | **`destinoSeguro`** — só aceita caminho iniciando com `/` e barra `//host` e `/\host` |
| `erro` | `/login` | mensagem (`link_invalido`, `link_expirado`) | valor renderizado como texto |
| `token_hash` | `/auth/confirmar` | `verifyOtp` | uso único, alta entropia |
| `type` | `/auth/confirmar` | `EmailOtpType` | validado pelo GoTrue |

O `proximo` é o único parâmetro que influencia navegação, e é o que já foi endurecido no
commit `ffbd0dc` contra open redirect por backslash. ⚠️ A regex está **duplicada** em
`(auth)/acoes.ts:25` e `auth/confirmar/route.ts:32`, e nenhuma das cópias tem teste — ver
[`auditorias/AUDIT-COBERTURA.md`](auditorias/AUDIT-COBERTURA.md) §4.

## 4. Grafo de navegação

### Menu lateral (por papel)

```
super_admin                          tenant_admin
  /admin/tenants   "Clientes"          /painel                 "Visão geral"
  /admin/catalogo  "Catálogo"          /painel/conhecimento    "Base de conhecimento"
  /admin/consumo   "Consumo"           /painel/conversas       "Conversas"
                                       /painel/consumo         "Uso"
                                       /painel/configuracoes   "Configurações"
```

O menu vem de `MENU: Record<Papel, ItemMenu[]>` (`sidebar.tsx:33`) — a navegação é
**derivada do papel**, não filtrada por condicional espalhada.

### Redirects

| Origem | Destino | Quando |
|---|---|---|
| `/` | `/admin/tenants` ou `/painel` | por papel (`page.tsx:11`) |
| `/` | `/login` | sem sessão |
| `exigirUsuario` | `/login` | sem sessão (`auth.ts:82`) |
| `exigirSuperAdmin` | `/painel` | papel errado (`auth.ts:96`) |
| `exigirTenantAdmin` | `/admin/tenants` | papel errado (`auth.ts:106`) |
| `sair()` | `/login` | logout |
| `entrar()` | `destinoSeguro(proximo, papel)` | pós-login |
| `excluirTenant()` | `/admin/tenants` | após exclusão |

Note a simetria: o guard errado nunca leva a 403 — leva à **área do papel certo**. Um
`tenant_admin` que digitar `/admin/tenants` cai em `/painel`, e vice-versa.

### `/nova-senha` — a assimetria que parece esquecimento e não é

`/nova-senha` não está em `ROTAS_PROTEGIDAS` nem em `ROTAS_AUTENTICACAO`. Consequências:

- **sem sessão:** a página renderiza, e o `definirNovaSenha` recusa com "Link expirado"
  (ele exige `getUser()`). Falha no lugar certo.
- **com sessão:** ao contrário de `/recuperar-senha`, o usuário **não** é expulso — pode
  trocar a própria senha estando logado.

É comportamento correto nos dois casos, mas a assimetria com `/recuperar-senha` é
intencional e não está comentada. Vale uma linha no código para não ser "corrigida" por
engano.

## 5. Lacuna — nenhum boundary de erro, 404 ou loading

`find src/app -name "error.tsx" -o -name "not-found.tsx" -o -name "loading.tsx"` retorna
**nada**. Consequências:

| Situação | Hoje |
|---|---|
| `notFound()` (3 chamadas, ver §3) | página 404 padrão do Next, fora da identidade do app |
| exceção em Server Component | tela genérica de erro do Next, sem contexto nem caminho de volta |
| navegação para rota com query lenta | sem fallback de streaming — a transição fica parada |

Não é falha de segurança e nada quebra por causa disso, mas é o tipo de arestas que aparece
justo no momento ruim: um cliente clicando num link antigo de conversa recebe uma tela sem
marca, sem menu e sem botão de voltar. Um `not-found.tsx` e um `error.tsx` na raiz de
`(app)` resolvem os dois primeiros casos de uma vez.

---

## Método

Enumeração por `find` de `page.tsx`/`route.ts`/`layout.tsx` em `src/app`; guard de cada
arquivo por busca de `exigirSuperAdmin|exigirTenantAdmin|exigirUsuario|obterUsuarioAtual`
delimitada ao arquivo; parâmetros por leitura das assinaturas `params`/`searchParams` e de
`searchParams.get()`; navegação por `MENU`, `href=`, `redirect()` e `router.push()`. As
regras do middleware vieram da leitura integral de `lib/supabase/middleware.ts`. A
validação de cada parâmetro dinâmico foi confirmada no corpo da página, não presumida.
