# Variáveis de Ambiente

> Data: **2026-08-06**. Levantamento de toda leitura de `process.env` e `Deno.env.get`
> em `src/`, `scripts/`, `tests/`, na Edge Function e no `Dockerfile`, incluindo **acesso
> indireto por helper** (`envInt`, `exigirVariavel`), que uma busca literal não encontra.
> **14 variáveis.** Nada foi alterado.

## Panorama

| Consumidor | Variáveis | Onde se define |
|---|---|---|
| Painel (Next.js) | 7 | `.env.local` / env do container |
| Edge Function | 5 | `supabase secrets set` (2 injetadas automaticamente) |
| Scripts e testes | 3 | ambiente do shell / `.env.local` |

**Duas variáveis reais do sistema não estão em `.env.local.exemplo`:**
`CHUNK_ALVO_CHARS` e `CHUNK_OVERLAP_CHARS`. Elas existem, têm efeito grande e são lidas
por um helper (`envInt(nome, padrao)`), o que as torna invisíveis a qualquer busca por
`Deno.env.get('...')`. Estão documentadas no `CLAUDE.md`, mas não onde alguém configurando
o ambiente iria procurar. É a §4.

---

## 1. Painel (Next.js)

| Variável | Obrigatória | Default | Referências |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **sim** | — | `lib/supabase/config.ts:21` · `scripts/criar-super-admin.mjs:72` · 3 testes |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | **sim** | — | `lib/supabase/config.ts:26` · 3 testes |
| `NEXT_PUBLIC_SITE_URL` | **na prática sim** | `'http://localhost:3000'` ⚠️ | `admin/acoes.ts:140,298` · `(auth)/acoes.ts:85` · `auth/confirmar/route.ts:23` |
| `SUPABASE_SECRET_KEY` | **sim** (para ações de super_admin) | — | `lib/supabase/admin.ts:20` · `criar-super-admin.mjs:79` |
| `INGESTAO_SECRET` | **sim** (para ingestão) | — | `lib/ingestao.ts:20` |
| `N8N_LIMPEZA_URL` | não | — | `lib/n8n.ts:29` |
| `N8N_LIMPEZA_SECRET` | não | — | `lib/n8n.ts:30` |

### O que cada uma faz e o que quebra sem ela

**`NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`**
Endereço do projeto e chave pública. Vão para o bundle do browser **por desenho** — quem
protege o dado é o RLS, não o segredo da chave. Ambas passam por `obrigatoria()`
(`config.ts:12`), que **lança no import**: falta = a aplicação não sobe, com mensagem
dizendo qual variável e onde pegá-la. Falha alta e imediata, do jeito certo.

**`NEXT_PUBLIC_SITE_URL`** — ⚠️ *ver §4, é a de maior risco silencioso*
Origem canônica para montar links de convite, recuperação de senha e os redirects de
`/auth/confirmar`. Existe porque atrás do proxy da Coolify o container se enxerga como
`0.0.0.0:3000`, e usar o `origin` do request mandava o navegador para um host inalcançável
— foi exatamente o bug corrigido em `f70be7e`.

**`SUPABASE_SECRET_KEY`**
Chave secreta da Admin API. Ignora RLS e enxerga todos os tenants — **servidor apenas**,
protegida por `import 'server-only'` em `lib/supabase/admin.ts`. A leitura é **preguiçosa**:
só lança quando uma ação de super_admin roda, não no boot. Além de exigir presença, valida
que **não** é uma chave publishable (`admin.ts:31`) — erro comum que produziria falhas
confusas de permissão em vez de uma mensagem clara.

**`INGESTAO_SECRET`**
Segredo compartilhado entre painel e Edge Function (header `x-ingestao-secret`). Precisa do
**mesmo valor nos dois lados**: `.env.local` do painel e `supabase secrets set`. Sem ele o
painel recusa com mensagem explícita (`ingestao.ts:27`) e a função é fail-closed.

**`N8N_LIMPEZA_URL` · `N8N_LIMPEZA_SECRET`**
Webhook do n8n para limpar a memória conversacional no Redis. **As únicas genuinamente
opcionais:** em branco, o botão devolve erro amigável (`n8n.ts:35`) e o resto do painel
segue funcionando. Degradação graciosa, e documentada como tal no exemplo.

## 2. Edge Function `processar-ingestao`

Definidas com `supabase secrets set NOME=valor`, **não** no `.env.local`.

| Variável | Obrigatória | Default | Referência |
|---|---|---|---|
| `SUPABASE_URL` | sim — **injetada automaticamente** | — | `index.ts:20` |
| `SUPABASE_SERVICE_ROLE_KEY` | sim — **injetada automaticamente** | — | `index.ts:21` |
| `OPENAI_API_KEY` | **sim** | — | `index.ts:22` |
| `INGESTAO_SECRET` | **sim** | — | `index.ts:26` |
| `CHUNK_ALVO_CHARS` | não | **450** | `index.ts:45` (via `envInt`) |
| `CHUNK_OVERLAP_CHARS` | não | **120** | `index.ts:48` (via `envInt`, clampado a `ALVO−1`) |

> ⚠️ **Cuidado com o nome `SUPABASE_URL`.** Em `src/lib/`, `SUPABASE_URL` é uma **constante
> importada** de `config.ts` (que lê `NEXT_PUBLIC_SUPABASE_URL`), não uma variável de
> ambiente. A variável de ambiente `SUPABASE_URL` existe só no runtime da Edge Function,
> onde o Supabase a injeta. Mesmo nome, origens diferentes.

As quatro primeiras usam asserção não-nula (`Deno.env.get(...)!`): se faltarem, o erro
aparece no uso, não na partida. Na prática `OPENAI_API_KEY` ausente vira `Bearer undefined`
→ 401 da OpenAI → job marcado com `erro`, visível no painel. Aceitável, mas o diagnóstico
chega como "OpenAI 401", não como "faltou a chave".

## 3. Scripts e testes

| Variável | Consumidor | Falha se ausente |
|---|---|---|
| `SUPABASE_DB_URL` | `import-producao.mjs:546` · `teste-recall.mjs:35` | aborta com mensagem nomeando a variável |
| `PROD_DB_URL` | `import-producao.mjs:545` | idem |
| `OPENAI_API_KEY` | `teste-recall.mjs:34` | `abortar('defina OPENAI_API_KEY no ambiente.')` |

Todos abortam alto e nomeando a variável. O `exigirVariavel()` de `scripts/lib/env.mjs:61`
faz melhor ainda: além de presença, detecta que o valor **ainda é o placeholder do exemplo**
(`COLE_AQUI`) e checa comprimento mínimo — pega o caso de "copiei o exemplo e esqueci de
preencher", que de outro modo falharia como credencial inválida.

**Nota de conexão** (documentada no exemplo, e vale repetir): senha com caractere especial
precisa de percent-encoding. Um `@` cru faz o driver ler o host errado, e o erro **não diz
isso** — aparece como host inexistente.

## 4. Lacunas

### 4.1 ⚠️ `NEXT_PUBLIC_SITE_URL`: o default nunca dispara no Docker

Nos quatro pontos de uso o padrão é `??`:

```ts
const origem = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
```

`??` só cai no default para `null`/`undefined` — **string vazia passa**. E o `Dockerfile`
faz:

```dockerfile
ARG NEXT_PUBLIC_SITE_URL              # sem valor padrão
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
```

Se o build correr **sem** `--build-arg NEXT_PUBLIC_SITE_URL=...`, o `ARG` expande vazio, o
`ENV` fica com string vazia, e o valor que o Next inlina no build é `""`. O `??` não
dispara, `origem` vira `""`, e os links de convite e recuperação saem malformados.

O sintoma é o pior possível: **não quebra o build, não quebra o boot, não aparece em log**.
Só aparece como cliente relatando que o link do email não funciona — a mesma classe de
falha do `f70be7e`, por outra porta. Trocar `??` por `||` nos quatro pontos fecha isso, ou
dar um `ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000` de default no Dockerfile.

*(A leitura do Dockerfile e o uso de `??` foram verificados no código; o inlining de
`NEXT_PUBLIC_*` em tempo de build é comportamento documentado do Next.)*

### 4.2 `CHUNK_ALVO_CHARS` e `CHUNK_OVERLAP_CHARS` fora do `.env.local.exemplo`

Existem, têm default (450 / 120) e efeito grande — e não aparecem no arquivo que serve de
referência para montar o ambiente. Pioram três coisas já levantadas em outras auditorias:

- o número de chunks é `len / (ALVO − OVERLAP)`, então overlap alto **multiplica** chamadas
  à OpenAI ([`auditorias/AUDIT-COMPLEXIDADE.md`](auditorias/AUDIT-COMPLEXIDADE.md) §3);
- a memória de pico da função escala junto ([`auditorias/AUDIT-MEMORIA.md`](auditorias/AUDIT-MEMORIA.md) §4);
- mudar o tamanho quebra a paridade de recall com os chunks que o n8n já gravou, e **não há
  caminho de reindexação** para documento concluído.

São o tipo de variável que precisa de aviso ao lado, não de ausência.

### 4.3 Sem `TZ` definido

Nem no `Dockerfile` nem no exemplo — o container roda em **UTC**, e nenhum formatador de
data passa `timeZone`. É a causa do defeito descrito em
[`auditorias/AUDIT-A11Y-I18N.md`](auditorias/AUDIT-A11Y-I18N.md) §3.1: datas renderizadas no
servidor saem 3 horas adiantadas para o usuário brasileiro. Definir `TZ=America/Sao_Paulo`
no container é uma das duas correções possíveis.

### 4.4 Variáveis de runtime do container, não documentadas

`NODE_ENV=production`, `PORT=3000`, `HOSTNAME=0.0.0.0` e `NEXT_TELEMETRY_DISABLED=1` são
fixadas no `Dockerfile` (linhas 42-45) e nunca lidas pelo código da aplicação. Não é
problema — são convenção do runtime — mas quem for portar o deploy para outra plataforma
precisa saber que `PORT` e `HOSTNAME` estão fixos ali.

---

## Consolidado

| # | Ação | Motivo | Esforço |
|---|---|---|---|
| 1 | `??` → `||` em `NEXT_PUBLIC_SITE_URL` (4 pontos), ou default no `ARG` | falha silenciosa que produz email quebrado | ~10 min |
| 2 | Adicionar `CHUNK_ALVO_CHARS`/`CHUNK_OVERLAP_CHARS` ao `.env.local.exemplo`, com o aviso de recall | variável real e cara, invisível hoje | ~15 min |
| 3 | `ENV TZ=America/Sao_Paulo` no `Dockerfile` | corrige data errada em produção | ~5 min |

O `.env.local.exemplo` está, no restante, **acima da média**: separa público de secreto,
explica *por que* a chave pública pode ir ao browser, avisa sobre percent-encoding de senha,
distingue o que é `.env.local` do que é `supabase secrets set`, e marca explicitamente quais
variáveis são opcionais. Os itens acima são complementos, não reescrita.

---

## Método

`grep` por `process.env.X`, `process.env['X']` e `Deno.env.get('X')`, **mais** uma segunda
passada por acesso indireto (`envInt(`, `exigirVariavel(`, `process.env[`) — foi essa
segunda passada que revelou `CHUNK_ALVO_CHARS`/`CHUNK_OVERLAP_CHARS`, invisíveis à busca
literal. Cruzamento com `.env.local.exemplo` e `Dockerfile` para achar o que é usado sem
documentação e o que é documentado sem uso (nenhum caso deste segundo tipo). O modo de
falha de cada variável foi lido no código, não presumido pelo nome.
