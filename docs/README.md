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

## n8n — [`n8n/`](n8n/)
- [`n8n-cutover.md`](n8n/n8n-cutover.md) — cutover do agente para este banco.
- [`n8n-limpar-memoria.md`](n8n/n8n-limpar-memoria.md) — limpeza da memória do agente.

## Auditorias — [`auditorias/`](auditorias/)
Relatórios de auditoria pontuais (confiabilidade, dados, débito técnico, isolamento,
multi-tenancy, performance, segurança, UI). Retratos de um momento — leia com a data em
mente.

## Marca — [`marca/`](marca/)
Assets-fonte da identidade ChatYou (logos, ícones). Os arquivos **em uso** pelo app
estão em `public/` (ex.: `chatyou-logo.png`); esta pasta é o material original.
