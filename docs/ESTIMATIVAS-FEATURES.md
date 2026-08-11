# Estimativa de Esforço — 10 features hipotéticas

> Data: **2026-08-06**. Features **hipotéticas**, escolhidas por serem plausíveis para este
> produto (agência que provisiona agentes para empresas clientes). As estimativas são
> ancoradas na arquitetura real: no que o `CLAUDE.md` exige de toda mudança, no que o
> `ADICIONAR-TOOL.md` já documenta como custo, e nas fricções levantadas nas auditorias
> desta sessão. **Nada foi implementado.**

## O imposto fixo da arquitetura

Antes das features: este projeto cobra um pedágio de *qualquer* mudança, e ignorá-lo é o
que faz estimativa de painel multi-tenant estourar. Ele está escrito no `CLAUDE.md`, não é
invenção minha:

| Imposto | Quando incide | Custo |
|---|---|---|
| Policy RLS na **mesma** migração da tabela | toda tabela nova com `tenant_id` | +1 h |
| Índice composto com `tenant_id` **primeiro** | toda tabela nova | +0,5 h |
| Migração com **rollback escrito** | toda migração | +1 h |
| Teste de isolamento com **3 tenants**, por API **e** por URL direta | todo recurso novo | +2 h |
| Gate `exigir*` + filtro explícito de tenant (duas camadas) | toda Server Action | +0,5 h/action |
| Verificar impacto no **n8n** | toca `kb_documentos`, `conversas` ou `tenants` | +1–2 h |
| Re-rodar `npm run teste:recall` | mexe em chunking ou busca vetorial | +1 h |

E três fricções que as auditorias mediram e que também custam:

- **Não há framework de teste** ([`auditorias/AUDIT-COBERTURA.md`](auditorias/AUDIT-COBERTURA.md)):
  lógica pura nova nasce sem teste, ou alguém instala `node --test` antes.
- **`ErroCampo` está duplicado 4×** ([`MAPA-COMPONENTES.md`](MAPA-COMPONENTES.md) §5):
  formulário novo copia a quinta vez, ou consolida antes.
- **Não há `error.tsx` nem `loading.tsx`** ([`MAPA-ROTAS.md`](MAPA-ROTAS.md) §5): tela nova
  herda a lacuna.

**Regra prática:** uma feature com tabela nova + uma tela + duas actions carrega **~6 h de
imposto** antes de qualquer lógica de negócio.

---

## Resumo

| # | Feature | Horas | Complexidade |
|---|---|---|---|
| F6 | Diff visual entre versões do prompt | **4–6** | 🟢 baixa |
| F3 | Exportar conversas em CSV | **5–8** | 🟢 baixa |
| F4 | Reindexar documento sem re-upload | **6–10** | 🟡 média |
| F1 | Tool nova no catálogo (ex.: agendamento) | **6–14** | 🟡 média (quase tudo n8n) |
| F2 | Busca e paginação nas conversas | **8–12** | 🟡 média |
| F5 | Email de aviso quando ingestão falha | **12–18** | 🟡 média |
| F8 | Painel de perguntas sem resposta | **16–24** | 🟠 alta |
| F9 | Onboarding self-service de cliente | **25–40** | 🔴 muito alta |
| F7 | Papel "leitor" (somente leitura) | **30–45** | 🔴 muito alta |
| F10 | Painel multi-idioma | **30–50** | 🔴 muito alta |
| | **Total das 10** | **142–227 h** | |

---

## F6 — Diff visual entre versões do prompt · 4–6 h 🟢

O mais barato do lote, porque **toda a infraestrutura já existe**: `prompt_versoes` guarda
`conteudo`, `criado_em` e `criado_por`, e `restaurarVersaoPrompt` já lê a tabela.

| Tarefa | h |
|---|---|
| Algoritmo de diff por linha (JS puro, sem dependência) | 1,5–2 |
| UI no `PromptEditor`: seletor de versão + painel lado a lado | 2–3 |
| Estados vazios (primeira versão, versões idênticas) | 0,5 |

**Zero migração, zero action nova, zero n8n, zero imposto.** A única ressalva é que o
`PromptEditor` já tem 6 hooks ([`MAPA-COMPONENTES.md`](MAPA-COMPONENTES.md) §2) — é o
momento de extrair um sub-componente em vez de engordá-lo.

## F3 — Exportar conversas em CSV · 5–8 h 🟢

| Tarefa | h |
|---|---|
| Route Handler `/painel/conversas/export` com `exigirTenantAdmin` | 1 |
| Query escopada + geração de CSV com streaming | 1,5–2 |
| **Escape contra CSV injection** (campo iniciando em `=`, `+`, `-`, `@`) | 1 |
| Botão + estado de carregamento | 1 |
| Teste de isolamento (tenant B não exporta dados de A) | 1,5–2 |

⚠️ O item de segurança não é opcional: `contact_name` vem do Chatwoot, ou seja, de fora. Um
nome começando com `=` vira fórmula ao abrir no Excel. É a razão de o item valer 1 h em vez
de zero.

## F4 — Reindexar documento sem re-upload · 6–10 h 🟡

Fecha uma lacuna que o próprio `CLAUDE.md` registra: *"Não existe caminho para reindexar um
documento já concluído... Mudar `CHUNK_ALVO_CHARS` hoje exige re-subir cada documento à mão."*

| Tarefa | h |
|---|---|
| Edge Function: aceitar job de reindexação para documento `concluido` (hoje 409) | 2–3 |
| Criar job novo a partir do `arquivo_path` já no Storage | 1,5–2 |
| UI: botão "Reprocessar" também em job concluído (hoje só em erro) | 1 |
| Guarda contra reindexação concorrente do mesmo `origem` | 1 |
| **Imposto:** `teste:recall` antes/depois | 1 |
| Verificação de impacto no n8n (o swap apaga e recria chunks) | 1–2 |

O swap já é atômico (`kb_reindex_documento`), então o risco é menor do que parece — mas
mexe em `kb_documentos`, que o n8n lê.

## F1 — Tool nova no catálogo (ex.: agendamento) · 6–14 h 🟡

**A estimativa mais interessante do lote, porque o painel quase não entra.** O catálogo de
tools (`f8cc6fa`) foi construído exatamente para isso: contratar uma tool é *entrada de
dados*, não deploy.

| Tarefa | h | Lado |
|---|---|---|
| Sub-workflow `Tool - Agendamento (Multi-Tenant)` no n8n | 3–6 | n8n |
| Ligar no workflow principal + seção no system prompt | 1–2 | n8n |
| Cadastrar no catálogo (Admin → Catálogo → Nova tool) | **0** | painel — é UI existente |
| Contratar por cliente (Admin → cliente → Módulos) | **0** | painel — é UI existente |
| Config editável pelo cliente (se a tool tiver campos) | 2–4 | painel |
| Teste de segurança da linha nova em `tenant_tools` | 1 | — |
| Paridade com produção (Acqua roda no mesmo workflow) | 1 | n8n |

**Se a tool não tiver config de cliente, o custo no painel é literalmente zero.** É o
retorno do investimento do catálogo — e o motivo de o `ADICIONAR-TOOL.md` existir com 100
linhas. A faixa 6–14 h é quase toda n8n.

## F2 — Busca e paginação nas conversas · 8–12 h 🟡

Hoje a lista é `.limit(200)` sem busca, sem filtro e sem paginação
(`painel/conversas/page.tsx:23`).

| Tarefa | h |
|---|---|
| Extensão `pg_trgm` + índice GIN em `(tenant_id, contact_name)` — migração + rollback | 2 |
| Query com `ilike` + `.range()`, mantendo filtro explícito de tenant | 1,5 |
| Estado na URL (`?q=&pagina=`) para busca compartilhável e navegável | 2 |
| UI: input com debounce, filtro por status, controles de página | 2,5–3 |
| **Imposto:** teste de isolamento (busca de B não alcança A) | 2 |
| Verificar impacto no n8n (índice novo em `conversas`) | 1 |

O índice trigram é o que impede a busca de virar sequential scan quando um tenant tiver
milhares de conversas. Sem ele a feature nasce com o problema que ela deveria resolver.

## F5 — Email de aviso quando a ingestão falha · 12–18 h 🟡

O custo aqui **não é a feature, é a infraestrutura que não existe**. Hoje o único email do
sistema sai do GoTrue (convite e recuperação); não há caminho transacional próprio.

| Tarefa | h |
|---|---|
| Escolher e integrar provedor (Resend/SES): SDK, chave, env, template | 4–6 |
| Documentar as variáveis novas em `.env.local.exemplo` | 0,5 |
| Disparo: a Edge Function marca `erro` → quem envia? (Edge Function ou cron) | 2–3 |
| Preferência por tenant: quem recebe, e opt-out | 2–3 |
| Anti-spam: não reenviar o mesmo erro em loop | 1,5 |
| Migração da coluna de preferência + policy + rollback | 2 |

Se a decisão for enviar direto da Edge Function, some a complexidade de agendamento, mas o
envio passa a competir com o processamento pelo tempo de execução da função.

## F8 — Painel de perguntas sem resposta · 16–24 h 🟠

*"Quais perguntas o agente não soube responder"* — a feature de maior valor comercial da
lista, e a que mais depende do outro lado.

| Tarefa | h |
|---|---|
| **Definir "sem resposta"**: limiar de similaridade, ou o agente sinalizando | 2–3 |
| n8n: gravar a pergunta quando o recall vier vazio/abaixo do limiar | 4–6 |
| Tabela `perguntas_sem_resposta` + policy + índice + rollback | 2,5 |
| Tela: lista, agrupamento por similaridade, "virar documento" | 4–6 |
| Ação de dispensar/arquivar pergunta | 1,5 |
| **Imposto:** teste de isolamento | 2 |
| Retenção (a tabela cresce por mensagem, não por conversa) | 1 |

O item de definição vem primeiro por um motivo: sem um limiar acordado, a tela enche de
falso positivo e ninguém confia nela. E a tabela é a única do sistema que cresceria na
ordem do volume de mensagens.

## F9 — Onboarding self-service de cliente · 25–40 h 🔴

Hoje só existe caminho por convite de `super_admin` (`convidarAdminTenant`). Abrir cadastro
público muda a superfície de segurança.

| Tarefa | h |
|---|---|
| Signup público + verificação de email | 4–6 |
| Provisionar tenant: slug único, defaults, primeiro admin, `app_metadata` | 5–7 |
| **Rate limiting e anti-abuso** (hoje não há nenhum próprio) | 4–6 |
| Estado "em trial / não configurado": o agente não roda sem Chatwoot | 3–5 |
| Onboarding guiado (prompt inicial, primeiro documento) | 5–8 |
| Fluxo de aprovação pela agência (ou ausência dele, decidida) | 2–4 |
| **Imposto:** teste de isolamento do tenant recém-criado | 2 |

⚠️ **A conexão com o Chatwoot não é automatizável pelo cliente** — é a agência que a
configura. Ou seja, self-service leva o cliente até a porta, não até o agente rodando. Isso
precisa estar decidido antes de estimar, e é a razão da faixa larga.

## F7 — Papel "leitor" (somente leitura) · 30–45 h 🔴

Parece pequeno — "só mais um papel" — e é a segunda feature mais cara da lista, porque toca
o modelo de autorização inteiro.

| Tarefa | h |
|---|---|
| `Papel` passa de 2 para 3 valores: tipo, `app_metadata`, trigger de sync (migração 12) | 3–4 |
| **Revisar as policies RLS de todas as 11 tabelas** — hoje escritas para 2 papéis | 8–12 |
| **Adicionar gate nas 31 Server Actions** — leitor não escreve em nenhuma | 6–8 |
| `exigirLeitor` / ajustar `exigirTenantAdmin` em 18 páginas | 3–4 |
| Menu e UI: esconder botões de escrita sem depender só de CSS | 3–4 |
| **Imposto:** isolamento vira 3 papéis × 3 tenants, e o teste atual assume 2 | 4–6 |
| Convite: escolher papel ao convidar; migrar admins existentes | 2–3 |

O grosso está nas policies e nas 31 actions — cada uma precisa de decisão explícita, e
esquecer **uma** cria um caminho de escrita para quem não deveria escrever. É o tipo de
feature onde o teste de isolamento deixa de ser imposto e vira o entregável principal.

## F10 — Painel multi-idioma · 30–50 h 🔴

A [`auditorias/AUDIT-A11Y-I18N.md`](auditorias/AUDIT-A11Y-I18N.md) conclui que hoje o
português cravado é a **escolha certa** para um produto de mercado único. Esta estimativa é
o custo de reverter essa escolha.

| Tarefa | h |
|---|---|
| Instalar e configurar `next-intl` (ou similar) + roteamento por locale | 4–6 |
| Extrair **~148 strings de JSX** para catálogo | 8–12 |
| Extrair as **mensagens de erro das 31 Server Actions** (não contadas nas 148) | 6–10 |
| Pluralização real (hoje `"1 conversa(s)"` em 15 lugares) | 3–4 |
| Datas/números: remover `pt-BR` cravado em 10 pontos; **resolver o `timeZone`** | 3–5 |
| Seleção e persistência de idioma por usuário | 3–4 |
| Tradução propriamente dita (1 idioma) | 4–8 |

O item de datas se cruza com um **defeito já existente**: as datas não passam `timeZone` e
o container roda em UTC, então hoje já mostram hora errada. Quem fizer i18n vai tropeçar
nele de qualquer forma — e corrigir isolado custa ~30 min.

---

## Leitura dos números

**Três agrupamentos naturais:**

- **F6, F3, F4, F1 (21–38 h)** — features que a arquitetura atual *já suporta*. Usam o que
  existe: `prompt_versoes`, o Storage, o catálogo de tools, o swap atômico. Cabem numa
  sprint junto.
- **F2, F5, F8 (36–54 h)** — exigem infraestrutura nova (índice trigram, provedor de email,
  gravação no lado n8n), mas não mexem no modelo de segurança.
- **F7, F9, F10 (85–135 h)** — mexem em modelo de autorização, superfície de cadastro ou em
  toda a camada de apresentação. Cada uma é um projeto, não uma feature.

**O que as estimativas revelam sobre a arquitetura:**

O catálogo de tools (F1) é o melhor investimento já feito no projeto — transformou "vender
um módulo novo" de trabalho de engenharia em entrada de dados. Em contraste, o papel extra
(F7) custa 30–45 h porque a autorização está espalhada por 31 actions e 11 conjuntos de
policy: é barato quando são 2 papéis e cresce mal. Se houver plano de ter mais papéis, o
momento de centralizar a decisão de permissão é **antes** do terceiro, não depois.

---

## Método e limites

Features escolhidas por plausibilidade para este produto, não por sorteio. As tarefas de
cada uma foram derivadas da arquitetura real — contagens de Server Actions (31), páginas
(18), tabelas (11), strings de JSX (~148) e o passo a passo do `ADICIONAR-TOOL.md` vêm dos
levantamentos desta sessão, não de suposição.

**As horas são estimativa de engenharia, não compromisso.** Pressupõem um desenvolvedor
familiarizado com o repositório, incluem teste e rollback (que o `CLAUDE.md` exige) e
**não** incluem: design de interface, revisão de código, alteração no workflow do n8n além
do que está explicitado em F1 e F8, nem tempo de espera por janela de deploy. Faixas largas
(F9, F10) sinalizam decisão de produto ainda em aberto, não imprecisão de análise — e o
ponto onde a decisão precisa ser tomada está marcado no texto de cada uma.
