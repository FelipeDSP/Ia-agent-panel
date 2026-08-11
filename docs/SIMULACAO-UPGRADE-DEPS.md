# Simulação de Upgrade — todas as dependências para latest

> Data: **2026-08-06**. **Simulação — nada foi instalado no projeto.** A resolução da
> árvore, a verificação dos ícones do lucide e a inspeção das assinaturas do
> `@supabase/ssr` rodaram em cópias isoladas no scratchpad. O `package.json` e o
> `package-lock.json` do repositório não foram tocados.
> Atualiza [`auditorias/AUDIT-DEPENDENCIAS.md`](auditorias/AUDIT-DEPENDENCIAS.md).

## Resultado da simulação

Montei a árvore completa com **tudo em latest** (`npm install --package-lock-only`) e ela
resolve **sem um único conflito de peer dependency** e com **0 vulnerabilidades**.

| Verificação | Resultado |
|---|---|
| Resolução da árvore com tudo em latest | ✅ resolve limpo |
| Conflitos de peer dependency | ✅ **nenhum** |
| `npm audit` na árvore nova | ✅ **0 vulnerabilidades** (as 3 HIGH atuais somem sozinhas) |
| `next@16` → engines | `node >= 20.9.0` — satisfeito por `node:22-alpine` |
| `next@16` → peer `react` | `^19.0.0` — satisfeito por 19.2.8 |
| `@supabase/ssr@0.12.4` → peer | `supabase-js ^2.111.0` — **força subir os dois juntos** |

**As 3 vulnerabilidades HIGH de hoje desaparecem sem esforço próprio:** o Next 16 já traz
`postcss 8.5.23` e `sharp 0.35.3`, que são exatamente as versões que eu havia proposto por
`overrides` na auditoria anterior.

**Resolver limpo não significa compilar limpo.** A árvore npm não sabe nada sobre API
removida. As §2 e §3 são sobre isso.

---

## 1. O que muda

| Pacote | Atual | Latest | Salto | Veredito |
|---|---|---|---|---|
| `next` | 15.5.21 | **16.3.0** | major | 🟠 exige verificação |
| `typescript` | 5.9.3 | **7.0.2** | **2 majors** | 🟠 exige verificação |
| `@supabase/ssr` | 0.7.0 | **0.12.4** | 5 minors 0.x | 🟠 **gap silencioso — §2.1** |
| `@supabase/supabase-js` | 2.110.8 | 2.112.2 | minor | 🟢 |
| `lucide-react` | 0.469.0 | **1.29.0** | major | 🟢 **verificado no-op — §2.2** |
| `tailwind-merge` | 2.6.1 | **3.6.0** | major | 🟢 **verificado no-op — §2.3** |
| `@types/react` | 19.2.17 | 19.2.18 | patch | 🟢 |
| `@types/react-dom` | 19.2.3 | 19.2.4 | patch | 🟢 |
| `react` / `react-dom` | 19.2.8 | 19.2.8 | — | ✅ já em latest |
| `tailwindcss` / `@tailwindcss/postcss` | 4.3.3 | 4.3.3 | — | ✅ já em latest |
| `pg`, `clsx`, `cva`, `server-only` | — | — | — | ✅ já em latest |
| `@types/node` | 22.20.1 | 26.1.2 | 4 majors | ⛔ **não subir** — runtime é Node 22 |

**`@types/node` fica em 22 de propósito.** O tipo tem que casar com o runtime, e o
Dockerfile roda `node:22-alpine`. Subir para 26 introduziria tipos de API que a produção
não tem — é regressão disfarçada de atualização.

## 2. Breaking changes, por evidência

### 2.1 🟠 `@supabase/ssr` 0.7 → 0.12 — o gap que passa silencioso

**É o achado desta simulação.** Inspecionei as assinaturas de 0.12.4 e o `setAll` mudou:

```ts
// 0.12.4 — o segundo parâmetro é novo
setAll(cookiesToSet, headers) {
  for (const {name, value, options} of cookiesToSet) response.cookies.set(name, value, options)
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value)  // <- NOVO
}
```

Da própria documentação do tipo: *"Headers that must be set on the HTTP response alongside
the cookies. **Responses that set auth cookies must not be cached by CDNs**"*.

O código atual (`lib/supabase/middleware.ts:20` e `server.ts:26`) ignora esse parâmetro:

```ts
setAll(cookiesParaDefinir) {        // <- só um parâmetro
  ...
  resposta.cookies.set(name, value, options);
}
```

**Por que é perigoso:** em TypeScript, ignorar parâmetros extras **não é erro**. O build
passa, o typecheck passa, nada avisa. O que se perde são os headers de cache que impedem
uma resposta com cookie de autenticação de ser cacheada por CDN — e o deploy é na Vercel,
que tem CDN na frente. É a mesma classe de falha do `??` em `NEXT_PUBLIC_SITE_URL`: correto
demais para quebrar, errado o bastante para machucar em produção.

Outras mudanças confirmadas na inspeção:
- **`get`/`set`/`remove` estão formalmente deprecados** (*"will not be supported in the next
  major version"*). O projeto **já usa `getAll`/`setAll`** — nada a fazer.
- **Inicialização preguiçosa de sessão** (`skipAutoInitialize: true`): a sessão só carrega no
  primeiro `getSession()`/`getUser()`/`getClaims()`. O projeto chama `getUser()`
  explicitamente em todo caminho — compatível.
- **`getClaims()` passa a ser recomendado** sobre `getSession()`. Não muda nada hoje (o
  `CLAUDE.md` já proíbe `getSession()`), mas é candidato a economizar round-trip no futuro.

### 2.2 🟢 `lucide-react` 0.469 → 1.29 — **verificado como no-op**

Major de biblioteca de ícones normalmente significa ícone renomeado ou removido. Extraí os
**24 ícones** que o projeto importa, instalei `lucide-react@1.29.0` isolado e conferi contra
os 7.785 nomes exportados do `.d.ts`:

```
BarChart3, BookOpen, Boxes, Building2, Eraser, Eye, EyeOff, FileText,
LayoutDashboard, LogOut, Menu, MessagesSquare, Minus, Moon, Pause, Play,
RefreshCw, Settings, Sun, Trash2, TrendingDown, TrendingUp, Upload, X
```

**Presentes: 24/24. Ausentes: nenhum.** O major não toca este código.

### 2.3 🟢 `tailwind-merge` 2.6 → 3.6 — **verificado como no-op**

Já testado na auditoria de dependências: a 2.6.1 **já resolve corretamente** as classes do
Tailwind v4 (`shadow-xs`, `rounded-xs`, `blur-xs`, `bg-linear-to-*`), e o `src/` não usa
nenhuma classe exclusiva da v4. Além disso, `tailwind-merge` entra em **um único arquivo**
(`lib/utils.ts`, atrás do `cn()`), então a superfície de risco é uma função.

### 2.4 🟠 `next` 15.5.21 → 16.3.0

O que consegui verificar localmente é favorável:

| Fator | Situação |
|---|---|
| Superfície de API usada | **pequena**: `revalidatePath`, `notFound`, `redirect`, `usePathname`, `useRouter`, `NextRequest/NextResponse`, `cookies`, `Montserrat` |
| `params`/`searchParams` assíncronos | ✅ **já migrado** — o código usa `Promise<{ id: string }>` |
| `next/image` | ✅ **não usado** (só `<img>`), então mudanças no otimizador não afetam |
| `output: 'standalone'` + `outputFileTracingRoot` | usados — **precisam ser reconferidos** no build de produção |
| peer `react` | ✅ `^19.0.0` satisfeito |
| engines | ✅ `node >= 20.9.0`, runtime é 22 |

⚠️ **O que eu não consigo verificar por inspeção local:** mudanças de comportamento de cache,
de convenções do App Router e do runtime de Server Actions entre 15 e 16. Isso exige ler as
notas de release e rodar o build — não afirmo que não existem, afirmo que a superfície
exposta deste projeto é pequena.

O `ADENDO_ESTADO_ATUAL.md` registra um precedente que justifica cautela: `devIndicators` no
`next.config.ts` fazia o `next start` 500ar em toda rota no 15.5.21 — **o build passava**. Ou
seja, neste projeto já houve incompatibilidade de Next que só apareceu em runtime de
produção. `npm run build` verde não é critério suficiente.

### 2.5 🟠 `typescript` 5.9 → 7.0

Salto de dois majors. O `tsconfig.json` não usa nada exótico (`strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `moduleResolution: bundler`,
`isolatedModules`, `paths`) — todas flags mainstream, o que reduz o risco.

Dois pontos a verificar de fato:
- **`plugins: [{ name: 'next' }]`** — plugin de editor (tsserver). Compatibilidade com a
  nova implementação precisa ser confirmada; não afeta `npm run build`, afeta a IDE.
- **Checagem mais estrita** entre majors costuma revelar erros latentes. Aqui isso é
  *baixo* risco por um motivo medido: a `AUDIT-DEBITO.md` registra **zero `any`** e nenhuma
  supressão de erro do compilador no projeto. Código sem escapatória de tipo é o que menos
  sofre em upgrade de compilador.

## 3. Esforço de adaptação

**Premissas:** um desenvolvedor familiarizado com o repositório; inclui rodar
`npm run build`, `teste:isolamento`, `teste:seguranca-tools` e `teste:recall`; **não** inclui
janela de deploy nem correção de bug que o upgrade venha a revelar.

### Onda 1 — sem risco · **1–2 h**

`@supabase/supabase-js` 2.112.2 · `@types/react` · `@types/react-dom` · `next` 15.5.22

| Tarefa | h |
|---|---|
| Subir, `npm run build`, rodar os 3 testes | 1–2 |

Recomendo fazer esta onda **isolada e comitada sozinha**, para que qualquer regressão das
ondas seguintes tenha uma base limpa de comparação.

### Onda 2 — majors verificados como no-op · **2–3 h**

`lucide-react` 1.29 · `tailwind-merge` 3.6

| Tarefa | h |
|---|---|
| Subir os dois; `npm run build` | 0,5 |
| Varredura visual das telas com ícone (sidebar, conhecimento, conversas) | 1–1,5 |
| Conferir que `cn()` não mudou classe resolvida em nenhum componente `ui/*` | 0,5–1 |

A verificação já feita (24/24 ícones, classes v4) transforma o que seriam dois majors de
risco em revisão visual.

### Onda 3 — `@supabase/ssr` 0.12 + `supabase-js` · **4–7 h**

Sobem juntos por força do peer `^2.111.0`.

| Tarefa | h |
|---|---|
| **Adicionar o parâmetro `headers` ao `setAll`** em `middleware.ts` e `server.ts` (§2.1) | 1–1,5 |
| Ler o changelog de 0.8 → 0.12 (5 minors de uma biblioteca de auth) | 1–2 |
| Testar sessão de ponta a ponta: login, refresh, logout, link de recuperação, convite | 1,5–2,5 |
| Rodar `teste:isolamento` incluindo a camada 3 (exige `npm run dev` de pé) | 0,5–1 |

⚠️ **É a onda de maior risco funcional.** Bug de cookie de sessão não aparece no build — aparece
como usuário deslogando sozinho, e o `a940cfd` mostra que este projeto já foi mordido
exatamente por isso.

### Onda 4 — `next` 16 · **6–12 h**

| Tarefa | h |
|---|---|
| Ler as notas de release 15 → 16 e mapear o que toca a superfície usada | 1,5–2 |
| Subir, corrigir o que o build acusar | 2–4 |
| **Validar `next start` de verdade, não só `next build`** (§2.4) | 1–2 |
| Validar a imagem Docker: `output: standalone` + `outputFileTracingRoot` | 1,5–3 |

### Onda 5 — `typescript` 7 · **3–6 h**

| Tarefa | h |
|---|---|
| Subir e rodar `npm run typecheck`; catalogar erros novos | 1–2 |
| Corrigir erros de estreitamento revelados pelo compilador novo | 1–3 |
| Confirmar o plugin `next` do tsserver na IDE | 0,5–1 |

### Total

| Onda | Horas | Risco |
|---|---|---|
| 1 — patches e minors | 1–2 | 🟢 |
| 2 — lucide + tailwind-merge | 2–3 | 🟢 |
| 3 — supabase/ssr + supabase-js | 4–7 | 🟠 |
| 4 — next 16 | 6–12 | 🟠 |
| 5 — typescript 7 | 3–6 | 🟡 |
| **Total** | **16–30 h** | |

**Ponto médio: ~23 horas** — dois a três dias de trabalho.

## 4. Recomendação

**Faça as ondas 1 e 2 agora (3–5 h).** A onda 1 recolhe correções acumuladas; a onda 2
elimina dois majors da lista de pendências com risco que eu já medi como nulo. Juntas
reduzem a dívida de dependências pela metade em meio dia.

**A onda 3 vale por si.** Não é higiene: são 5 minors de uma biblioteca de autenticação, e
o gap do `setAll` já é uma correção concreta a fazer independentemente da versão.

**As ondas 4 e 5 podem esperar** — e é uma decisão, não procrastinação. As 3 vulnerabilidades
HIGH que motivariam pressa **não exigem o Next 16**: dois `overrides` (`postcss ^8.5.23`,
`sharp ^0.35.3`) zeram o `npm audit` no Next 15, como demonstrei na auditoria de
dependências. Com o motivo de urgência removido, Next 16 e TypeScript 7 passam a ser
manutenção planejada, feita quando houver janela — não sob pressão de um relatório de
segurança.

---

## Método

Árvore latest resolvida com `npm install --package-lock-only --ignore-scripts` sobre cópia
do `package.json` no scratchpad; `npm audit` sobre o lock resultante; `npm view` para
versões, `engines` e `peerDependencies`. Os 24 ícones do lucide foram extraídos por parser
dos imports em `src/` e conferidos contra os 7.785 nomes exportados do `.d.ts` de
`lucide-react@1.29.0`, instalado isolado. As assinaturas do `@supabase/ssr@0.12.4` foram
lidas dos `.d.ts` do pacote instalado isolado — o gap do `setAll` vem de lá, não de
changelog. **O que não pôde ser verificado localmente está marcado como tal na §2.4 e §2.5:**
mudanças de comportamento de cache e runtime do Next 16 e do compilador do TypeScript 7
exigem notas de release e execução, e não as afirmo por inferência.
