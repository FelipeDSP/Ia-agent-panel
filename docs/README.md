# Documentação — IA Agent Panel

Índice de tudo que vive em `docs/`. Código e configs ficam na raiz; aqui é só
documentação e material de referência.

## Especificação e arquitetura — [`especificacao/`](especificacao/)
- [`ESPECIFICACAO.md`](especificacao/ESPECIFICACAO.md) — **leia primeiro.** Modelo de
  dados, decisões de arquitetura e fases de implementação.
- [`ADENDO_ESTADO_ATUAL.md`](especificacao/ADENDO_ESTADO_ATUAL.md) — substitui §5.2 e
  §5.4 da spec com o estado atual.
- [`ESPEC-CATALOGO-DE-TOOLS.md`](especificacao/ESPEC-CATALOGO-DE-TOOLS.md) — iniciativa
  do catálogo de tools multi-tenant.
- [`FLUXO-CRITICO.md`](especificacao/FLUXO-CRITICO.md) — o caminho crítico do sistema.

## Guias
- [`ADICIONAR-TOOL.md`](ADICIONAR-TOOL.md) — **como adicionar uma tool nova** ao agente
  (lado n8n + lado painel), passo a passo.
- [`VERIFICACAO-GRUPOS-MODULOS.md`](VERIFICACAO-GRUPOS-MODULOS.md) — os três grupos de
  módulo (padrão / configurável / contratável), o que cada um mostra ao cliente, e o
  **roteiro para exercitar o filtro de `contratado`**, que existia desde a §5.2 e nunca
  tinha escondido nada.
- [`API-PUBLICA.md`](API-PUBLICA.md) — levantamento das 131 funções/classes exportadas,
  com as **31 Server Actions** (endpoints RPC) e o gate de autorização de cada uma.
- [`MAPA-COMPONENTES.md`](MAPA-COMPONENTES.md) — os 79 componentes React: árvore de
  renderização, props e estado de cada um. Sem estado global; `useActionState` é o
  primitivo dominante.
- [`MAPA-ROTAS.md`](MAPA-ROTAS.md) — as 16 rotas + route handler: parâmetros aceitos,
  guard de cada uma e as camadas middleware → layout → página → RLS.
- [`VARIAVEIS-DE-AMBIENTE.md`](VARIAVEIS-DE-AMBIENTE.md) — as 14 variáveis: onde são
  lidas, defaults e modo de falha. Inclui as duas de chunking que faltam no
  `.env.local.exemplo`.
- [`SIMULACAO-MIGRACAO-V2.md`](SIMULACAO-MIGRACAO-V2.md) — **planejamento, não executado.**
  Migração para um schema v2 (documentos normalizados, CHECK de modelo, HNSW parcial):
  queries afetadas, plano expand/contract e estimativa de 29–45 h.
- [`PENDENCIA-CATEGORIA-PRODUTO.md`](PENDENCIA-CATEGORIA-PRODUTO.md) — **próxima fatia
  de vendas.** A pergunta aberta ("o que vocês têm?") ainda é respondida por
  `order by nome`, e no Empório sai `1, 10, 11, 12, 13`: não parece amostra, parece
  defeito. Ordem de amostragem precisa de critério.
- [`PENDENCIA-GUARDA-STORAGE.md`](PENDENCIA-GUARDA-STORAGE.md) — **a fazer, com gatilho.**
  A guarda de dado alheio cobre 14 tabelas e **não** o Storage. Risco baixo hoje porque
  os caminhos já são escopados por tenant; o gatilho é o primeiro cliente além do
  restaurante-teste com foto no catálogo.
- [`PENDENCIA-SEED-DOS-TESTES.md`](PENDENCIA-SEED-DOS-TESTES.md) — **PARCIAL.** Os cinco
  testes de isolamento criam os próprios tenants desde 17/08; **outros nove seguem
  resolvendo seed por slug** e caem se alguém apagar o tenant pelo painel, como
  aconteceu em 13–17/08. Tabela dos nove com o modo de falha de cada um, e por que o
  guard estático (lista fixa de 5) não os enxerga.
- [`TOKENS-REAIS-PARA-COBRANCA.md`](TOKENS-REAIS-PARA-COBRANCA.md) — **decisao em aberto,
  com instrumentacao no ar.** Os tres caminhos para trocar a estimativa de tokens pelo
  numero que a OpenAI cobra: `intermediateSteps` (sonda B ja instrumentada), API de
  execucoes do n8n (recomendado — o `execucao_id` da migracao 37 ja e a chave de juncao)
  e chave por tenant (bloqueada por credencial de no nao aceitar expressao).
- [`AUDITORIA-PAINEL-CLIENTE.md`](AUDITORIA-PAINEL-CLIENTE.md) — percurso do painel do
  cliente sob a lente **decisao exigida sem criterio** (nao feiura). O caso central: o
  criterio de prompt-vs-base EXISTIA e estava fechado num `<details>` nas duas telas —
  o emporio pos 5.708 chars de fatos no prompt e 127 na base. Dois consertos feitos, o
  resto registrado com prioridade.
- [`PENDENCIA-EXPIRAR-RASCUNHO.md`](PENDENCIA-EXPIRAR-RASCUNHO.md) — **a fazer, com
  gatilho.** A 38 expira so `aguardando_pagamento`, e o indice de "um pedido aberto por
  conversa" cobre rascunho tambem: quem abandona o carrinho e volta amanha reencontra o
  de ontem. Inclui a armadilha medida — `atualizado_em` NAO se move ao adicionar item,
  entao "contar da ultima alteracao" viraria "da criacao" em silencio.
- [`PENDENCIA-PISO-SIMILARIDADE.md`](PENDENCIA-PISO-SIMILARIDADE.md) — **a fazer, com
  gatilho.** `match_kb_documentos` nao tem piso: sempre devolve o menos distante, nunca
  "nao tenho isso". Medido no corpus real, conteudo IRRELEVANTE chega a 0,625 e chunk do
  MESMO documento desce a 0,165 — as faixas se sobrepoem, entao piso fixo nao separa.
- [`PENDENCIA-FATURA-OPENAI.md`](PENDENCIA-FATURA-OPENAI.md) — **a fazer, com gatilho.**
  A parte NAO-tecnica da cobranca por consumo: como a fatura da OpenAI entra no sistema
  todo mes (quem pega, quando, e o que conta como consumo de cliente). Inclui a medicao
  de por que um tenant custa 4x outro (e o system_prompt, nao a KB) e a discussao EM
  ABERTO sobre cobrar o prompt do cliente — adiada ate medir 3 a 6 clientes. A gravacao
  dos componentes nao espera por ela: decomposicao nao e retroativa.
- [`PENDENCIA-MARGEM.md`](PENDENCIA-MARGEM.md) — **decidido não fazer, com gatilho.**
  Margem por cliente em `/admin/consumo`: por que não agora (não há valor de plano no
  schema, provedor de pagamento em aberto, custo de centavos) e o que a retoma.
- [`ESTIMATIVAS-FEATURES.md`](ESTIMATIVAS-FEATURES.md) — 10 features hipotéticas com
  breakdown de tarefas e horas, mais o **imposto fixo** que a arquitetura cobra de
  qualquer mudança.
- [`SIMULACAO-UPGRADE-DEPS.md`](SIMULACAO-UPGRADE-DEPS.md) — **simulado, não instalado.**
  Árvore em latest resolve limpa; 2 majors verificados como no-op e 1 gap silencioso no
  `setAll` do `@supabase/ssr`. 16–30 h em 5 ondas.

## n8n — [`n8n/`](n8n/)
- [`n8n-cutover.md`](n8n/n8n-cutover.md) — cutover do agente para este banco.
- [`n8n-limpar-memoria.md`](n8n/n8n-limpar-memoria.md) — limpeza da memória do agente.

## Auditorias — [`auditorias/`](auditorias/)
Relatórios de auditoria pontuais (confiabilidade, dados, débito técnico, dependências,
isolamento, multi-tenancy, performance, segurança, UI). Retratos de um momento — leia com
a data em mente.

**Antes de escrever uma auditoria de segurança nova, leia a seção "Escopo" de
[`AUDIT-SEC-ESTATICA.md`](auditorias/AUDIT-SEC-ESTATICA.md):** varredura de código não
alcança o estado do banco (ACL de função, RLS, grants), e foi por isso que aquele
documento afirmou "nada explorável" com seis `SECURITY DEFINER` abertas a `anon`.
- [`AUDIT-DEPENDENCIAS.md`](auditorias/AUDIT-DEPENDENCIAS.md) — inventário npm + Deno,
  vulnerabilidades e compatibilidade. Corrige a §3 de `AUDIT-DEBITO.md`: as 3 vulns HIGH
  **não** exigem Next 16.
- [`AUDIT-IMPORTS.md`](auditorias/AUDIT-IMPORTS.md) — grafo de imports (76 arquivos, 217
  arestas): zero ciclos, mapa de camadas e prova de que a fronteira client/server não
  vaza `service_role`.
- [`AUDIT-COMPLEXIDADE.md`](auditorias/AUDIT-COMPLEXIDADE.md) — Big O por função: zero
  recursão, zero O(n²); o custo é I/O. Inclui o risco de custo do chunker sob env mal
  configurada.
- [`AUDIT-COBERTURA.md`](auditorias/AUDIT-COBERTURA.md) — cobertura estimada: banco bem
  testado, código da aplicação em ~0%. Prioriza as funções puras que o banco **não**
  cobre.
- [`AUDIT-MEMORIA.md`](auditorias/AUDIT-MEMORIA.md) — zero leaks e zero estado global
  mutável; o ponto de atenção é a alocação de pico da ingestão, que o limite de 10 MB
  não cobre.
- [`AUDIT-BENCHMARK-TEORICO.md`](auditorias/AUDIT-BENCHMARK-TEORICO.md) — abordagens
  alternativas para 7 caminhos principais, em round-trips. Inclui os 3 RT redundantes
  do caminho de autenticação e as alternativas rejeitadas, com o motivo.
- [`AUDIT-SEC-ESTATICA.md`](auditorias/AUDIT-SEC-ESTATICA.md) — varredura por vetor
  (SQLi, XSS, CSRF, exposição de dados): nada explorável; o gap é a ausência de headers
  de segurança.
- [`AUDIT-A11Y-I18N.md`](auditorias/AUDIT-A11Y-I18N.md) — acessibilidade e locale. Base
  de a11y boa com 4 lacunas; e o **defeito** de data em UTC exibindo hora errada em
  produção.

## Marca — [`marca/`](marca/)
Assets-fonte da identidade ChatYou (logos, ícones). Os arquivos **em uso** pelo app
estão em `public/` (ex.: `chatyou-logo.png`); esta pasta é o material original.
