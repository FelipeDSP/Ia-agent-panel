# IA Agent Panel

Painel multi-tenant de gestão de agentes de IA conversacionais. Uma agência
provisiona um agente por empresa cliente; cada cliente edita o próprio prompt e a
própria base de conhecimento sem tocar em SQL. O agente em si roda **fora** do
painel (n8n) e lê **do mesmo banco Postgres** — o painel é a interface de
administração, não o runtime do agente.

> Antes de mexer no código, leia `ESPECIFICACAO.md` (modelo de dados e decisões de
> arquitetura) e `CLAUDE.md` (regras de multi-tenancy e convenções).

## Stack

- **Next.js 15** (App Router) + TypeScript strict
- **Supabase**: Postgres 17 + Auth + Storage + Edge Functions (Deno)
- `@supabase/ssr` para integração com o App Router
- Tailwind + shadcn/ui
- **OpenAI** `text-embedding-3-small` (1536 dims) para embeddings
- Deploy: **Coolify** (Dockerfile) — também compatível com Vercel

## Arquitetura em uma frase

Dois consumidores do mesmo Postgres: **o painel** (este repositório) e **o n8n**
(o runtime do agente). Mudanças em `kb_documentos`, `conversas` e `tenants`
impactam os dois.

---

## Desenvolvimento local

Pré-requisitos: Node 20+, um projeto Supabase com as migrações aplicadas.

```bash
npm install
cp .env.local.exemplo .env.local   # e preencha os valores
npm run dev                        # http://localhost:3000
```

Scripts úteis:

| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento |
| `npm run build` | Build de produção (falha em erro de tipo — critério do `CLAUDE.md`) |
| `npm run start` | Serve o build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run criar-super-admin` | Cria o primeiro usuário super_admin |
| `npm run teste:isolamento` | Testa isolamento entre tenants |

---

## Variáveis de ambiente

Copie `.env.local.exemplo` e preencha. **Atenção ao momento em que cada variável é
lida** — isso muda como configurá-las no Coolify.

### Do painel (Next.js)

| Variável | Momento | Segredo? | Para que serve |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Build** | Não (pública) | URL do projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | **Build** | Não (pública) | Chave publishable/anon (protegida por RLS) |
| `NEXT_PUBLIC_SITE_URL` | **Build** | Não | Base dos links de recuperação/confirmação de senha (ex.: `https://painel.suaempresa.com`) |
| `SUPABASE_SECRET_KEY` | **Runtime** | **SIM** | Chave secreta (ignora RLS). Só servidor. Nunca prefixar com `NEXT_PUBLIC_` |
| `INGESTAO_SECRET` | **Runtime** | **SIM** | Segredo compartilhado com a Edge Function de ingestão |

> **Por que "Build" vs "Runtime"?** No Next.js, tudo que começa com `NEXT_PUBLIC_`
> é **embutido no bundle em tempo de build** — precisa existir durante
> `npm run build`. Os segredos de servidor (`SUPABASE_SECRET_KEY`,
> `INGESTAO_SECRET`) são lidos só em runtime.

### Da Edge Function `processar-ingestao` (definidas no Supabase, não no painel)

Configuradas com `supabase secrets set NOME=valor`:

| Variável | Para que serve |
|---|---|
| `OPENAI_API_KEY` | Chave da OpenAI (embeddings) |
| `INGESTAO_SECRET` | **O mesmo valor** do `INGESTAO_SECRET` do painel |
| `CHUNK_ALVO_CHARS` | Opcional. Alvo de chars por chunk (padrão ~450–600) |
| `CHUNK_OVERLAP_CHARS` | Opcional. Overlap entre chunks (padrão ~120) |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são injetados automaticamente na
Edge Function.

### De scripts de carga/teste (não usadas pelo app em execução)

`PROD_DB_URL` e `SUPABASE_DB_URL` — só para os scripts em `scripts/` e `tests/`.
**Não** precisam ir para o Coolify.

---

## Deploy na Coolify

Deploy via **Dockerfile** (já incluído; usa `output: 'standalone'` do Next para
uma imagem enxuta).

### 0. Pré-requisitos

- Projeto Supabase com **as migrações de `supabase/migrations/` aplicadas** e a
  Edge Function `processar-ingestao` deployada (ver seção seguinte).
- Uma instância Coolify com acesso ao repositório Git.
- Chave OpenAI (para a ingestão de documentos).

### 1. Criar a aplicação

1. No Coolify: **+ New** → **Application** → **Public/Private Repository**.
2. Aponte para este repositório e o branch `main`.
3. **Build Pack:** selecione **Dockerfile** (o Coolify detecta o `Dockerfile` na
   raiz).
4. **Port / Ports Exposes:** `3000`.

### 2. Variáveis — de BUILD

Em **Environment Variables**, adicione e marque como **"Build Variable"**
(disponível em build time — o Coolify as passa como `--build-arg`, e os nomes
batem com os `ARG` do `Dockerfile`):

```
NEXT_PUBLIC_SUPABASE_URL=https://SEU_PROJETO.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
NEXT_PUBLIC_SITE_URL=https://painel.suaempresa.com
```

### 3. Variáveis — de RUNTIME (segredos)

Adicione **sem** marcar como build (ficam só em runtime):

```
SUPABASE_SECRET_KEY=sb_secret_...
INGESTAO_SECRET=<mesmo valor usado no secret da Edge Function>
```

> Gere o `INGESTAO_SECRET` com algo como `openssl rand -hex 32` e use **o mesmo
> valor** aqui e no `supabase secrets set INGESTAO_SECRET=...`.

### 4. Domínio

1. Em **Domains**, defina o FQDN (ex.: `https://painel.suaempresa.com`). O Coolify
   provisiona HTTPS via Let's Encrypt.
2. Ajuste `NEXT_PUBLIC_SITE_URL` para esse domínio e **redeploy** (é variável de
   build — só entra no bundle num novo build).

### 5. Ajustar o Supabase Auth

No painel do Supabase → **Authentication → URL Configuration**:

- **Site URL:** `https://painel.suaempresa.com`
- **Redirect URLs:** adicione `https://painel.suaempresa.com/**`

Sem isso, os links de recuperação/confirmação de senha apontam para o lugar
errado.

### 6. Deploy

Clique em **Deploy**. O Coolify faz o build da imagem (`npm ci` → `npm run build`
→ standalone) e sobe o container na porta 3000.

> **Health check (opcional):** a rota `/` responde com redirect (`307`) para
> `/login`. Se o health check do Coolify tratar 3xx como falha, aponte-o para
> `/login` ou aceite códigos 3xx.

---

## Edge Function de ingestão (deploy separado, no Supabase)

O painel dispara a ingestão, mas o processamento roda numa Edge Function do
Supabase — deployada à parte, não no container do Coolify:

```bash
supabase functions deploy processar-ingestao --no-verify-jwt
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set INGESTAO_SECRET=<mesmo valor do painel>
```

`--no-verify-jwt`: a função usa autenticação própria via header
`x-ingestao-secret` em vez do JWT do Supabase.

---

## Migrações

As migrações estão em `supabase/migrations/`, cada uma com um arquivo
`_rollback.sql` correspondente. Aplique-as ao projeto Supabase (via `supabase db
push`, o dashboard, ou o MCP) **antes** do primeiro deploy.

> **Produção existente:** há um cliente real (Acqua Lavanderia) cujo agente em n8n
> lê deste mesmo banco. Não trate como ambiente limpo — veja `CLAUDE.md` e
> `ESPECIFICACAO.md` antes de qualquer migração de schema.

## Segurança / multi-tenancy

Regras não-negociáveis (detalhadas em `CLAUDE.md`):

- `tenant_id` vem **sempre** do JWT (`app_metadata`), nunca do request.
- Toda tabela com `tenant_id` tem RLS ativo com policy.
- `SUPABASE_SECRET_KEY` (service role) **só no servidor** — nunca em código client.
- O custo em USD (billing) nunca chega ao browser do tenant_admin.
