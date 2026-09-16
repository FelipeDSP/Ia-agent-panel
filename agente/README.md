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
| `WEBHOOK_TOKEN` | sim | segredo na URL do webhook: `POST /chatwoot/<token>/<inbox>`. Token errado → 404 |
| `LIMPEZA_SECRET` | sim | o `x-limpeza-secret` que o painel manda em `POST /limpar-memoria` (o mesmo `N8N_LIMPEZA_SECRET` do painel, apontando `N8N_LIMPEZA_URL` para cá quando o tenant estiver em código) |
| `OPENAI_API_KEY` | sim | o modelo (Responses API), os embeddings da base (`text-embedding-3-small`) e a transcrição (`whisper-1`) |
| `FOTO_SECRET` | não | o `x-foto-secret` da Edge Function `foto-produto`; sem ele a tool de foto responde ao modelo que não pôde enviar |
| `PORT` | não (3100) | porta HTTP |
| `WORKER_ID` | não | identidade na fila (`reivindicada_por`); default `agente-<pid>` |
| `WAHA_URL`, `WAHA_API_KEY` | não | notificação de anomalia (migração 53) e o alarme de agente mudo; sem elas os avisos viram só log |
| `ALARME_WAHA_SESSAO`, `ALARME_WAHA_DESTINO` | não | para onde vai o alarme de agente mudo |
| `FILA_LOTE` (10), `FILA_INTERVALO_MS` (1000), `FILA_LEASE_MIN` (5) | não | o worker |
| `TRACE_RETENCAO_DIAS` (30), `MUDO_MINUTOS` (10) | não | manutenção |
| `N8N_JS_DIR` | não | pasta com `extrair-e-filtrar.js` e `filtro-texto.js` (a imagem já aponta) |
| `VERSAO_CODIGO` | não | vai no trace e em `agente_prompts.versao_codigo`. A imagem já a preenche com o `SOURCE_COMMIT` que o Coolify passa no build; só defina para sobrescrever |

## Rotas

| | |
|---|---|
| `GET /saude` | 200 se o worker passou há menos de ~15 s; senão 503 (healthcheck do Coolify) |
| `POST /chatwoot/<token>/<inbox>` | o webhook do Agent Bot da conta. Responde **200 sempre** que o token bate — descartes inclusive (o Chatwoot não reenvia) |
| `POST /limpar-memoria` | mesmo contrato do webhook do n8n: header `x-limpeza-secret`, body `{ tenant_id, escopo: 'conversa' \| 'todas', conversation_ids? }`. Nada é apagado: é o **corte** (`conversas.memoria_cortada_em`) |

## Apontar uma conta para cá (por conta, reversível)

1. migrações 62 e 63 aplicadas; `tenants.agente_runtime = 'codigo'` para o tenant
   (como super_admin — `tenant_admin` leva 42501);
2. no Chatwoot, o Agent Bot da conta → `outgoing_url =
   https://<domínio>/chatwoot/<WEBHOOK_TOKEN>/<inbox>`;
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
src/manutencao.ts       retenção diária + alarme de agente mudo
```
