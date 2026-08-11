# Auditoria de Acessibilidade e Internacionalização

> Data: **2026-08-06**. Varredura estática de atributos ARIA, semântica, associação de
> rótulo/erro, e de formatação sensível a locale. **Nenhum leitor de tela foi executado e
> nenhum contraste foi medido** — os achados são de código, não de teste assistivo. Nada
> foi alterado.

## Resumo

**Acessibilidade: base bem acima da média, com 4 lacunas concretas.** O projeto não é um
caso de "ninguém pensou em a11y" — há `inert` condicional, `role="dialog"` aplicado
**apenas** quando o elemento é de fato modal, `aria-expanded`/`aria-controls` no botão do
menu, `aria-hidden` em todos os 25 ícones decorativos, `alt` em todas as 6 imagens e
`focus-visible:ring` nos interativos. Isso é trabalho deliberado. As lacunas são as quatro
da §2, e a primeira é a que mais afeta uso real.

**Internacionalização: a ausência de i18n não é o problema — e apontá-la seria inventar
um.** Este é um painel de uma agência brasileira para clientes brasileiros; o `CLAUDE.md`
inclusive fixa português no schema. Não há biblioteca de i18n e há ~148 strings PT em JSX:
isso é a escolha certa para o produto que existe.

**O que há é um bug de locale que morde hoje, em português:** as datas são formatadas sem
`timeZone` explícito, num container que roda em **UTC**. Para o usuário brasileiro, todo
horário renderizado no servidor sai **3 horas adiantado**. É a §3.1, e é o único item deste
relatório que eu classificaria como defeito, não como melhoria.

---

## 1. Acessibilidade — o que está certo

Registrado porque é incomum e vale preservar em refatoração:

| Prática | Onde |
|---|---|
| `inert` no `<aside>` quando o drawer está fechado no mobile | `sidebar.tsx:137` |
| `role="dialog"` + `aria-modal` **só** quando abre como overlay | `sidebar.tsx:138` |
| `aria-expanded` + `aria-controls` no botão do menu | `sidebar.tsx:107-109` |
| `Esc` fecha o drawer | `sidebar.tsx:94-96` |
| `role="alert"` no componente `Alert` | `ui/alert.tsx:22` |
| `aria-hidden` em 25 ícones decorativos | vários |
| `alt` em 6/6 `<img>`, com o par claro/escuro em `display:none` | `sidebar.tsx`, `login/page.tsx` |
| 44 `htmlFor` associando rótulo a campo | formulários |
| `aria-current` no item de navegação ativo | `sidebar.tsx` |
| `role="progressbar"` com `aria-valuenow/min/max` | ingestão |

Dois detalhes que verifiquei em vez de presumir: o par de logos claro/escuro **não** é
anunciado duas vezes, porque o CSS usa `display: none` (`globals.css:108-127`) e não
`opacity`; e o `role="dialog"` é condicional, evitando o erro comum de declarar modal um
`<aside>` que no desktop é navegação fixa.

O `Alert` ter `role="alert"` é o que mais importa no dia a dia: como todo retorno de
Server Action é renderizado nele, sucesso e erro de formulário **são** anunciados. É a
lacuna mais frequente em apps React, e aqui está coberta.

## 2. Acessibilidade — as 4 lacunas

### 2.1 🟠 Erro de campo não associado ao input (WCAG 3.3.1 / 4.1.2)

```tsx
// admin/tenants/[id]/componentes.tsx:28 — e mais 3 cópias idênticas
function ErroCampo({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive">{msg}</p>;
}
```

O parágrafo não tem `id`, o `<Input>` correspondente não tem `aria-describedby` nem
`aria-invalid`. Quem navega por leitor de tela chega ao campo, ouve o rótulo, **e não ouve
o erro** — a mensagem existe visualmente e é invisível para a tecnologia assistiva. Como o
`Alert` de topo tem `role="alert"`, o usuário sabe que *algo* falhou, mas não qual campo.

É a lacuna de maior impacto real do relatório. O agravante é a duplicação: `ErroCampo` está
copiado em **4 arquivos** (já registrado em [`AUDIT-DEBITO.md`](AUDIT-DEBITO.md) §2), então
a correção são 4 edições — ou 1, se consolidar antes.

### 2.2 🟡 Drawer sem contenção de foco

`aria-modal` é declarativo: informa a tecnologia assistiva, **não** prende o foco. Ao abrir
o drawer no mobile, o foco permanece onde estava e o `<main>` atrás **não** recebe `inert`
— o `inert` da linha 137 está no próprio `<aside>` e vale para o estado *fechado*. O
resultado é que Tab atravessa o overlay e alcança o conteúdo por baixo.

Falta: mover foco para dentro ao abrir, devolvê-lo ao botão ao fechar, e marcar o resto da
página como inerte enquanto aberto.

### 2.3 🟡 Progresso da ingestão não é anunciado

Existe `role="progressbar"` com `aria-valuenow`, mas **zero `aria-live` no projeto**.
Atributo de progressbar que muda não é anunciado sozinho: sem uma região viva, o usuário
cego sobe um documento e não recebe nenhum retorno durante os 30-60 s de processamento —
nem no fim, já que a conclusão vem de um `router.refresh()`, não de um `Alert`.

### 2.4 🔵 Sem skip link

Zero ocorrências de `sr-only`, nenhum "pular para o conteúdo". Quem navega por teclado
percorre os ~8 itens do menu lateral em **toda** navegação antes de chegar ao conteúdo
(WCAG 2.4.1).

## 3. Internacionalização

### 3.1 🟠 Datas formatadas sem timezone, em container UTC — **defeito**

Nenhum formatador do projeto passa `timeZone`:

```ts
// lib/utils.ts:9 e :26 — sem timeZone
const formatadorData = new Intl.DateTimeFormat('pt-BR', { day, month, year });
return data.toLocaleString('pt-BR', { day, month, year, hour, minute });
```

Sem `timeZone`, o `Intl` usa o fuso do ambiente. O ambiente é `node:22-alpine`
(Dockerfile), **sem `TZ` definido** — nem no Dockerfile, nem no `.env.local.exemplo`. Ou
seja: **UTC**.

Consequências, duas e distintas:

1. **Server Components exibem hora errada.** `formatarDataHora` é chamada em
   `admin/tenants/page.tsx:161`, que é Server Component. Um tenant criado às 21h de
   Brasília aparece como **00h do dia seguinte**. Data errada, não só hora.
2. **Client Components produzem divergência de hidratação.** `dataCurta`
   (`conversas/lista.tsx:29`) vive em arquivo `'use client'`, mas o SSR também o renderiza:
   o servidor formata em UTC, o browser rehidrata em `America/Sao_Paulo`, e as strings não
   batem.

A correção é `timeZone: 'America/Sao_Paulo'` nos formatadores (ou `TZ` no container). Vale
notar que o projeto **já demonstra consciência de fuso** onde o dado entra —
`import-producao.mjs` tem `TZ_ORIGEM` e usa `at time zone $2` explicitamente. O cuidado
existe na ingestão e se perdeu na exibição.

### 3.2 🟡 Pluralização por "(s)"

15 ocorrências do padrão parentético, todas visíveis ao usuário:

```
"1 conversa(s) ativa(s)"   "1 chunk(s)"   "1 mensagem(ns)"   "1 documento(s)"
```

Funciona, mas é o tipo de coisa que um cliente nota. Português tem regra de plural
trivial (`n === 1 ? sing : plur`) e `Intl.PluralRules('pt-BR')` já está disponível sem
dependência. O caso `mensagem(ns)` é o mais feio, porque nem o sufixo é regular.

### 3.3 🟡 Tabela de meses reimplementada, e duplicada

`NOMES_MES` (`painel/consumo/page.tsx:25-38`) codifica os 12 meses em português à mão,
quando `Intl.DateTimeFormat('pt-BR', { month: 'long' })` os devolve corretos e de graça. E
`mesLabel` está **duplicada** em dois arquivos (`admin/consumo/page.tsx:35` e
`painel/consumo/page.tsx:20`), com corpo idêntico.

### 3.4 🔵 Observações menores

- **`usd` usa `en-US`** (`admin/consumo/page.tsx:27`) enquanto todo o resto usa `pt-BR`.
  Provavelmente deliberado (exibir dólar em formato americano), mas
  `Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' })` daria `US$ 1,23`,
  que é a convenção brasileira. Vale decidir e comentar.
- **`<html lang="pt-BR">` está correto** (`app/layout.tsx:33`) — o básico que costuma
  faltar.
- **~148 strings PT em JSX, sem catálogo.** Registrado como fato, **não como achado**: para
  um produto de mercado único é a escolha certa. Só vira dívida no dia em que aparecer um
  cliente que não fale português — e nesse dia o trabalho é o mesmo, feito agora ou depois.

---

## Consolidado

| # | Item | Tipo | Severidade | Esforço |
|---|---|---|---|---|
| 1 | `timeZone: 'America/Sao_Paulo'` nos formatadores | **defeito** | **Alta** — data errada em produção | ~30 min |
| 2 | `aria-describedby` + `aria-invalid` no `ErroCampo` (consolidar as 4 cópias antes) | a11y | Média | ~1 h |
| 3 | Contenção de foco no drawer + `inert` no `<main>` enquanto aberto | a11y | Média | ~1 h |
| 4 | `aria-live` no progresso da ingestão | a11y | Média | ~30 min |
| 5 | Pluralização real no lugar de "(s)" | i18n/UX | Baixa | ~1 h |
| 6 | `Intl` para nome de mês; desduplicar `mesLabel` | i18n | Baixa | ~20 min |
| 7 | Skip link | a11y | Baixa | ~15 min |
| — | Biblioteca de i18n / catálogo de strings | — | **não fazer** | — |

O item 1 é o único que eu trataria como bug: está exibindo informação incorreta para todo
usuário, hoje, em produção. Os itens 2 a 4 são o que separa "pensou em acessibilidade" de
"é utilizável por leitor de tela" — e como a base já é boa, são correções pontuais, não
retrabalho.

---

## Método

`grep` por `aria-*`, `role=`, `alt=`, `htmlFor`, `inert`, `tabIndex`, `sr-only`,
`aria-live`, `dangerouslySetInnerHTML`, `onClick` em elemento não interativo; leitura
integral de `sidebar.tsx`, `ui/alert.tsx` e das quatro cópias de `ErroCampo`. Para i18n:
`Intl.*`, `toLocaleString`, padrão `(s)`, `lang=`, `timeZone`, e verificação de `TZ` no
`Dockerfile` e no `.env.local.exemplo`. O comportamento do par de logos e a condicionalidade
do `role="dialog"` foram confirmados no CSS e no JSX antes de serem descartados como
achados. **Não substitui teste com leitor de tela real (NVDA/VoiceOver) nem verificação de
contraste — nenhum dos dois foi executado.**
