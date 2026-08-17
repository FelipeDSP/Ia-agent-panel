# Mapa de Componentes React — hierarquia, props e estado

> Data: **2026-08-06**. Extração de todos os componentes de `src/**/*.tsx`, com props da
> assinatura, hooks de estado do corpo e relações de parentesco lidas do JSX (`<Componente`),
> não só dos imports. **79 componentes — 41 client, 38 server, 30 com estado.**
> Nada foi alterado.

## Panorama

| Métrica | Valor |
|---|---|
| Componentes | **79** |
| Server Components (sem `'use client'`) | 38 |
| Client Components | 41 |
| **Com estado** (qualquer hook) | **30** |
| Sem estado | 49 |
| Profundidade máxima da árvore | **5 níveis** |
| Context / store global | **nenhum** |

Três fatos moldam este mapa:

1. **Não existe estado global.** Zero `createContext`, zero `useContext`, nenhuma
   biblioteca de store. Todo estado é local ao componente ou vem do servidor por props.
2. **`useActionState` é o primitivo dominante.** A maior parte dos formulários não guarda
   os valores em `useState` — deixa o DOM guardar e usa Server Action para o resultado. É
   por isso que 38 dos 79 componentes são Server Components com estado zero.
3. **O estado se concentra nas folhas.** Nenhuma página tem estado; ele desce até o
   componente que realmente interage.

---

## 1. Árvore de renderização

```
RootLayout (app/layout.tsx) [server] — <html lang="pt-BR">, script de tema
│
├── LayoutAutenticacao ((auth)/layout.tsx) [server]
│   ├── PaginaLogin [server] ──────────── FormularioLogin [client] ── BotaoEnviar
│   ├── PaginaRecuperarSenha [client] ─── BotaoEnviar
│   └── PaginaNovaSenha [client] ──────── BotaoEnviar
│
├── Home (app/page.tsx) [server] — redireciona por papel
│
└── LayoutAplicacao ((app)/layout.tsx) [server]
    ├── Sidebar [client] ── ThemeToggle [client], Button
    │
    ├── (painel — tenant_admin)
    │   ├── PaginaPainel ──────────── Metrica*, PromptEditor [client]
    │   ├── PaginaConhecimento ────── GestaoConhecimento [client]
    │   │                               ├── DocumentoItem* [client]
    │   │                               │     └── BotaoExcluirDocumento* [client]
    │   │                               └── StatusBadge*
    │   ├── PaginaConversas ───────── ListaConversas [client] ── StatusBadge*
    │   ├── PaginaConversa ────────── ControlePausa [client], LimparMemoria [client]
    │   ├── PaginaConfiguracoes ───── FormularioConfig [client], FormularioTransferir [client]
    │   └── PaginaConsumoTenant ───── Tendencia*
    │
    └── LayoutAdmin ((app)/admin/layout.tsx) [server] — só super_admin
        ├── PaginaTenants ─────────── Table, TableRow, TableCell…
        ├── PaginaNovoTenant ──────── FormularioNovoTenant [client]
        ├── PaginaDetalheTenant ───── FormConfigSuper, FormChatwoot, FormTransferirHumano,
        │                             FormConvite, BotaoSuspensao, ZonaPerigoExcluir,
        │                             PromptEditor, GerenciarAdmins ── LinhaAdmin*,
        │                             GestaoModulos ── ModuloRow*
        ├── PaginaCatalogo ────────── FormNovaTool ── CamposTool*,
        │                             ListaCatalogo ── ToolItem* ── CamposTool*
        └── PaginaConsumoAdmin ────── FormularioPreco [client]

* = componente privado (não exportado), definido no mesmo arquivo do pai
```

Todos os 20 primitivos de `components/ui/` (`Alert`, `Button`, `Card`+5, `Input`, `Label`,
`Select`, `Table`+5, `Textarea`, `Badge`, `SubmitButton`) são folhas e aparecem em quase
todos os ramos — omitidos acima para não poluir. `PaginaDetalheTenant` é o nó mais largo do
projeto: renderiza **8 componentes client** distintos.

## 2. Componentes com estado (30)

Ordenados por quantidade de hooks — na prática, por complexidade.

| Componente | Arquivo | Hooks | Props |
|---|---|---|---|
| **GestaoConhecimento** | `painel/conhecimento/componentes.tsx:200` | `useState×3` `useActionState×2` `useTransition` `useRef×2` `useEffect×3` `useRouter` — **12** | `{ documentosIniciais: Documento[], jobsIniciais: JobStatus[] }` |
| **LinhaAdmin** * | `admin/tenants/[id]/componentes.tsx:344` | `useState×3` `useActionState×3` — **6** | `{ tenantId: string, admin: AdminResumo }` |
| **PromptEditor** | `components/prompt-editor.tsx:24` | `useState×4` `useActionState` `useTransition` — **6** | `{ tenantId, promptAtual: string, versoes: VersaoPrompt[] }` |
| **Sidebar** | `components/sidebar.tsx:48` | `useState×2` `useEffect×3` `usePathname` — **6** | `{ papel: Papel, nome, email, nomeTenant: string \| null }` |
| **DocumentoItem** * | `painel/conhecimento/componentes.tsx:106` | `useState×3` `useTransition` — 4 | `{ doc: Documento, desabilitado, excluindo, onExcluir }` |
| **ListaConversas** | `painel/conversas/lista.tsx:36` | `useState×3` `useTransition` — 4 | `{ conversas: ConversaResumo[] }` |
| **ControlePausa** | `conversas/[conversationId]/controles.tsx:15` | `useState×2` `useTransition` — 3 | `{ conversationId: number, statusInicial: string }` |
| **LimparMemoria** | `conversas/[conversationId]/controles.tsx:67` | `useState×2` `useTransition` — 3 | `{ conversationId: number }` |
| **ThemeToggle** | `components/theme-toggle.tsx:15` | `useState` `useEffect` — 2 | — |
| **FormConvite** | `admin/tenants/[id]/componentes.tsx:239` | `useState` `useActionState` — 2 | `{ tenantId: string }` |
| **ZonaPerigoExcluir** | `admin/tenants/[id]/componentes.tsx:447` | `useState` `useActionState` — 2 | `{ tenantId, nome: string }` |
| **ToolItem** * | `admin/catalogo/componentes.tsx:138` | `useState` `useActionState` — 2 | `{ tool: ToolCatalogo }` |
| **FormularioTransferir** | `painel/configuracoes/formulario-transferir.tsx:19` | `useState` `useActionState` — 2 | `{ ativo, horario: Horario, notificarAtual, destinoNumero, temSessao }` |
| **BotaoExcluirDocumento** * | `painel/conhecimento/componentes.tsx:60` | `useState` — 1 | `{ nome, desabilitado, excluindo, onConfirmar }` |
| **FormConfigSuper** | `admin/tenants/[id]/componentes.tsx:35` | `useActionState` | `{ tenantId, nome, modelo, temperatura, debounce }` |
| **FormChatwoot** | `admin/tenants/[id]/componentes.tsx:110` | `useActionState` | `{ tenantId, accountId: number \| null, url }` |
| **FormTransferirHumano** | `admin/tenants/[id]/componentes.tsx:187` | `useActionState` | `{ tenantId, descricao, sessao, habilitada }` |
| **BotaoSuspensao** | `admin/tenants/[id]/componentes.tsx:294` | `useActionState` | `{ tenantId, ativo: boolean }` |
| **ModuloRow** * | `admin/tenants/[id]/componentes.tsx:522` | `useActionState` | `{ tenantId, modulo: ModuloAdmin }` |
| **FormNovaTool** | `admin/catalogo/componentes.tsx:103` | `useActionState` | — |
| **FormularioNovoTenant** | `admin/tenants/novo/formulario.tsx:19` | `useActionState` | — |
| **FormularioPreco** | `admin/consumo/precos/formulario-preco.tsx:14` | `useActionState` | — |
| **FormularioConfig** | `painel/configuracoes/formulario.tsx:17` | `useActionState` | `{ agenteAtivo, debounce, msgMidia, msgForaEscopo }` |
| **FormularioLogin** | `(auth)/login/formulario.tsx` | `useActionState` | — |
| **PaginaRecuperarSenha** | `(auth)/recuperar-senha/page.tsx:29` | `useActionState` | — |
| **PaginaNovaSenha** | `(auth)/nova-senha/page.tsx` | `useActionState` | — |
| **SubmitButton** | `components/ui/submit-button.tsx:8` | `useFormStatus` | `ButtonProps & { pendingLabel?: string }` |

`*` = privado ao arquivo.

**Leitura:** de 30 componentes com estado, **15 têm exatamente um `useActionState`** e nada
mais — são formulários que delegam tudo à Server Action. O estado "de verdade" (múltiplos
`useState`, efeitos, refs) está em **4 componentes**, e todos por razão visível:
`GestaoConhecimento` orquestra polling + dois formulários + navegação;
`PromptEditor` mantém rascunho, histórico e diff; `Sidebar` gerencia drawer, media query e
tema; `LinhaAdmin` embute três formulários independentes numa linha de tabela.

## 3. Componentes sem estado (49)

**Os 20 primitivos `ui/`** — todos Server Components, todos folhas, todos com a mesma forma
de props (`{ className, ...props }: XProps`), todos consumindo `cn()`:

`Alert` · `Badge` · `Button` · `Card` `CardHeader` `CardTitle` `CardDescription`
`CardContent` `CardFooter` · `Input` · `Label` · `Select` · `Table` `TableHeader`
`TableBody` `TableRow` `TableHead` `TableCell` · `Textarea` · (`SubmitButton` é o único
`'use client'`, por causa do `useFormStatus`)

**As 15 páginas e 4 layouts** — todos Server Components, estado zero, props só `children`
ou `params: Promise<…>`.

**Apresentacionais privados:** `StatusBadge` (2 cópias), `ErroCampo` (4 cópias), `Metrica`,
`Tendencia`, `CamposTool`, `GerenciarAdmins`, `GestaoModulos`, `ListaCatalogo`.

## 4. Componentes mais reutilizados

| Usos | Componente |
|---|---|
| 29 | `Alert` |
| 16 | `Label` · `Input` · `SubmitButton` |
| 15 | `Card` · `CardContent` |
| 14 | `Button` |
| 13 | `CardHeader` · `CardTitle` |
| 11 | `ErroCampo` · `CardDescription` |
| 9 | `Badge` |

`Alert` em 29 dos 79 componentes é o mais interessante do ponto de vista de arquitetura:
como ele carrega `role="alert"`, é ele que dá acessibilidade ao retorno de **toda** Server
Action do painel de uma vez só (ver [`auditorias/AUDIT-A11Y-I18N.md`](auditorias/AUDIT-A11Y-I18N.md)).

## 5. Duplicações no mapa

| Componente | Cópias | Avaliação |
|---|---|---|
| **`ErroCampo`** | **4** — `admin/catalogo/componentes.tsx:14`, `admin/tenants/[id]/componentes.tsx:28`, `admin/tenants/novo/formulario.tsx:14`, `painel/configuracoes/formulario.tsx:12` (+ variante em `formulario-transferir.tsx:14`) | corpo idêntico; consolidar resolveria de uma vez a lacuna de `aria-describedby` |
| **`StatusBadge`** | 2 — `painel/conhecimento/componentes.tsx:52`, `painel/conversas/lista.tsx:20` | **justificada** — domínios diferentes (status de job vs de conversa), mapas de cor distintos |
| **`BotaoEnviar`** | 1 def, 3 usos | ok |

## 6. Fluxo de dados

O padrão é uniforme e vale registrar porque é o que mantém 38 componentes sem estado:

```
Server Component (page)          ── lê do Supabase com RLS
        │ props (dados já resolvidos)
        ▼
Client Component (formulário)    ── useActionState(acao, estadoInicial)
        │ FormData
        ▼
Server Action ('use server')     ── exigir*() → valida → grava → revalidatePath()
        │ EstadoX { erro?, sucesso?, errosCampo? }
        ▼
volta ao useActionState → <Alert role="alert">
```

Não há fetch no cliente, nem cache de cliente, nem sincronização de estado servidor↔cliente
para manter. A única exceção é `GestaoConhecimento`, que faz polling de `listarStatusJobs()`
a cada 2,5 s enquanto houver job ativo — e é justamente o componente com 12 hooks.

---

## Método

Extração por parser sobre `src/**/*.tsx`: declarações `function <PascalCase>(`, delimitando
o corpo até a próxima declaração de topo; props colhidas por balanceamento de parênteses;
hooks contados por ocorrência no corpo; parentesco por `<Componente` no JSX (comentários
removidos antes). Nomes de tipo em posição genérica (`useActionState<EstadoConversa>`,
`React.HTMLAttributes<HTMLTableElement>`) foram filtrados manualmente da lista de filhos —
o parser os captura por serem sintaticamente idênticos a um elemento JSX. Contagem de
`createContext`/`useContext`/stores confirmada por `grep` global.
