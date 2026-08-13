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
