# Auditoria de Interface (UI/UX/A11y) — ChatYou · IA

> A aplicação **tem frontend** (Next.js App Router + React 19 + Tailwind/shadcn).
> Investigação apenas — nada corrigido. Prioridade máxima: telas do fluxo crítico
> (ingestão / **Base de conhecimento**). Data: 2026-08-04.
> Vários itens do design review anterior **já foram corrigidos nesta sessão** — marcados
> como ✅ e não contados como achado aberto.

## Achados GLOBAIS (afetam todas as telas)

| ID | Achado | Sev | Ref |
|---|---|---|---|
| **G1** | **Nenhum `loading.tsx`** em nenhuma rota → ao navegar, a tela fica **em branco** até o Server Component resolver as queries (sem skeleton, sem spinner). Pior em `/admin/tenants` (N+1) e telas com várias queries. | **Alta** | ausência em `src/app/**` |
| **G2** | **Nenhum `error.tsx`/`global-error.tsx`** → um erro não tratado numa página cai na tela de erro **crua do Next** ("Application error"), sem recuperação nem branding. | **Média** | ausência em `src/app/**` |
| **G3** | **Erros de campo não são anunciados nem associados.** `ErroCampo` é `<p class="text-xs text-destructive">` — sem `role="alert"`, sem `aria-describedby`/`aria-invalid` no input. Leitor de tela não anuncia e não liga o erro ao campo. (Erros de **formulário** usam `<Alert role="alert">` e **são** anunciados ✅.) | **Média** | `configuracoes/formulario.tsx:12`, `configuracoes/formulario-transferir.tsx:14`, `admin/tenants/novo/formulario.tsx:14`, `admin/tenants/[id]/componentes.tsx:26` |
| **G4** | **Erros técnicos do Postgres expostos** ao usuário (`...: ${error.message}`) em várias actions. | Baixa | `conhecimento/acoes.ts:67,86`, `painel/acoes.ts:52`, `admin/acoes.ts` (vários) |
| **G5** | Sem `not-found.tsx` custom (`notFound()` → 404 padrão). | Baixa | `conversas/[conversationId]/page.tsx` |
| **G6** | **Contraste** texto branco sobre laranja (botão `default`, `Badge`) ≈ 2.5:1 (< AA 4.5:1). Decisão de marca (ver S1 do design). | Baixa | `ui/button.tsx:11`, `globals.css` |

## Tela: Base de conhecimento — `/painel/conhecimento` (FLUXO CRÍTICO — prioridade máxima)

Arquivos: `conhecimento/page.tsx`, `conhecimento/componentes.tsx` (`GestaoConhecimento`, `DocumentoItem`, `BotaoExcluirDocumento`, `StatusBadge`).

| ID | Achado | Sev | Ref |
|---|---|---|---|
| **C1** | **Job preso em "processando" = beco sem saída na UI.** Se a Edge Function morrer (achado F1 do fluxo), o card "Processamentos" fica em polling infinito com "Atualizando automaticamente…" e **nunca** oferece Reprocessar (só aparece p/ status `erro`). O usuário não sabe se falhou e não tem como sair do estado. | **Alta** | polling `componentes.tsx` (`useEffect` de `temAtivo`); "Reprocessar" só em `job.status === 'erro'` |
| **C2** | **Operação longa sem instrução de "pode sair".** Upload de arquivo processa em background (30–60s), mas nada diz que o usuário pode navegar para outra tela — e se sair, o polling para (ao voltar o job pode já estar concluído, mas ele não sabe disso). | Média | card "Processamentos" (`CardDescription` "Atualizando automaticamente…") |
| **C3** | Erros técnicos: "Falha no upload: `<msg>`", "Não foi possível registrar o processamento: `<msg>`". | Baixa | `conhecimento/acoes.ts:67,86` |
| **C4** | **Mobile:** linha de documento/job com nome truncado + 2–3 botões com rótulo de texto ("Ver conteúdo"/"Ocultar" + "Dispensar"/"Reprocessar") em `flex justify-between` pode apertar/quebrar em telas estreitas; alvos `size="sm"` (~36px) no limite. | Baixa | `DocumentoItem` / linha de job em `componentes.tsx` |

**Bom nesta tela (já corrigido / robusto):** empty state ✅; **barra de progresso com `role="progressbar"` + aria** ✅; **feedback de pendência** nos botões ("Excluindo…/Reprocessando…/Dispensando…") ✅; **exclusão em 2 passos** ✅; cards de upload/texto **responsivos** (`grid ... lg:grid-cols-2` empilha no mobile) ✅; **`SubmitButton`** desabilita e mostra "Enviando…/Processando…" (anti-duplo-envio + loading) ✅; erro/sucesso em `<Alert role="alert">` (anunciado) ✅; "Ver conteúdo" com `aria-expanded` ✅.
> Ressalva: input `type=file` não repovoa após erro (segurança do browser) — inevitável; o erro é mostrado.

## Tela: Conversas (lista) — `/painel/conversas`
| ID | Achado | Sev | Ref |
|---|---|---|---|
| **Cv1** | Lista é **flexbox custom** (não `<Table>`) com larguras fixas `w-20`/`w-32`; em telas estreitas o cabeçalho/linhas podem estourar (sem container de scroll horizontal). | Média | `conversas/lista.tsx:140-175` |
| **Cv2** | Empty state é um `<p>` pequeno alinhado à esquerda (sem centralização/ícone) — inconsistente com o empty centralizado do admin. | Baixa | `conversas/page.tsx` |

**Bom:** checkbox com `aria-label` + foco ✅; "Limpar memória de todas" **separada e rotulada** ✅; confirmação em 2 passos com "Limpando…" ✅.

## Tela: Conversa (detalhe) — `/painel/conversas/[id]`
| ID | Achado | Sev | Ref |
|---|---|---|---|
| **Cd1** | Sem loading (G1); histórico pode aparecer "de uma vez" após o fetch. | Baixa | `conversas/[conversationId]/page.tsx` |

**Bom:** distinção agente/contato por **lado + cor + rótulo** ("Agente/Contato · data") ✅ (contraste reforçado nesta sessão); `ControlePausa`/`LimparMemoria` com "Pausando…/Limpando…" ✅; empty ("Nenhuma mensagem registrada") ✅.

## Tela: Uso — `/painel/consumo`
| ID | Achado | Sev | Ref |
|---|---|---|---|
| **U1** | Com poucos meses, muito espaço vazio abaixo do card (desequilíbrio visual). | Baixa | `painel/consumo/page.tsx` |

**Bom:** reformulada (número + tendência), empty state, erro em `<Alert>`, tendência com ícone + cor por direção (tokens `success`/`destructive`) ✅.

## Tela: Configurações — `/painel/configuracoes`
| ID | Achado | Sev | Ref |
|---|---|---|---|
| **Cf1** | Vários erros de campo (`ErroCampo`) não anunciados (instância de G3): timezone, horas, destino. | Média | `configuracoes/formulario.tsx`, `formulario-transferir.tsx` |
| **Cf2** | Estado vazio "canal ainda não habilitado pela agência" é claro ✅; sem loading (G1). | Baixa | `configuracoes/page.tsx` |

**Bom:** checkboxes `accent-primary` + foco ✅; fieldsets `rounded-xl` ✅; `SubmitButton` ✅; feedback em `<Alert>` ✅.

## Tela: Visão geral — `/painel`
| ID | Achado | Sev | Ref |
|---|---|---|---|
| **Ov1** | Sem loading (G1). Prompt editor: "Usar modelo" confirma antes de sobrescrever ✅ (warning). | Baixa | `painel/page.tsx`, `prompt-editor.tsx` |

**Bom:** métrica agora `text-2xl` (hierarquia corrigida) ✅.

## Telas admin (super_admin)
| ID | Achado | Sev | Ref |
|---|---|---|---|
| **Ad1** | `/admin/tenants`: sem loading + **N+1** → primeira pintura lenta ao escalar (G1 + perf P1). | Média | `admin/tenants/page.tsx:62` |
| **Ad2** | `/admin/consumo`: usa `<table>` cru (inconsistente com o `<Table>` do shadcn de tenants). | Média | `admin/consumo/page.tsx:88,133` |
| **Ad3** | `/admin/tenants/[id]`: erros de campo não anunciados (G3). | Baixa | `admin/tenants/[id]/componentes.tsx:26` |

## Consistência (componentes que fazem o mesmo de formas diferentes)
| ID | Achado | Sev | Ref |
|---|---|---|---|
| **Cn1** | **3 estilos de tabela**: `<Table>` shadcn (`admin/tenants`), `<table>` cru (`admin/consumo`), flexbox (`conversas/lista`). | Média | os três arquivos |
| **Cn2** | `ErroCampo` reimplementado 4× (idêntico). | Baixa | (ver G3) |
| **Cn3** | `StatusBadge` em 2 lugares com labels/cores próprias (job vs conversa). | Baixa | `conhecimento/componentes.tsx`, `conversas/lista.tsx` |

**Consistente / bom:** feedback padronizado em `<Alert>` (destructive/success/warning) em todas as telas ✅; botões pílula, cards `rounded-2xl`, inputs `rounded-lg` ✅; toggle de tema claro/escuro com anti-flash ✅.

---

## Prioridades (fluxo crítico primeiro)
1. **C1** (job travado = beco sem saída) — é o pior da tela mais importante; casa com o fix F1 (reaper + permitir reprocessar) e precisa de mensagem/estado na UI.
2. **G1** (`loading.tsx`) — feedback de navegação em todas as telas; começar por `conhecimento` e `admin/tenants`.
3. **G2** (`error.tsx`/`global-error.tsx`) — rede de segurança de erro para o app inteiro.
4. **G3/Cf1/Ad3** (erros de campo com `role="alert"` + `aria-describedby`/`aria-invalid`) — acessibilidade real de formulário.
5. **C2** ("pode sair desta tela" na operação longa) — barato, alto alívio de ansiedade.
6. **Cn1** (unificar tabelas) + **Cv1** (mobile da lista de conversas).

### Nota de método
Auditei os componentes reais (não presumi por nome). Não rodei leitor de tela nem
ferramenta automática de contraste/axe; as observações de ARIA/contraste vêm da leitura do
markup e dos tokens de cor. Um passe com axe-core/Lighthouse fecharia o que exige runtime.
