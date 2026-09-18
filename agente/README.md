# `agente/` — o agente de IA em código

O segundo projeto no Coolify (DESENHO-AGENTE-EM-CODIGO.md §1). Um processo
Node 24, sem framework e sem Redis: receptor HTTP do Chatwoot + worker da fila
no Postgres + manutenção. **Fatia 2**: o agente de verdade — modelo (OpenAI,
Responses API, loop de tools nosso), as 6 ferramentas, memória de
`mensagens_log`, transcrição de áudio, filtro de saída e o **mesmo**
`aplica-portao.js` do n8n, com trace por turno e tokens reais.

O n8n **continua atendendo todos os tenants** até o bot de uma conta ser
apontado para cá. O serviço só atende tenant com `agente_runtime = 'codigo'`
(migração 62); qualquer outro é descartado com 200 — inclusive na pausa.

## Rodar

```
npm --prefix agente install
AGENTE_DB_URL=... WEBHOOK_TOKEN=... LIMPEZA_SECRET=... npm --prefix agente start
```

Node ≥ 24 (roda `.ts` direto). Tipos: `npm run teste:agente-tipos`. Teste de
ponta a ponta em transação abortada: `npm run teste:agente-fatia1`.

## Variáveis de ambiente (no Coolify, nunca no repo)

| variável | obrigatória | o que é |
|---|---|---|
| `AGENTE_DB_URL` | sim | conexão do role **`n8n_agent`** (a credencial "Agent ia Supabase" do n8n). O processo **recusa** subir com `postgres@` |
| `WEBHOOK_TOKEN` | sim | segredo na URL do webhook: `POST /chatwoot/<token>` (18/09: UMA URL para todos; `/<inbox>` no fim é opcional e, se vier, tem de bater com o corpo). Token errado → 404 |
| `LIMPEZA_SECRET` | sim | o `x-limpeza-secret` que o painel manda em `POST /limpar-memoria`. No Coolify do **painel**: `AGENTE_LIMPEZA_URL=https://<domínio>/limpar-memoria` e `AGENTE_LIMPEZA_SECRET=<este valor>`; o painel escolhe entre n8n e aqui por `tenants.agente_runtime` (`src/lib/limpeza-memoria-destino.ts`) |
| `OPENAI_API_KEY` | sim | o modelo (Responses API), os embeddings da base (`text-embedding-3-small`) e a transcrição (`whisper-1`) |
| `FOTO_SECRET` | não | o `x-foto-secret` da Edge Function `foto-produto`; sem ele a tool de foto responde ao modelo que não pôde enviar |
| `PORT` | não (3100) | porta HTTP |
| `WORKER_ID` | não | identidade na fila (`reivindicada_por`); default `agente-<pid>` |
| `WAHA_URL`, `WAHA_API_KEY` | não | notificação de anomalia (migração 53) e o alarme de agente mudo; sem elas os avisos viram só log |
| `CHATWOOT_AGENCIA_TOKEN` | não | token de USUÁRIO (admin da agência em todas as contas) do Chatwoot: abre a conversa do aviso ao dono pela inbox do agente (venda fechada, pagamento, transferência) — o token do Agent Bot não pode. Sem ele, aviso por WhatsApp só sai para conta com sessão WAHA (legado) |
| `ALARME_WAHA_SESSAO`, `ALARME_WAHA_DESTINO` | não | para onde vai o alarme de agente mudo |
| `FILA_LOTE` (10), `FILA_INTERVALO_MS` (1000), `FILA_LEASE_MIN` (5) | não | o worker |
| `TRACE_RETENCAO_DIAS` (30), `MUDO_MINUTOS` (10) | não | manutenção |
| `RETENCAO_TEXTO_DIAS` (45), `RETENCAO_TURNOS_DIAS` (45), `RETENCAO_CONTAGEM_DIAS` (400), `RETENCAO_CONVERSAS_DIAS` (180) | não | a política de retenção (67; `docs/POLITICA-RETENCAO.md`), aplicada 1x/dia |
| `N8N_JS_DIR` | não | pasta com `extrair-e-filtrar.js` e `filtro-texto.js` (a imagem já aponta) |
| `VERSAO_CODIGO` | não | vai no trace e em `agente_prompts.versao_codigo`. A imagem já a preenche com o `SOURCE_COMMIT` que o Coolify passa no build; só defina para sobrescrever |

## Pagamento (Asaas) por tenant

A credencial é por tenant (`tenant_credenciais`: ambiente, chave do ambiente, token
do webhook) e a agência a cadastra em *Clientes → cliente → Pagamento (Asaas)*: salva
a chave (write-only; sandbox começa com `$aact_hmlg_` e o validador recusa chave
trocada de ambiente) e clica **Registrar webhook** — o painel registra no Asaas
`<AGENTE_URL>/asaas` com o token do tenant. O painel descobre a URL do agente por
`AGENTE_URL` (ou deriva de `AGENTE_LIMPEZA_URL`). O módulo `pagamento` ainda precisa
estar contratado em Módulos para a tool existir.

## Rotas

| | |
|---|---|
| `GET /saude` | 200 se o worker passou há menos de ~15 s; senão 503 (healthcheck do Coolify) |
| `POST /chatwoot/<token>[/<inbox>]` | o webhook do Agent Bot da conta. Responde **200 sempre** que o token bate — descartes inclusive (o Chatwoot não reenvia) |
| `POST /asaas` | o webhook do Asaas (`PAYMENT_RECEIVED` / `PAYMENT_CONFIRMED`). Sem segredo na URL: o token vem no header `asaas-access-token` e é validado **por tenant** no banco (`api_n8n_pagamento_webhook`, a única função que escreve `pago`). Responde **200 sempre** com só o estado; token errado = `reconhecido:false`, sem efeito. Quando aplica: mensagem "Pagamento confirmado!" ao cliente pelo bot + registro em `mensagens_log` (o agente passa a saber) |
| `POST /limpar-memoria` | mesmo contrato do webhook do n8n: header `x-limpeza-secret`, body `{ tenant_id, escopo: 'conversa' \| 'todas', conversation_ids? }`. Nada é apagado: é o **corte** (`conversas.memoria_cortada_em`) |

## Apontar uma conta para cá (por conta, reversível)

**Pelo painel (desde 16/09):** *Clientes → cliente → Quem atende*. O card mostra
a URL do bot para cada runtime e troca a coluna na ordem certa, exigindo a
confirmação de quem apontou o bot. O painel precisa de `AGENTE_URL` (ou deriva de
`AGENTE_LIMPEZA_URL`), `AGENTE_WEBHOOK_TOKEN` (= o `WEBHOOK_TOKEN` daqui; sem ele a
URL sai com `<WEBHOOK_TOKEN>` para completar à mão) e `N8N_WEBHOOK_BASE` (ou deriva
de `N8N_LIMPEZA_URL`). À mão, o roteiro é o de sempre:

1. migrações 62 e 63 aplicadas; `tenants.agente_runtime = 'codigo'` para o tenant
   (como super_admin — `tenant_admin` leva 42501);
2. no Chatwoot, o Agent Bot da conta → `outgoing_url =
   https://<domínio>/chatwoot/<WEBHOOK_TOKEN>` (uma URL para todas as contas; a inbox vem do corpo);
3. uma mensagem na caixa → resposta da fatia 1 + turno em `agente_turnos`.

Voltar: a URL antiga no bot + `agente_runtime = 'n8n'`. A memória está em
`mensagens_log`, que os dois lados escrevem — voltar não perde contexto.

## Docker

`agente/Dockerfile`, **contexto de build = raiz do repo** (a imagem carrega
`n8n/extrair-e-filtrar.js` e `n8n/filtro-texto.js`, que continuam sendo a
fonte da decisão de entrada durante a transição — `src/entrada/extrair.ts`).

## Estrutura

```
src/main.ts             sobe HTTP + worker + manutenção; SIGTERM desliga
src/config.ts           env
src/db.ts               Db = { query }; fnUma/fnTodas/fnValor (só funções)
src/trace.ts            Turno: abrir / passo / medir / fechar
src/entrada/http.ts     as três rotas
src/entrada/receber.ts  classificar -> extrair -> tenant+runtime -> portão -> enfileirar
src/entrada/classificar.ts   o Roteia Evento (teste lê o JSON e compara)
src/entrada/extrair.ts  roda n8n/extrair-e-filtrar.js (fonte única na transição)
src/tenant/resolver.ts  api_n8n_tenant_por_chatwoot + api_agente_runtime
src/pausa/*.ts          humano assumiu; portão de entrada (migração 53)
src/fila/worker.ts      reivindicar -> turno_da_conversa -> executarTurno -> concluir
src/turno/executar.ts   o turno: sync -> portão de entrada -> mídia -> perfil/prompt/memória -> modelo -> filtro de saída -> portão -> Chatwoot -> log
src/turno/portao.ts     roda n8n/aplica-portao.js (o mesmo corpo) sobre api_n8n_estado_pedido
src/turno/saida.ts      limparVazamento (porte verbatim do Estima Tokens; teste de igualdade)
src/agente/modelo.ts    Modelo (OpenAI SDK, Responses API, loop de tools, usage real, teto de 10)
src/agente/prompt.ts    o system message por partes (== wrapper do n8n, byte a byte, testado); hash no trace
src/agente/openai-servicos.ts  embeddings e whisper
src/tools/*.ts          as 6 ferramentas (descriptions verbatim do JSON; gerenciar_pedido lê n8n/tool-pedido-acoes.mjs)
src/midia/transcrever.ts  api_n8n_pode_transcrever -> baixa -> whisper -> filtra-transcricao.js
src/n8n-js.ts           executor dos corpos JS do n8n que continuam sendo fonte
src/perfil.ts           api_n8n_tools_ativas -> basico | vendas
src/chatwoot/enviar.ts  POST messages com o token de Agent Bot
src/waha/notificar.ts   POST /api/sendText
src/manutencao.ts       retenção diária + alarme de agente mudo + encerramento dos links vencidos (5 min)
src/pagamento/asaas.ts  as 4 chamadas ao Asaas (chave por chamada, da linha do tenant)
src/pagamento/webhook.ts o webhook (extrai pelo MESMO webhook-pagamento-extrai.js; a função do banco decide)
src/tools/gerar-link-pagamento.ts  a 7ª tool, só para tenant com `pagamento` contratada; texto de n8n/tool-pagamento-resposta.js
```
