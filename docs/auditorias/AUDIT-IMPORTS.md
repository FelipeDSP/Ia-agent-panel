# Auditoria do Grafo de Imports — ChatYou · IA

> Data: **2026-08-06**. Escopo: `src/`, `scripts/`, `tests/`, `supabase/functions/`.
> **76 arquivos, 217 arestas internas.** Grafo extraído por parser (import estático,
> `export ... from`, `import()` dinâmico e `require`), com resolução de `@/*` → `src/*`
> pelo `paths` do `tsconfig.json` e das extensões `.ts/.tsx/.mjs/.js`. Ciclos detectados
> por DFS com pilha. **Nenhum arquivo do projeto foi alterado.**

## Resumo

**Zero dependências circulares.** Não há ciclo entre módulos do projeto — nem direto
(A↔B), nem indireto. Também não há import não resolvido (a única "falha" de resolução é
`./globals.css` em `src/app/layout.tsx`, que é CSS, não módulo).

O grafo é raso e acíclico por construção: as folhas (`lib/utils.ts`,
`lib/supabase/config.ts`, `lib/tools/tipos.ts`, `lib/tenants/schema.ts`) não importam
nada, e o fluxo é sempre `app → components → lib`. A profundidade máxima da cadeia é 4
(`page.tsx → componentes.tsx → acoes.ts → lib/auth.ts → lib/supabase/server.ts`).

Dois pontos merecem atenção, nenhum é bug hoje:

1. **Uma única aresta inverte a direção das camadas** — `components/sidebar.tsx` →
   `app/(auth)/acoes.ts`. É o único lugar onde um ciclo poderia nascer.
2. **A fronteira client/server está intacta, mas num ponto ela depende de um `import
   type`** — se alguém remover a palavra `type`, o build quebra (que é o comportamento
   desejado, mas vale saber onde está o fio).

E um achado de manutenção: **`tests/restricao-coluna-fase3.mjs` não tem script npm**,
apesar de ser citado em duas specs como prova.

---

## 1. Dependências circulares

**Nenhuma.** DFS sobre as 217 arestas internas, partindo de todos os 76 arquivos.

Isso não é acidente — decorre de três propriedades da estrutura:

- **Folhas puras.** `lib/utils.ts`, `lib/supabase/config.ts`, `lib/tenants/schema.ts`,
  `lib/tools/tipos.ts`, `lib/tools/transferir-humano.ts`, `lib/orientacao.ts`,
  `lib/chatwoot.ts`, `lib/n8n.ts`, `lib/supabase/admin-usuarios.ts` — todos com **zero**
  imports internos. São 9 dos módulos mais importados do projeto.
- **`config.ts` como raiz única do acesso ao Supabase.** Os cinco clientes
  (`server`, `client`, `admin`, `middleware`, e o `ingestao.ts`) todos apontam para
  `config.ts` e nada aponta de volta. Um hub em estrela não cicla.
- **Camadas quase sempre respeitadas** (ver §2).

**Risco futuro concentrado num ponto.** A única aresta que sobe de camada é
`components/sidebar.tsx → app/(auth)/acoes.ts` (importa a Server Action `sair`). Hoje
`(auth)/acoes.ts` só importa `lib/auth.ts` e `lib/supabase/server.ts` — nenhum
componente. **No dia em que uma Server Action de `(auth)/` importar qualquer coisa de
`components/`, o primeiro ciclo do projeto nasce ali.** É a aresta a vigiar.

## 2. Camadas e direção do fluxo

| Aresta | Qtd | Leitura |
|---|---|---|
| `app → components` | 91 | páginas montando UI |
| `app → lib` | 60 | páginas/actions puxando auth, supabase, domínio |
| `app → app` | 23 | `page.tsx` → `componentes.tsx`/`acoes.ts` do mesmo módulo |
| `components → lib` | 14 | quase todo `ui/*` puxando `cn` de `lib/utils` |
| `lib → lib` | 10 | interno da lib |
| `components → components` | 8 | composição de UI |
| `tests → scripts` | 6 | testes reusando `scripts/lib/{env,usuarios}.mjs` |
| `scripts → scripts` | 3 | idem |
| `middleware → lib` | 1 | `middleware.ts` → `lib/supabase/middleware.ts` |
| **`components → app`** | **1** | ⚠️ a inversão descrita em §1 |

`lib/` **nunca** importa de `app/` nem de `components/`. Essa é a propriedade que segura
o grafo acíclico, e vale preservá-la como regra.

## 3. Fronteira client/server

Esta é a parte que interessa dado o item 5 do `CLAUDE.md` (`service_role` só no servidor).

**Módulos protegidos com `import 'server-only'` (7):** `lib/auth.ts`, `lib/chatwoot.ts`,
`lib/ingestao.ts`, `lib/n8n.ts`, `lib/supabase/admin.ts`, `lib/supabase/admin-usuarios.ts`,
`lib/supabase/server.ts`.

**Quem toca a chave secreta:** só `lib/supabase/admin.ts` lê `SUPABASE_SECRET_KEY`, e ele
tem `server-only`. Seu **único** importador é `app/(app)/admin/acoes.ts`, que é `'use
server'`. `config.ts` deliberadamente não guarda a chave secreta — a separação está
documentada no próprio arquivo e o grafo confirma que ela se sustenta.

**14 fronteiras RPC** (`'use client'` importando `'use server'`) — todas legítimas: o
bundler troca o import por uma referência de RPC, o código do servidor não entra no bundle.

```
admin/catalogo/componentes.tsx          -> admin/acoes.ts
admin/consumo/formulario-preco.tsx      -> admin/consumo/acoes.ts
admin/tenants/[id]/componentes.tsx      -> admin/acoes.ts
admin/tenants/novo/formulario.tsx       -> admin/acoes.ts
painel/configuracoes/formulario.tsx     -> painel/acoes.ts
painel/configuracoes/formulario-transferir.tsx -> painel/acoes.ts
painel/conhecimento/componentes.tsx     -> painel/conhecimento/acoes.ts
painel/conversas/lista.tsx              -> painel/conversas/acoes.ts
painel/conversas/[conversationId]/controles.tsx -> painel/conversas/acoes.ts
(auth)/login/formulario.tsx             -> (auth)/acoes.ts
(auth)/nova-senha/page.tsx              -> (auth)/acoes.ts
(auth)/recuperar-senha/page.tsx         -> (auth)/acoes.ts
components/prompt-editor.tsx            -> lib/tenants/prompt-acoes.ts
components/sidebar.tsx                  -> (auth)/acoes.ts
```

**Busca por vazamento:** BFS a partir de cada um dos 14 módulos `'use client'`, parando em
toda fronteira `'use server'`, procurando alcançar módulo `server-only` ou com a chave
secreta. **Resultado: nenhum caminho.**

Um caso exige nota, porque a primeira passagem o acusou:

> `components/sidebar.tsx` (`'use client'`) importa `lib/auth.ts` (`server-only`).

Não é vazamento: é `import type { Papel } from '@/lib/auth'` — import **só de tipo**, que
o TypeScript apaga na compilação (`isolatedModules: true`). Não existe aresta em runtime,
e é por isso que o `npm run build` passa. Mas registre-se: **é a única aresta client →
`server-only` do projeto, e o que a torna inofensiva é a palavra `type`.** Se um
auto-import da IDE reescrever aquela linha sem `type`, o `server-only` derruba o build —
falha barulhenta, não vazamento silencioso. O guard-rail funciona; só é bom saber que ele
está armado ali. (A outra aresta type-only do projeto é `lib/tools/registro.ts` →
`lib/tools/tipos.ts`, sem implicação de fronteira.)

## 4. Hubs — o que quebra mais coisa se mudar

| in-degree | Módulo |
|---|---|
| 22 | `lib/auth.ts` |
| 20 | `lib/supabase/server.ts` |
| 19 | `components/ui/alert.tsx` |
| 14 | `components/ui/card.tsx` · `lib/utils.ts` |
| 13 | `components/ui/button.tsx` |
| 10 | `ui/badge.tsx` · `ui/input.tsx` · `ui/label.tsx` |
| 8 | `ui/submit-button.tsx` |
| 6 | `ui/textarea.tsx` · `lib/tenants/schema.ts` · `lib/tools/transferir-humano.ts` |
| 5 | `scripts/lib/env.mjs` · `lib/supabase/config.ts` |

`lib/auth.ts` e `lib/supabase/server.ts` são o par crítico: **quase toda página e toda
Server Action passa pelos dois**. `auth.ts` importa `server.ts`, então mexer em `server.ts`
propaga para os 22 dependentes de `auth.ts` também. Qualquer mudança de assinatura aí é
mudança em ~30 arquivos.

`lib/supabase/config.ts` tem in-degree baixo (5) mas é a raiz transitiva de tudo que fala
com o banco — os 5 importadores são justamente os clientes Supabase.

## 5. Entrypoints e órfãos

22 arquivos sem importadores. Quase todos são **entrypoints legítimos** que o framework
carrega por convenção de arquivo, não por import: `page.tsx`, `layout.tsx`,
`route.ts`, `middleware.ts`, a Edge Function, e os `.mjs` chamados por `package.json`.

`src/lib/supabase/client.ts` também aparece sem importadores. **Não é órfão de fato** —
é o cliente de browser, mantido como contraparte pública do `server.ts`; hoje nenhum
componente client precisa dele porque toda mutação passa por Server Action. Vale saber
que está sem uso ativo.

⚠️ **`tests/restricao-coluna-fase3.mjs` — sem script npm.** Os outros dois testes têm
entrada em `package.json` (`teste:isolamento`, `teste:seguranca-tools`); este não. E ele é
citado como prova em `docs/especificacao/ESPECIFICACAO.md:377` ("10/10") e em
`ESPEC-CATALOGO-DE-TOOLS.md:235`. Um teste que só roda se alguém digitar o caminho à mão
não faz parte de nenhuma rotina — sugestão: `"teste:restricao": "node tests/restricao-coluna-fase3.mjs"`.

## 6. Módulos externos por alcance

| Arquivos | Pacote |
|---|---|
| 24 | `react` |
| 23 | `next` |
| 7 | `@supabase/supabase-js` |
| 6 | `lucide-react` |
| 4 | `react-dom` |
| 3 | `node:crypto` · `class-variance-authority` · `@supabase/ssr` |
| 2 | `pg` · `node:fs` · `server-only` |
| 1 | `node:path` · `node:url` · `clsx` · `tailwind-merge` · `https:` (esm.sh, Edge Function) |

`clsx` e `tailwind-merge` aparecem em **um** arquivo cada — ambos só em `lib/utils.ts`,
encapsulados atrás do `cn()`. Isso é bom: trocar `tailwind-merge` 2 → 3 (ver
[`AUDIT-DEPENDENCIAS.md`](AUDIT-DEPENDENCIAS.md)) toca um arquivo, não 24.

`pg` só em `scripts/` — confirma que a classificação em `devDependencies` está certa.

---

## Apêndice — grafo completo

`[client]`/`[server]` = diretiva no topo do arquivo. `(type-only)` = aresta apagada na
compilação, sem existência em runtime.

```
scripts/criar-super-admin.mjs
    -> scripts/lib/env.mjs
    -> scripts/lib/usuarios.mjs
scripts/import-producao.mjs
    -> scripts/lib/env.mjs
scripts/lib/env.mjs                          (sem imports internos)
scripts/lib/usuarios.mjs                     (sem imports internos)
scripts/teste-recall.mjs                     (sem imports internos)

src/app/(app)/admin/acoes.ts [server]
    -> src/lib/auth.ts
    -> src/lib/chatwoot.ts
    -> src/lib/supabase/admin-usuarios.ts
    -> src/lib/supabase/admin.ts
    -> src/lib/supabase/server.ts
    -> src/lib/tenants/schema.ts
    -> src/lib/tools/transferir-humano.ts
src/app/(app)/admin/catalogo/componentes.tsx [client]
    -> src/app/(app)/admin/acoes.ts
    -> src/components/ui/{alert,badge,button,input,label,submit-button,textarea}.tsx
src/app/(app)/admin/catalogo/page.tsx
    -> src/app/(app)/admin/catalogo/componentes.tsx
    -> src/components/ui/card.tsx
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
src/app/(app)/admin/consumo/acoes.ts [server]
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
    -> src/lib/tenants/schema.ts
src/app/(app)/admin/consumo/formulario-preco.tsx [client]
    -> src/app/(app)/admin/consumo/acoes.ts
    -> src/components/ui/{alert,input,label,select,submit-button}.tsx
    -> src/lib/tenants/schema.ts
src/app/(app)/admin/consumo/page.tsx
    -> src/app/(app)/admin/consumo/formulario-preco.tsx
    -> src/components/ui/{alert,badge,card}.tsx
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
src/app/(app)/admin/layout.tsx
    -> src/lib/auth.ts
src/app/(app)/admin/tenants/[id]/componentes.tsx [client]
    -> src/app/(app)/admin/acoes.ts
    -> src/components/ui/{alert,badge,button,input,label,select,submit-button,textarea}.tsx
    -> src/lib/tenants/schema.ts
src/app/(app)/admin/tenants/[id]/page.tsx
    -> src/app/(app)/admin/tenants/[id]/componentes.tsx
    -> src/components/prompt-editor.tsx
    -> src/components/ui/{badge,card}.tsx
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
    -> src/lib/tools/registro.ts
    -> src/lib/tools/transferir-humano.ts
src/app/(app)/admin/tenants/novo/formulario.tsx [client]
    -> src/app/(app)/admin/acoes.ts
    -> src/components/ui/{alert,input,label,select,submit-button,textarea}.tsx
    -> src/lib/tenants/schema.ts
src/app/(app)/admin/tenants/novo/page.tsx
    -> src/app/(app)/admin/tenants/novo/formulario.tsx
    -> src/components/ui/card.tsx
    -> src/lib/auth.ts
src/app/(app)/admin/tenants/page.tsx
    -> src/components/ui/{alert,badge,button,card,table}.tsx
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
    -> src/lib/utils.ts
src/app/(app)/layout.tsx
    -> src/components/sidebar.tsx
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
src/app/(app)/painel/acoes.ts [server]
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
    -> src/lib/tenants/schema.ts
    -> src/lib/tools/transferir-humano.ts
src/app/(app)/painel/configuracoes/formulario-transferir.tsx [client]
    -> src/app/(app)/painel/acoes.ts
    -> src/components/ui/{alert,input,label,select,submit-button}.tsx
    -> src/lib/tools/transferir-humano.ts
src/app/(app)/painel/configuracoes/formulario.tsx [client]
    -> src/app/(app)/painel/acoes.ts
    -> src/components/ui/{alert,input,label,submit-button,textarea}.tsx
src/app/(app)/painel/configuracoes/page.tsx
    -> src/app/(app)/painel/configuracoes/formulario-transferir.tsx
    -> src/app/(app)/painel/configuracoes/formulario.tsx
    -> src/components/ui/{alert,badge,card}.tsx
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
    -> src/lib/tools/registro.ts
    -> src/lib/tools/transferir-humano.ts
src/app/(app)/painel/conhecimento/acoes.ts [server]
    -> src/lib/auth.ts
    -> src/lib/ingestao.ts
    -> src/lib/supabase/server.ts
src/app/(app)/painel/conhecimento/componentes.tsx [client]
    -> src/app/(app)/painel/conhecimento/acoes.ts
    -> src/components/ui/{alert,badge,button,card,input,label,submit-button,textarea}.tsx
    -> src/lib/utils.ts
src/app/(app)/painel/conhecimento/page.tsx
    -> src/app/(app)/painel/conhecimento/acoes.ts
    -> src/app/(app)/painel/conhecimento/componentes.tsx
    -> src/lib/auth.ts
    -> src/lib/orientacao.ts
    -> src/lib/supabase/server.ts
src/app/(app)/painel/consumo/page.tsx
    -> src/components/ui/{alert,card}.tsx
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
    -> src/lib/utils.ts
src/app/(app)/painel/conversas/[conversationId]/controles.tsx [client]
    -> src/app/(app)/painel/conversas/acoes.ts
    -> src/components/ui/{alert,button}.tsx
src/app/(app)/painel/conversas/[conversationId]/page.tsx
    -> src/app/(app)/painel/conversas/[conversationId]/controles.tsx
    -> src/components/ui/{badge,card}.tsx
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
src/app/(app)/painel/conversas/acoes.ts [server]
    -> src/lib/auth.ts
    -> src/lib/n8n.ts
    -> src/lib/supabase/server.ts
src/app/(app)/painel/conversas/lista.tsx [client]
    -> src/app/(app)/painel/conversas/acoes.ts
    -> src/components/ui/{alert,badge,button}.tsx
src/app/(app)/painel/conversas/page.tsx
    -> src/app/(app)/painel/conversas/lista.tsx
    -> src/components/ui/card.tsx
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
src/app/(app)/painel/page.tsx
    -> src/components/prompt-editor.tsx
    -> src/components/ui/{alert,badge,card}.tsx
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts

src/app/(auth)/acoes.ts [server]
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
src/app/(auth)/layout.tsx                    (sem imports internos)
src/app/(auth)/login/formulario.tsx [client]
    -> src/app/(auth)/acoes.ts
    -> src/components/ui/{alert,button,input,label}.tsx
src/app/(auth)/login/page.tsx
    -> src/app/(auth)/login/formulario.tsx
    -> src/components/ui/{alert,card}.tsx
src/app/(auth)/nova-senha/page.tsx [client]
    -> src/app/(auth)/acoes.ts
    -> src/components/ui/{alert,button,card,input,label}.tsx
src/app/(auth)/recuperar-senha/page.tsx [client]
    -> src/app/(auth)/acoes.ts
    -> src/components/ui/{alert,button,card,input,label}.tsx
src/app/auth/confirmar/route.ts
    -> src/lib/supabase/server.ts
src/app/layout.tsx                           (sem imports internos)
src/app/page.tsx
    -> src/lib/auth.ts

src/components/prompt-editor.tsx [client]
    -> src/components/ui/{alert,button,submit-button,textarea}.tsx
    -> src/lib/orientacao.ts
    -> src/lib/tenants/prompt-acoes.ts
    -> src/lib/utils.ts
src/components/sidebar.tsx [client]
    -> src/app/(auth)/acoes.ts              <-- unica aresta components -> app
    -> src/components/theme-toggle.tsx
    -> src/components/ui/button.tsx
    -> src/lib/auth.ts                       (type-only)
    -> src/lib/utils.ts
src/components/theme-toggle.tsx [client]
    -> src/components/ui/button.tsx
src/components/ui/submit-button.tsx [client]
    -> src/components/ui/button.tsx
src/components/ui/{alert,badge,button,card,input,label,select,table,textarea}.tsx
    -> src/lib/utils.ts

src/lib/auth.ts [server-only]
    -> src/lib/supabase/server.ts
src/lib/chatwoot.ts [server-only]            (sem imports internos)
src/lib/ingestao.ts [server-only]
    -> src/lib/supabase/config.ts
src/lib/n8n.ts [server-only]                 (sem imports internos)
src/lib/orientacao.ts                        (sem imports internos)
src/lib/supabase/admin-usuarios.ts [server-only]  (sem imports internos)
src/lib/supabase/admin.ts [server-only]
    -> src/lib/supabase/config.ts
src/lib/supabase/client.ts [client]
    -> src/lib/supabase/config.ts
src/lib/supabase/config.ts                   (sem imports internos)
src/lib/supabase/middleware.ts
    -> src/lib/supabase/config.ts
src/lib/supabase/server.ts [server-only]
    -> src/lib/supabase/config.ts
src/lib/tenants/prompt-acoes.ts [server]
    -> src/lib/auth.ts
    -> src/lib/supabase/server.ts
src/lib/tenants/schema.ts                    (sem imports internos)
src/lib/tools/registro.ts
    -> src/lib/tools/tipos.ts                (type-only)
    -> src/lib/tools/transferir-humano.ts
src/lib/tools/tipos.ts                       (sem imports internos)
src/lib/tools/transferir-humano.ts           (sem imports internos)
src/lib/utils.ts                             (sem imports internos)
src/middleware.ts
    -> src/lib/supabase/middleware.ts

supabase/functions/processar-ingestao/index.ts   (sem imports internos)

tests/isolamento-fase2.mjs
tests/restricao-coluna-fase3.mjs
tests/seguranca-tenant-tools.mjs
    -> scripts/lib/env.mjs
    -> scripts/lib/usuarios.mjs
```

> Os `ui/{a,b,c}.tsx` acima são abreviação de arestas individuais, uma por arquivo —
> expandidas, somam as 217 arestas contadas no topo.
