# Desenho — o agente em código

**Só desenho.** Nenhum código de runtime, nenhum serviço, nenhuma migração.
Escrito em 14/09/2026 a partir do `agente-principal.json` do repo (62 nós, 6
tools — a fusão; a instância tem 64, com `Fechar Pedido` e `Cancelar Pedido`
ainda ligados), dos 8 sub-workflows e da conferência da instância do mesmo dia. Cada seção termina com uma **decisão** ou uma **pergunta para o Felipe**.

## 0. O que este desenho NÃO promete

**Migrar não cura a fabricação de venda.** O que contém a fabricação é o
portão (`aplica-portao.js`), que já está no ar dentro do n8n e continua
existindo, idêntico, no código novo. Exigir tool antes de afirmar efeito é o
que o portão já faz. A primeira fabricação no sistema novo vai acontecer, e o
tratamento dela é o mesmo de hoje: portão, substituta, nota privada, `mensagens_log`.

O que a migração resolve é **transporte e medição**, e são quatro coisas:

1. a fila "escrito, não importado" — cinco itens hoje, cada um esperando um
   humano numa UI cuja sessão expira;
2. a família fonte↔derivado — quatro defeitos, um deles capaz de derrubar o
   agente para todo tenant (`42703` no caminho único);
3. segredo em parâmetro de nó saindo em todo export (`x-foto-secret`,
   `x-limpeza-secret` — vazaram de novo em 14/09);
4. não haver como medir experimento sem conversa real — as 10 conversas da
   fusão esperam import há dias; em código, rodam contra tenant efêmero.

**Decisão:** o argumento de venda do desenho é esses quatro. Nenhum outro.

---

## 1. Runtime e hospedagem

O turno tem debounce (8 s por default, configurável por tenant), Redis, loop
de tools e chamadas HTTP para Chatwoot/OpenAI/WAHA. Não cabe em função
serverless: o `Wait Debounce` sozinho estoura o timeout da Vercel, e o loop de
tools não tem teto curto.

| | decisão |
|---|---|
| forma | **processo Node/TypeScript próprio**, pasta `agente/` no mesmo repo, `package.json` próprio, compartilhando só tipos e o `.env` |
| onde | **Coolify, container separado do painel** (o repo já tem `Dockerfile` para o painel; o agente ganha o dele). Separado porque deploy do painel não pode reiniciar o agente no meio de um turno |
| entrada | `POST /chatwoot/<inbox>` responde **200 em < 1 s** e só enfileira — é o que o n8n faz hoje (`responseMode` default) |
| fila | **tabela no Postgres** (`agente_fila`, `for update skip locked`, `executar_em`), não memória do processo. Motivo na §3: o `Wait` do n8n é durável, e um `setTimeout` morre no restart |
| Redis | **não** — memória vem de `mensagens_log` e o debounce vem da fila (§3b). O Redis fica só com o n8n durante a transição |
| segredos | env do container (Coolify), nunca em código nem em tabela. O `x-foto-secret` vira env do agente; o `Limpar Memoria` vira endpoint do agente e o `N8N_LIMPEZA_SECRET` do painel passa a valer contra env, não contra constante |

**O que muda na operação, dito de frente.** Hoje o painel pode cair que o
atendimento continua, porque o n8n é outra máquina. Depois, o agente é **nosso
processo**: se cair, o Chatwoot recebe erro no webhook e **a mensagem se
perde** — não medi se o Chatwoot reenvia webhook que falhou; a suposição
conservadora é que não, e o que resolveria é derrubar o receptor de propósito
com uma mensagem em trânsito no `sendbox`. Isso exige três coisas que hoje não
existem:

- healthcheck no Coolify com restart automático;
- **alarme de agente mudo**: nenhuma linha em `mensagens_log` de um tenant
  conectado dentro do horário dele por N minutos → aviso por WAHA. O projeto
  já tem o sintoma catalogado ("agente mudo, calado" da caixa errada); vira
  detector;
- deploy do agente só por tag/commit explícito, não a cada push do painel.

**Respondido (14/09): o painel roda no Coolify**, e a escolha entre um
container e dois é nossa. **Decisão: dois projetos no Coolify**, mesmo repo,
`Dockerfile` próprio para `agente/`. O motivo é o de cima — deploy do painel
não pode reiniciar o agente no meio de um turno — e o segundo é operacional:
o painel pode ficar fora do ar sem o atendimento parar, que é o que acontece
hoje com o n8n em outra máquina. (O `CLAUDE.md` diz Vercel; está errado e
sai na próxima passada.)

---

## 2. Mapa nó-a-nó

Sessenta e quatro nós do principal, por módulo. **Negrito** = sem equivalente
óbvio, vira decisão na §3.

### `entrada/` — receber e classificar

| nó | módulo | nota |
|---|---|---|
| Webhook | `entrada/http` | responde 200 e enfileira |
| Roteia Evento (switch) | `entrada/classificar` | cliente (`incoming`, não privado) / humano (`outgoing`, `sender.type` ≠ `agent_bot` e não vazio) / **fallback `none` = descarta**. As duas condições do humano são o guarda-corpo contra o bot se pausar (`teste:notificacao-nao-pausa`) |
| Extrair e Filtrar (Code 6,6k) | `entrada/extrair.ts` | já é JS testado (`teste:extrair`); traz `filtro-texto.js` (blocklist) |
| Fala com o Cliente?, Nota Interna (ignora) | `entrada/classificar` | nota privada de humano não pausa |
| Resolve Tenant (pausa), Tenant Valido? (pausa), Pausa Conversa, Limpa Redis Debounce | `pausa/humano-assumiu.ts` | `Pausa Conversa` é statement único com CTE; o DEL do acúmulo aqui é **desejado** (README) |

### `tenant/` e `portao-entrada/`

| nó | módulo | nota |
|---|---|---|
| Resolve Tenant (`api_n8n_tenant_por_chatwoot`) | `tenant/resolver.ts` | **`alwaysOutputData`**: linha vazia segue para o IF. Caixa nula estoura `22023` de propósito |
| Tenant Valido? | idem | tenant inválido = descarta em silêncio (hoje) |
| Consulta Pausa (`api_n8n_portao_mensagem`), Nao Pausada?, Humano Atende (ignora), Anomalia?, Notifica Anomalia WAHA | `pausa/portao-entrada.ts` | a anomalia da 53 é decidida **no banco**; o código só notifica. `Notifica Anomalia WAHA` tem **`onError: continue`** |

### `midia/` — áudio e bloqueio

| nó | módulo | nota |
|---|---|---|
| Roteia Acao (processar / midia / bloqueado) | `midia/rotear.ts` | |
| Config Audio, Audio Contratado?, Audio Curto? | `midia/audio.ts` | `api_n8n_pode_transcrever` |
| Baixa Anexo, Transcreve (OpenAI), Filtra Transcricao (Code 5,7k), Roteia Transcricao | `midia/transcrever.ts` | `Filtra Transcricao` **não tem teste**; reaplica `filtro-texto.js`; `verbose_json` traz a duração cobrada (`SEM_DEFAULT`) |
| Avisa Audio Longo / Falhou / Midia Nao Suportada | `midia/avisos.ts` | três HTTP ao Chatwoot com texto por tenant |
| Credencial (bloqueio), Envia Resposta Bloqueada | `midia/bloqueio.ts` | injection detectada → resposta fixa, sem modelo |
| Mensagem Pronta (Code 4k) | `midia/mensagem-pronta.ts` | **não tem teste**; junta texto/transcrição em um objeto único |

### `debounce/` — o módulo mais delicado

| nó | módulo | nota |
|---|---|---|
| Sync Conversa (`api_n8n_conversa_sync`) | `conversa/sync.ts` | **`alwaysOutputData`** |
| Acumula Mensagem (RPUSH), Lista Antes (GET), **Wait Debounce**, Lista Depois (GET), Ultima Mensagem? (`antes == depois` **e** `depois.length > 0`), Acumulo Sumiu?, Acumulo Sumiu (corrida) (**stopAndError**), Separa Lidos, Remove Lidos do Acumulo (LPOP ×N), Volta a Um Item | `debounce/janela.ts` | os dez nós viram a fila + lock por conversa (§3b). A corrida custou três execuções para aparecer (README); o `Wait` é **durável** no n8n e a fila também |

### `perfil/` e `agente/`

| nó | módulo | nota |
|---|---|---|
| Tools Ativas (`api_n8n_tools_ativas`), Vende?, Perfil Nao Resolvido (**stopAndError**) | `perfil/resolver.ts` | básico × vendas |
| **OpenAI Chat Model** | `agente/modelo.ts` | modelo e temperatura por tenant (`Resolve Tenant`) |
| **Redis Chat Memory** (`tenant_<t>_memory_<conv>`, TTL 2400, janela 20) | `agente/memoria.ts` | derivada de `mensagens_log`, sem Redis — §3b |
| **AI Agent Basico / AI Agent Vendas** | `agente/loop.ts` | o loop de tools do LangChain: **máximo de iterações, formato do resultado de tool, o que acontece quando o modelo devolve texto e tool ao mesmo tempo** — nada disso está escrito em lugar nenhum hoje |
| Busca Conhecimento, Transferir para Humano, Resolver Conversa (3 tools do básico) + Consultar Catalogo, Gerenciar Pedido, Enviar Foto (só vendas) | `tools/*.ts` | `$fromAI` vira JSON Schema explícito; as `description` (7 de 8 órfãs hoje) viram **código versionado e testado** |

### `pos-turno/`

| nó | módulo | nota |
|---|---|---|
| Estima Tokens (Code 32,8k) | `turno/tokens.ts` | **substituído por `usage` real** da resposta da OpenAI, somado por iteração do loop. Ver §4 sobre `componentes_json` |
| Estado do Pedido (`api_n8n_estado_pedido`), Aplica Portao (Code 16,9k) | `turno/portao.ts` | já é JS testado por quatro testes; a lista de colunas que ele lê **deixa de ser derivada** — é `select *` tipado |
| Credencial (resposta), Envia Mensagem Chatwoot | `chatwoot/enviar.ts` | |
| Registra Mensagem (`api_n8n_registrar_mensagem` ×2) | `turno/registrar.ts` | grava `$execution.id` → vira `turno_id` do trace |
| Portao Transferiu?, Nota Privada (portao) | `turno/portao.ts` | |

### Sub-workflows e os três avulsos

| workflow | módulo | nota |
|---|---|---|
| Tool - Busca KB (embedding OpenAI → `api_n8n_buscar_kb` → `busca-kb-consolida.js`) | `tools/busca-kb.ts` | `Busca Vetorial` **`alwaysOutputData`**; consolida **não tem teste** |
| Tool - Transferir para Humano (`avalia-horario`, nota privada, `Pausa Agente` **`onError: continue`**, WAHA **`onError: continue`**) | `tools/transferir.ts` | |
| Tool - Resolver Conversa (`api_n8n_tem_pedido_pendente` antes de resolver) | `tools/resolver.ts` | |
| Tool - Consultar Catalogo | `tools/catalogo.ts` | |
| Tool - Gerenciar Pedido (5 ações; notificação de venda com **três `onError: continue`** e `Reivindica` **`alwaysOutputData`**) | `tools/pedido.ts` | `teste:tool-pedido-fundida` já roda o JSON |
| Tool - Enviar Foto (`api_n8n_enviar_foto` → assina na Edge Function → baixa → Chatwoot) | `tools/foto.ts` | o `x-foto-secret` sai do parâmetro e vai para env |
| Tool - Gerar Link de Pagamento + Webhook Asaas | `tools/pagamento.ts`, `entrada/asaas-webhook.ts` | escritos, não importados — **nascem direto no código** |
| Pagamento Sandbox — Passo 0 | some | o roteamento por caixa é o próprio `entrada/http` |
| Limpar Memoria (Webhook do Painel) | `entrada/limpar-memoria.ts` | mesmo contrato do painel (`x-limpeza-secret`, `escopo`), segredo em env |

**Decisão:** o contrato com o banco **não muda**: as 28 `api_n8n_*` continuam
sendo a única porta, chamadas como `n8n_agent` (o role já tem os grants e
`teste:grants-n8n` os vigia). O nome `api_n8n_` fica — renomear 28 funções
para agradar o nome é a migração que quebra o n8n no meio da transição.

---

## 3. O que hoje é implícito do n8n e vira decisão

| implícito | onde | decisão |
|---|---|---|
| `alwaysOutputData` | Resolve Tenant, Sync Conversa, Busca Vetorial, Busca Config (transferir), Reivindica Notificacao | resultado vazio vira `null` explícito e o `if` seguinte trata; nenhum "continua com item vazio" por acidente |
| `onError: continueRegularOutput` | 9 nós, todos de **notificação** (WAHA ×3, Chatwoot ×3, claim/confirmação ×2, Asaas ×1) | `try/catch` **por nó**, erro gravado no trace com o nome do passo. Regra do README mantida: **nunca** em log nem billing — `Registra Mensagem` e `Envia Mensagem Chatwoot` estouram o turno |
| `stopAndError` | Acumulo Sumiu (corrida), Perfil Nao Resolvido | exceção tipada → turno `falhou` no trace **e** alarme; não pode virar log silencioso |
| `Wait` durável | Wait Debounce | a espera vive na fila do Postgres (`executar_em = now() + debounce`), não em `setTimeout`. Restart no meio do debounce **não perde** a mensagem — hoje o n8n retoma a execução |
| item linking / `.first()` | 112 ocorrências | some: um turno é **um objeto**, sem itens |
| `Limit maxItems=1` | Volta a Um Item | some pelo mesmo motivo — e o teto de **uma resposta por mensagem** vira asserção do trace (um `saida` por turno) |
| memória do LangChain no Redis | Redis Chat Memory | **substituída** por memória derivada de `mensagens_log` com corte (§3b). O formato do LangChain deixa de precisar ser reproduzido; a semântica (janela 20, 40 min) vira parâmetro |
| loop do AI Agent | AI Agent Basico/Vendas | escrever o que hoje é default do nó: **máximo de 10 iterações** (default do LangChain), tool + texto na mesma resposta → executa a tool e ignora o texto, resultado de tool volta como string. Cada decisão dessas muda comportamento e **nenhuma está medida** — é o maior risco de paridade |
| `$fromAI` | 6 tools | JSON Schema por tool, `additionalProperties: false`; `tenant_id`/`conversation_id` **nunca** no schema (regra do README, mantida) |
| tool não contratada | sub-workflow recusa com `tool_ativa=false` | o código **nem oferece** a tool ao modelo (lista vem de `api_n8n_tools_ativas`) — **e** a função de banco continua conferindo por dentro. Duas camadas, como hoje. Muda o que o modelo vê; por isso é **depois** do experimento da fusão |
| `$execution.id` em `mensagens_log` | Registra Mensagem | vira `turno_id` (uuid) — coluna já é `text` |
| `Estima Tokens` / `componentes_json` | pós-turno | tokens **reais** por chamada (`usage.prompt_tokens`/`completion_tokens`, somados). `componentes_json` continua sendo gravado com o rateio **estimado** (system, memória, tools, mensagem) porque é o que separa "quem usa mais ferramenta" — e ganha um campo `real_total` ao lado |

**Respondido (14/09): o rateio por componente continua importando.**
Decisão: `componentes_json` continua sendo gravado com o rateio estimado
(system, memória, tools, mensagem) e ganha `real_total` ao lado; o total real
é o que vai para a cobrança e o rateio é o que explica quem gasta com quê. A
diferença entre os dois, por turno, vira o dado que a §5.8 registra.

---

## 3b. Modelo, memória e debounce — o que NÃO é copiar do n8n

Pergunta do Felipe em 14/09: "não dá pra dar ctrl-c ctrl-v do n8n para a
aplicação". Não dá, e estas são as três peças em que copiar seria copiar a
limitação.

### Modelo: SDK da OpenAI direto, loop nosso

| decisão | motivo |
|---|---|
| SDK oficial `openai`, **Responses API** | é a que a instância já usa (`responsesApiEnabled: true`) |
| **sem LangChain, sem AI SDK** | o loop de tools do LangChain é o que hoje ninguém sabe descrever (§3: iterações, texto+tool, formato do retorno). Em código são ~50 linhas: mensagens + schemas → `tool_call`? executa, anexa, repete; teto explícito; `usage` real por chamada |
| `modelo` e `temperatura` por tenant, do banco | como hoje; **não** muda durante a paridade |
| interface `Modelo` de um arquivo | trocar provedor um dia é trocar um arquivo, sem abstração que esconda o loop |
| system message montado de **partes versionadas** + `prompt_sistema` do tenant + a seção de cada tool **oferecida** | acaba o template gigante no gerador; o **hash do prompt montado** vai no trace, e experimento passa a ser atribuível a uma versão |

### Memória: sai do Redis, vem de `mensagens_log`

Hoje: lista no Redis no formato do LangChain, TTL 2400 s renovado a cada
escrita, janela de 20. O banco **já tem** cada entrada e cada saída por
conversa, compartilhado pelos dois sistemas, e é a fonte da verdade.

| decisão | consequência |
|---|---|
| memória = últimas N mensagens da conversa em `mensagens_log` **a partir de um corte** (`conversas.memoria_cortada_em`) | "Limpar memória" (botão do painel) **marca o corte** em vez de apagar chave — nada some, o log segue auditável |
| **ISTO MUDA O COMPORTAMENTO, e é decisão, não efeito colateral.** A memória do Redis guarda a saída **bruta** do modelo; `mensagens_log` guarda o texto **depois do portão** — a substituta, quando barrou (o bruto só existe em `componentes_json.portao.bruto`, e só nesse caso; `aplica-portao.js:488`). Foi da memória bruta que saiu o achado de que **a memória envenenada agrava a modalidade C**: o recital fabricado volta ao contexto no turno seguinte | **Decisão: a memória é o texto pós-portão.** O contexto deixa de ser contaminado pela fabricação anterior. O bruto vai para o trace, nunca para a memória. E o teste de paridade da memória **diverge exatamente aí** — no turno em que o portão barrou, o n8n tem o bruto e o código tem a substituta — e essa divergência está **nomeada no teste como esperada**, para ninguém "consertar" lendo o bruto e reintroduzir o envenenamento |
| **os 40 minutos já foram decididos**, em `5e717f4` (08/09): 264 intervalos medidos, 2 h dominado, e o desempate foi "memória expirada não perde o pedido — ele está em `pedidos` e `ver` o recupera". Posição do Felipe em 14/09, para a paridade: **esquecer é mais seguro que lembrar demais** | reproduzido como parâmetro explícito, `MEMORIA_SILENCIO_MIN = 40`, **deslizante por escrita** como o nó faz (`EXPIRE` a cada escrita, lido no `@langchain/redis`): a memória começa **depois do último intervalo maior que 40 min** entre mensagens consecutivas da conversa, e só então pega as últimas 20. Não é "nada nos últimos 40 min": a mensagem que acabou de chegar renovaria o prazo e traria tudo de volta — a regra tem de olhar o **intervalo**, não o instante |
| a memória **sobrevive à migração** | conversa que troca de lado no meio mantém contexto, porque o n8n escreveu no mesmo log. Com Redis separado se perderia |
| o que entra: pares humano/agente, como hoje | tool calls **não** entram na memória (o LangChain também não as guarda); ficam no trace |
| **custo de tirar o Redis, medido** (14/09): `idx_log_conversa (tenant_id, conversation_id, criado_em)` já existe; a consulta da memória é `Index Scan Backward`, **4 buffers / 2,7 ms** na janela de 40 min e **10 buffers / 0,7 ms** no pior caso — a conv 20 do `emporio`, com 11.286 linhas (o laço de agosto). Tabela: 12.262 linhas, 11 MB | irrelevante no volume atual e continua irrelevante com o índice; se um dia a tabela for particionada por tempo, a memória precisa do prefixo `tenant_id, conversation_id` na partição também |

Isto muda a linha "memória do LangChain no Redis" da §3: o formato do
LangChain deixa de precisar ser reproduzido. O teste de paridade da memória
passa a ser "as N últimas mensagens que o código monta são as que o n8n teria
na lista" — comparável pelo log.

### Debounce: também sai do Redis — a fila resolve

O RPUSH/LPOP, o `Limit` e a corrida que custou três execuções existem porque
o n8n não tem fila. Com a fila no Postgres (§1):

1. cada mensagem entra em `agente_fila` com `executar_em = now() + debounce`;
2. ao acordar, o worker trava a conversa (`pg_advisory_xact_lock(tenant,
   conversa)`) e pega **todas** as mensagens ainda não respondidas dela;
3. se existe mensagem **mais nova** que a sua já na fila, desiste — a mais
   nova responde por todas. É o `Ultima Mensagem?` sem GET/GET/DEL;
4. responde uma vez, marca todas como respondidas.

Ganhos que o n8n nunca deu: **um turno por vez por conversa** (o lock), zero
mensagem perdida em restart (a fila é durável), e a corrida deixa de ser
possível por construção — o teste da §4 continua obrigatório, mas passa a
provar ausência, não cuidado.

**Decisão: o agente não usa Redis.** Um serviço a menos para instalar,
monitorar e vazar. O n8n continua com o dele durante a transição, sem
conflito: as chaves são dele, ninguém mais as lê.

### O resto, em uma linha cada

- **tools**: um módulo cada — schema (`zod` → JSON Schema, `additionalProperties:
  false`), `description` versionada (7 de 8 são órfãs hoje), `executar()` que
  chama a `api_n8n_*`, e o texto que volta ao modelo. `tenant_id` e
  `conversation_id` vêm do turno, nunca do schema;
- **transcrição e embeddings**: o mesmo SDK (Whisper com `verbose_json` pela
  duração cobrada; `text-embedding-3-small`, 1536, fixo). Sai só o nó HTTP à mão;
- **tokens**: reais por chamada + rateio estimado ao lado (respondido na §3);
- **qual lado atende o tenant**: `tenants.agente_runtime` (`'n8n' | 'codigo'`)
  — o painel consulta para o "limpar memória" chamar o lado certo, e o alarme
  de agente mudo usa para saber quem vigiar. É a única coluna nova que a
  transição pede em `tenants`. **Guarda de agência, nascendo junto:** a lista
  branca de `tenants_guard_colunas` é o que o `tenant_admin` **pode** editar
  (`system_prompt, agente_ativo, debounce_segundos, msg_midia_nao_suportada,
  msg_fora_escopo`); `modelo` e `temperatura` já estão fora, e
  `agente_runtime` nasce fora — o teste da migração afirma que a coluna **não
  está na lista** e que `tenant_admin` recebe `42501` ao tocá-la. Um cliente
  não troca o próprio runtime.

O que **não** muda: as 28 funções do banco, o portão, o filtro de injection,
a pausa e a anomalia da 53 — já é código ou já é banco.

---

## 4. O que precisa de teste ANTES de migrar

Teste do comportamento **atual**, escrito contra o n8n/JS de hoje, para o
código novo ter o que igualar. Sem isso "paridade" é leitura.

| comportamento | hoje | precisa |
|---|---|---|
| Extrair e Filtrar, portão, tokens, tool de pedido, tool de pagamento, notificação não pausa | `teste:extrair`, `teste:portao*`, `teste:componentes-no`, `teste:tool-pedido-fundida`, `teste:tool-pagamento`, `teste:notificacao-nao-pausa` | já existem; viram testes diretos do módulo |
| **debounce + LPOP**: duas mensagens na janela → uma resposta; o que chegou durante a espera fica na lista | nenhum (a regra vive em `n8n:sincronia`, que confere o JSON) | teste com Redis efêmero, duas "execuções" concorrentes, afirmando **uma** saída e a lista com o que sobrou |
| **a corrida do debounce** (execução B lê lista vazia depois do DEL de A) | nenhum executável — está descrita no README | reproduzir a linha do tempo do README com dois workers; exigir `Acumulo Sumiu (corrida)` **antes** de qualquer DEL |
| pausa: humano assume → DEL do acúmulo, sem resposta; bot não se pausa | `teste:pausa`, `teste:notificacao-nao-pausa` (leem o switch do JSON) | executar o roteador do código com os mesmos payloads sintéticos |
| anomalia da 53 (loop bot-a-bot) | `teste:anti-loop` (função de banco) | só o ramo "notifica por WAHA e não responde" precisa de teste no código; a decisão continua no banco |
| transcrição: bloqueio, áudio longo, falha, `verbose_json` | nenhum para `filtra-transcricao.js` e `mensagem-pronta.js` | fixtures da resposta da OpenAI (sucesso, vazio, injection na fala) |
| foto via WAHA/Chatwoot | `teste:fotos` (isolamento) | resposta ao agente (`enviar-foto-resposta.js`) por caso: permitido, não permitido, falha de download |
| memória: as N mensagens que entram no prompt | nenhum | dado um `mensagens_log` sintético (com corte e com silêncio de 40 min), o código monta a mesma lista que o n8n teria na chave Redis — comparável pelo log, sem Redis |
| busca KB: consolidação e o piso de similaridade | `teste:recall` (custa OpenAI) | `busca-kb-consolida.js` com fixtures — hoje sem teste |

**Decisão:** os sete sem teste (debounce, corrida, transcrição, mensagem
pronta, foto-resposta, memória, consolida KB) são **pré-requisito da fatia 1**,
escritos contra o JS atual. Nenhum módulo é migrado antes de o teste do
comportamento atual existir.

**Fatia 0 entregue em 14/09/2026** — os sete existem, todos com sabotagem por
md5:

| teste | cobre | o que fixou |
|---|---|---|
| `teste:transcricao` (20) | `Filtra Transcricao` e `Mensagem Pronta`, do corpo no JSON | `audio_segundos` é o **cobrado** (`usage.seconds`=2, não 1,78); injection falada bloqueia; `Mensagem Pronta` lê `Extrair e Filtrar` por nome e **lança** sem mensagem |
| `teste:foto-e-kb` (19) | `Resposta ao Agente` e `Consolida Resultado` | o domínio de `motivo` vem do CHECK **no banco** (`pg_get_constraintdef`), não de lista copiada; `NENHUM_RESULTADO`; aviso de fonte com `vende` |
| `teste:modelos` (32) | debounce e memória como **modelos executáveis** (`tests/lib/debounce-modelo.mjs`, `memoria-modelo.mjs`) | as condições vêm lidas do JSON (comprimento, `d2`, LPOP, `Limit 1`, TTL 2400, janela 20); 8 cenários do debounce inclusive a **corrida do README** (DEL entre RPUSH e GET) e a pausa que hoje vira erro vermelho (`divergencia_esperada`); memória n8n × código idênticas em 7 casos e **divergindo só na saída barrada** (nomeado); a armadilha do "agora − 40 min" provada |

Dois limites escritos nos próprios modelos: a brecha de milissegundos entre
o GET depois e o LPOP não é representável em instantes discretos (fica como
limite, e é uma das razões da fila com lock); e `contextWindowLength = 20` é
tratado como 20 **pares** (40 mensagens, o `slice(-k*2)` do
BufferWindowMemory) — suposição a conferir na versão instalada, isolada em
`JANELA_PARES`.

Os cenários são a **interface** que o código novo implementa: `simular(cenario)`
com a mesma saída, e os mesmos casos dizem onde diverge.

**Fatia 1, lado do banco — ESCRITA em 14/09/2026, NÃO APLICADA:**
`supabase/migrations/20260914200000_62_agente_em_codigo_fatia1.sql` (+ rollback,
que aborta com tenant em `codigo` ou turno gravado). `teste:migracao-agente`
59/59 em transação abortada, rollback-first, aplicada duas vezes:

| o que a 62 cria | o teste prova |
|---|---|
| `tenants.agente_runtime` (`n8n`/`codigo`, default `n8n`) | aplicar não liga ninguém; fora da lista branca do guard; `42501` sem claim; CHECK |
| `conversas.memoria_cortada_em` | o corte substitui o DEL do Limpar Memoria |
| `agente_fila` + `api_agente_enfileirar` / `reivindicar` / `turno_da_conversa` / `concluir` | responder / desistir / adiar / lease vencido, com três tenants e a mesma `conversation_id` em dois; B não alcança a fila de A (`22023`) |
| `agente_prompts`, `agente_turnos`, `agente_passos` + `prompt_registrar` / `turno_abrir` / `passo` / `turno_fechar` / `varrer_passos` | hash por tenant; saída de tool truncada a 16 KB e marcada, bruto do modelo inteiro; ordem única; retenção apaga só o velho |
| `api_agente_memoria` + `agente_texto_entrada` | **idêntica ao modelo JS** sobre o mesmo log em 7 casos (silêncio 41/39, 25 pares, corte, literal de array `{oi,"…"}`); B não vê o log de A |
| RLS + policy em cada tabela; `anon` sem grant; ACL das 13 funções **igual ao da irmã** `api_n8n_gerar_cobranca`; chamada real como `n8n_agent` | `teste:grants-n8n` passou a varrer `api_agente_*` também |

Dois defeitos que o teste pegou antes de a migração existir em produção: "mais
nova" comparava `executar_em`, e o `adiar` empurra `executar_em` para o
futuro — a mensagem **mais velha** passava por mais nova e a conversa nunca
respondia; e `criado_em` não serve para "chegou depois" dentro de uma
transação (mesmo `now()`). A fila ganhou `seq` de identidade, e "mais nova" é
`seq` maior. E um terceiro, pego pelo teste do serviço: quando o lote reivindica
a mensagem velha e a nova de uma vez, a nova já não está `pendente` e a velha
caía em `adiar`; agora "mais nova reivindicada por **este** worker" também é
`desistir`, e `adiar` é só turno de **outro** worker em andamento.

**15/09/2026, 21:58 UTC — o `sendbox` está no código.** Migração 62 aplicada
(ledger `20260914200000`, 16 `api_agente_*`, 28 `api_n8n_*` intactas, ninguém
ligado no ato); serviço no Coolify em `https://hercules.chatyou.chat` (projeto
próprio, role `agente_codigo` membro de `n8n_agent`); `estudyou-sendbox` em
`agente_runtime = 'codigo'` e o bot Hércules apontado para
`/chatwoot/<token>/282`. Primeira mensagem real: fila → turno `9f6612ba…` em
4,5 s (3 s de debounce), Chatwoot `5266023`, log com `execucao_id` = turno, e
os webhooks de volta da própria resposta descartados sem pausar. `emporio` e
`ceejaar` seguem no n8n, intocados.

**Fatia 2 — ESCRITA em 16/09/2026 (`agente/`):** o agente de verdade. `agente/modelo.ts` (SDK da
OpenAI, Responses API, loop de tools nosso, teto de 10, `usage` real por
chamada); `agente/prompt.ts` (system message por partes — provado **byte a
byte igual** ao wrapper do n8n nos dois perfis, com as duas regras que só o
básico carrega; hash no trace); as 6 tools com as `description` verbatim do
JSON e `gerenciar_pedido` lendo `n8n/tool-pedido-acoes.mjs`; memória de
`api_agente_memoria`; transcrição (`whisper-1` → `filtra-transcricao.js`);
filtro de saída (porte de `limparVazamento`, provado igual à função original
extraída do nó); e o **mesmo `aplica-portao.js`** rodando sobre
`api_n8n_estado_pedido`. Os corpos JS do n8n que continuam sendo fonte rodam
pelo `agente/n8n-js.ts`. `teste:agente-servico` **56/56** com o modelo falso,
inclusive: fabricação ("Pedido fechado! Total R$ 80,00") **barrada** pelo
portão em código, bruto em `mensagens_log.portao` e a memória do turno
seguinte levando a substituta; tool executando no banco; tokens reais no log
(`fonte_tokens = openai_usage`); teto → `TEXTO_TETO`.

**Fatia 2 no ar — 16/09/2026 12:44.** Primeiro turno real com modelo no
`sendbox` (`8aa3265b…`, conversa 51): 4,4 s, `gpt-4.1-mini`, 2 chamadas,
`consultar_catalogo` executada, portão `passou`, Chatwoot `5268792`, tokens
reais **10.258 / 133** no log. A resposta respeitou o teto de 5 itens e fechou
com pergunta que estreita. O trace revelou o cabeçalho do turno sem `perfil` e
`prompt_hash` (o turno é aberto antes de o perfil existir; `turno_fechar` não
os recebe) — **migração 63** (`api_agente_turno_prompt`, chamada no instante
em que o prompt é montado, função nova para não mexer na assinatura da 62) e
`versao_codigo` vindo do `SOURCE_COMMIT` do Coolify em vez de `dev`. O relógio
dos 7 dias da §5.4 começou aí; termina 23/09.

Divergências declaradas da fatia 2: áudio é transcrito no turno (não na
chegada); avisos de mídia entram em `mensagens_log` como saída sem modelo; o
rateio por componente é proporcional aos caracteres, escalado para o total
real.

**Fatia 1, o serviço — ESCRITO em 15/09/2026 (`agente/`):**
receptor com token na URL, `classificar` provado igual ao `Roteia Evento` do
JSON, `extrair` rodando o **mesmo** JS do n8n, portão de runtime nos dois
caminhos (cliente e humano), pausa com descarte silencioso, worker da fila,
turno com texto fixo, trace completo, `limpar-memoria`, retenção e alarme de
agente mudo. `teste:agente-fatia1` 46/46 em transação abortada com Chatwoot e
WAHA falsos; `teste:agente-tipos` (`tsc`). Roteiro de apontar uma conta em
`agente/README.md`.

---

## 5. Critério de paridade — o que precisa estar verde para o `emporio` mudar de lado

Escrito antes. "Está pronto" é esta lista, não opinião.

1. **Suíte inteira verde** no código novo, incluindo os testes da §4, e
   `teste:grants-n8n` provando que o role do agente chama as 28 funções.
2. **Replay de conversas reais**: as últimas 200 mensagens de entrada do
   `emporio` e do `ceejaar` (de `mensagens_log`, texto já sanitizado) passam
   pelo pipeline **até antes do modelo** — extrair, tenant, pausa, mídia,
   debounce — e produzem o mesmo `acao`/roteamento que o n8n produziu (o log
   tem o que saiu). Sem chamar a OpenAI, sem enviar nada.
3. **Dez conversas sintéticas** no `sendbox` (as mesmas da fusão), com o
   agente novo respondendo de verdade: nenhuma fabricação que o portão não
   barre; tokens reais gravados; trace completo por turno.
4. **`sendbox` roteado pelo código por 7 dias corridos** sem: turno `falhou`
   não explicado, mensagem sem resposta, resposta dupla, pausa indevida.
5. **Alarme de agente mudo** disparou uma vez de propósito (parar o container)
   e chegou pelo WAHA.
6. **Limpar Memoria** pelo painel funciona contra o agente novo (o botão em
   `conversas/lista.tsx`).
7. **Rollback ensaiado**: apontar a caixa de volta para o n8n e uma mensagem
   ser respondida por ele, com a memória do Redis intacta.
8. **Diff de custo**: tokens reais × estimativa do `Estima Tokens` nos mesmos
   turnos, registrado — é o dado que decide a §3 (rateio).

**Decisão:** o `emporio` só muda com os oito. Nenhum é opcional, e o 4 tem
prazo em dias, não em "quando parecer estável".

**Estado dos oito, em 16/09/2026:**

| # | estado |
|---|---|
| 1 | suíte verde; `teste:grants-n8n` varre `api_agente_*`; **63 aplicada 16/09** (cabeçalho do turno com `perfil` e `prompt_hash`, visto nos turnos das 13:41 em diante) |
| 2 | **REDEFINIDO** — ver abaixo |
| 3 | **VERDE em 16/09** (roteiro em vez das "mesmas da fusão", que nunca foram escritas): saudação/base, catálogo/preço, foto (item sem foto: não inventou), pedido multi-item + fechar (R$ 419,80, bate com o banco), **pagamento afirmado** (o modelo NÃO afirmou; portão avaliou e passou), **áudio** (transcrito depois de descobrir que o Chatwoot dispara o webhook ~26 s antes de o arquivo existir — `baixarAnexo` espera), **injeção** (`bloqueado`, sem modelo), **transferência** (tool, nota privada, pausa), **pausada → silêncio** (3 descartes `pausada_na_entrada` no log), despedida (`resolver_conversa` chamada, **recusou** porque a venda nº 3 está `aguardando_pagamento` — regra da 38, idêntica ao n8n; vide PENDENCIAS). Todas as saídas com veredito `passou`; zero fabricação |
| 4 | relógio correndo desde 16/09 12:44; termina 23/09 |
| 5 | **VERDE em 16/09** nas duas metades. (A) Linha sintética pendente na fila: `api_agente_mudos` viu aos 10,6 min, o serviço tentou o WAHA e levou **422** — a sessão `chatyouteste` estava STOPPED no WAHA (única parada em 47; é também a sessão de notificação do sendbox/restaurante-teste/fortalize, então esses avisos falhavam em silêncio no n8n). Sessão trocada, container reiniciado: alarme disparou no 1º ciclo e chegou no WhatsApp. (B) Container parado: `/saude` sem rota; mensagem mandada durante a queda **não chegou depois do Start** — o Chatwoot NÃO reenvia webhook (medido; era a suposição da §1). Depois do Start o turno seguinte respondeu com memória. Limitação declarada: com o container caído só o Coolify sabe — ligar Notifications lá |
| 6 | **VERDE em 16/09 14:09** — o botão do painel cortou a memória da conversa 51 (`memoria_cortada_em = 14:09:37`) e o turno seguinte, 12 s depois e 28 min após a última mensagem (dentro dos 40 de silêncio), chegou ao modelo com **0** de memória: foi o corte, não o esquecimento. Antes do painel novo o clique dizia "limpa" e ia ao n8n (200, nada limpo); com o segredo errado deu o 401 nomeando a variável — os dois modos de falha previstos, vistos ao vivo |
| 7 | **VERDE em 16/09 14:49–14:54**: URL do bot → cópia do n8n, coluna `n8n`; mensagem respondida pelo n8n (`execucao_id 4131868`, estimativa), zero linhas em `agente_fila`; coluna `codigo`, URL de volta; turno `a733f3ad` respondido pelo código com **6 mensagens de memória, inclusive o par que o n8n escreveu**. Ordem que evita mudo e duplicidade: na ida, URL antes da coluna; na volta, coluna antes da URL |
| 8 | **instrumentado**: cada turno grava a estimativa do `Estima Tokens` como passo `registro:estimativa_n8n` ao lado do real (`agente/src/turno/estimativa.ts`, constantes lidas do nó pelo `teste:estimativa-n8n`); `npm run diff:custo` agrega. Primeiro ponto, à mão, no turno `8aa3265b`: estimado 12.659 × real 10.258 = **+23,4%** (superestima) |

**O 2 não pode ser feito como está escrito, e o motivo é bom.** O replay
"até antes do modelo" precisa dos WEBHOOKS crus (o `mensagens_log` guarda o
texto já sanitizado e fundido pelo debounce), e eles só existem em dois lugares:
nos dados de execução do n8n (API pública, sem chave no `.env.local`; e o n8n
está congelado) e no Chatwoot — cujo token de Agent Bot **não lê mensagens**
(`401 Access to this endpoint is not authorized for bots`, medido em 16/09).
E a etapa que o replay mais mediria, `extrair-e-filtrar.js`, é o **mesmo
arquivo** executado pelos dois lados (`agente/src/entrada/extrair.ts`):
replayar seria comparar um arquivo com ele mesmo. O que de fato diverge
(debounce pela fila em vez do Redis; memória de `mensagens_log`) já tem
modelo executável e `divergencia_esperada` nomeada (`tests/lib/*-modelo.mjs`),
e é medido ao vivo pelo critério 4. Se um dia houver um token de usuário do
Chatwoot para leitura, o replay volta a valer para a etapa `classificar` —
a única portada à mão.

---

## 6. O trace nasce na fatia 1

Perde-se a UI de execuções do n8n no dia em que uma caixa muda de lado. O
substituto entra **antes** dessa caixa mudar, não depois.

Por turno (uma linha em `agente_turnos`, tenant-escopada, RLS, `tenant_id`
primeiro no índice — regras do CLAUDE.md), e os passos em `agente_passos`:

| o que mostra | de onde |
|---|---|
| entrada: evento bruto redigido (sem telefone), `acao`, tenant, conversa, caixa | `entrada/` |
| debounce: lista antes/depois, espera, quantas lidas/removidas | `debounce/` |
| **prompt montado**: system message final (com o prompt do tenant interpolado) e as mensagens da memória que entraram | `agente/loop.ts` |
| **cada chamada ao modelo**: modelo, temperatura, `usage` real, latência | idem |
| **cada tool**: nome, argumentos (JSON), retorno (texto), duração, erro | `tools/*` |
| **portão**: veredito, regra, texto original × substituta | `turno/portao.ts` |
| saída: o que foi ao Chatwoot, id da mensagem lá, `mensagens_log.id` | `chatwoot/enviar.ts` |
| falhas: passo, exceção, se foi `continue` ou estourou | todo `try/catch` |

Quem lê: **eu, pelo banco** (`select` por `turno_id`, sem sessão de navegador
que expira); **o Felipe, pelo painel** — `/admin/turnos` (agência, todos os
tenants) e, no painel do cliente, o turno por trás de cada mensagem em
`/painel/conversas`.

**Retenção, decidida antes da primeira linha** — porque o trace grava prompt
montado e retorno de tool por turno, cresce rápido e contém dado de cliente,
e `mensagens_log` já mostrou o que acontece sem política (11.286 linhas de um
laço, ninguém sabendo o que pode apagar):

| tabela | o que tem | fica | truncado na escrita |
|---|---|---|---|
| `agente_prompts` | o system message montado, **uma linha por hash** (versão do código × prompt do tenant × tools oferecidas) | para sempre — são dezenas de linhas, não milhares; é o que torna experimento atribuível | não |
| `agente_turnos` | ids, caixa, `acao`, `prompt_hash`, modelo, `usage` real, veredito do portão, status, latências, `mensagens_log.id` da saída | **para sempre** — é auditoria de dinheiro quando há pedido, e é leve (uma linha, sem texto longo) | não |
| `agente_passos` | cada chamada ao modelo (mensagens enviadas **por referência** ao hash + memória), cada tool (argumentos e retorno), o **texto bruto do modelo**, cada falha | **30 dias** | retorno de tool a **16 KB**; argumentos a 4 KB; o bruto do modelo **não** é truncado (é a evidência da fabricação) e o prompt não é repetido (vai pelo hash) |

Quem limpa: **o próprio processo do agente**, varredura diária às 04:00
(Brasília), `delete from agente_passos where criado_em < now() - interval
'30 days'` por tenant, com o total removido gravado em `agente_turnos` de um
turno sintético de manutenção — para a limpeza ser visível, não silenciosa.
Sem `pg_cron`, sem infra nova: o agente já é um processo vivo. A anomalia da
53 continua sendo o que contém laço; retenção não substitui isso — um laço de
uma tarde ainda cabe em 30 dias e precisa ser pausado, não apagado.

Dado de cliente: mesmo regime de `mensagens_log` — RLS por tenant, FK com
`on delete cascade` para o tenant, e o texto do cliente já está lá; o trace
não cria categoria nova de dado, cria volume.

**Decisão:** a tabela do trace é a **primeira migração** da fatia 1, junto com
a fila. O `mensagens_log` continua sendo escrito igual — é o que o painel de
consumo lê hoje e o que o replay da §5 usa.

---

## 7. Os dois sistemas convivendo — quem mantém

Durante a transição o banco tem três consumidores: painel, n8n (`emporio`, e
`ceejaar` se for cliente), agente novo (`sendbox`, depois os outros).

| regra | decisão |
|---|---|
| defeito de **banco** (função `api_n8n_*`, migração) | corrigido **uma vez**, no banco, e vale para os dois — é a vantagem de o contrato não mudar. Toda migração do período mantém a assinatura que o n8n chama (a regra do `drop function` + aridade continua) |
| defeito de **fluxo** encontrado no n8n | corrigido **nos dois**, no mesmo commit: o JS do repo (que o n8n injeta) e o módulo do código. Se o conserto exigir import no n8n, o import é feito — a fila "não importado" **não cresce** durante a transição |
| defeito de fluxo encontrado no código novo | corrigido no código; no n8n **só se afetar tenant que ainda está lá** |
| feature nova | **só no código**. O n8n congela no dia em que a fusão for importada — nada novo entra nele. A tool de pagamento e o webhook do Asaas nascem no código |
| quem decide | o Felipe decide o que é "defeito" × "feature"; eu proponho o lado no commit |
| prazo | **60 dias** a partir do `sendbox` roteado. No dia 60, ou o `emporio` mudou de lado pelos oito critérios da §5, ou a migração é declarada **parada** e o n8n volta a receber feature. Transição sem prazo é dois sistemas para sempre |

**Respondido (14/09): não existe prazo real, mas quanto antes melhor.**
Decisão: os 60 dias deixam de ser regra e viram **ponto de revisão** — no dia
60 a partir do `sendbox` roteado, olha-se a lista da §5 e decide-se
continuar ou parar. Sem prazo nenhum "quanto antes" não tem como ser medido;
com um ponto de revisão, tem.

---

## 8. Ordem da migração — e o que não está provado

O mecanismo é o roteamento por caixa da 54: o webhook de **uma inbox** do
Chatwoot aponta para o agente novo, as outras seguem no n8n. É exatamente o
passo 0 — **e o passo 0 não está provado**: o workflow está importado, inativo,
sem webhook apontado, e `mensagens_log` não tem linha do `sendbox` desde
10/09. Nunca roteou uma mensagem. O desenho não assume o que não rodou.

| passo | o que prova |
|---|---|
| **0. provar o roteamento com o passo 0, ainda no n8n** | ativar o `Pagamento Sandbox — Passo 0`, apontar a caixa 282 para ele, mandar uma mensagem no `sendbox` e uma no `emporio`, `npm run n8n:roteamento-sandbox` verde. Custa 10 minutos e é a única prova de que "uma caixa de cada lado" funciona no Chatwoot |
| 1. fatia 1 do código: fila, trace, `entrada/`, `tenant/`, `pausa/`, `chatwoot/enviar` | responde uma mensagem do `sendbox` **com texto fixo**, sem modelo, com trace completo |
| 2. `debounce/`, `midia/`, `perfil/` | os testes da §4 verdes; replay da §5.2 igual ao n8n |
| 3. `agente/` + as 6 tools | as 10 conversas (§5.3) |
| 4. `sendbox` roteado por 7 dias (§5.4) | |
| 5. **próximo tenant**: o que tiver **menos** tráfego real, com aviso ao dono | não é o `emporio` |
| 6. `emporio` pelos oito critérios | |
| 7. n8n: desativar o principal, exportar tudo uma última vez **com os segredos já rotacionados**, arquivar | |

Nada disto começa pelo `emporio` — é o único tenant com cliente real
**conhecido**.

**Respondido (14/09): o `ceejaar` é cliente real, do mesmo dono do
`emporio`, que sabe que é período de teste.** Decisão: o `ceejaar` entra no
replay da §5.2 (é o maior volume) e é o passo 5 — migra **antes** do
`emporio`, com aviso ao dono, porque é o único tenant real cujo dono já
aceitou o risco. O `emporio` continua sendo o último.

### O passo 0, medido em 14/09 — e o que ele revelou

Ao ativar o `Pagamento Sandbox — Passo 0` (feito; `active:true` relido) e
olhar como a caixa 282 está apontada, apareceu o que ninguém tinha registrado:

- cada conta tem **bot próprio** no Chatwoot (Hércules/57, Ana Maria/59,
  CLARA/60), cada um com a sua `outgoing_url` — então apontar um não toca nos
  outros. É isso que faz "uma caixa de cada lado" funcionar;
- o Hércules aponta para `/webhook/Hercules-teste`, que é uma **cópia ativa
  do principal fora da pasta** (`eIRQNUl6xO7TarBv`, criada em 10/09 20:29,
  idêntica ao principal exceto o path). O `sendbox` está sendo atendido por
  ela desde então — a execução `4121049` (19:16 de 14/09) é dela; o principal
  `1fqJokfU8M2pXhzo` só tem execuções do `emporio`/`ceejaar`; o passo 0 tem
  **zero**, porque ninguém o apontou;
- `npm run n8n:roteamento-sandbox 6000` verde depois de consertar um falso
  positivo do próprio checker (agrupava por conteúdo; cinco "oi" com minutos
  de distância viravam "duplicidade"). Duplicidade agora é mesmo conteúdo em
  execuções diferentes **dentro de 10 s** — sabotado com janela de 10 dias,
  acusa; restaurado, verde.

**Então o mecanismo está provado** — por uma cópia que ninguém versionou, não
pelo passo 0. E a cópia é um problema com prazo: **o experimento da fusão roda
no `sendbox`, e o `sendbox` não está no principal.** Importar a fusão em
`1fqJokfU8M2pXhzo` e rodar as 10 conversas no sandbox mediria a versão velha.

**Respondido (14/09): a cópia foi o Felipe**, em 10/09, para testar sem tocar
no principal. Ninguém mais mexe na instância; a §7 fica como está.

**Decisão REVISTA (14/09, pelo Felipe): a cópia FICA, e é a pista do
experimento.** A primeira versão desta seção mandava devolver o `sendbox` ao
principal — resolvia medir a versão certa e criava problema maior: com o
`sendbox` no principal, importar a fusão lá dentro poria `emporio` **e**
`ceejaar` na versão fundida ao mesmo tempo, os dois com tráfego real. A cópia
é o isolamento que já existe:

1. importar a **tool fundida** por cima de `5rMg40Lagy3OaIo7`. É
   retrocompatível: tem as 5 ações, o principal antigo chama 3, e `Fechar
   Pedido`/`Cancelar Pedido` continuam como sub-workflows separados;
2. importar o **principal fundido só na cópia** (`eIRQNUl6xO7TarBv`);
3. `emporio` e `ceejaar` seguem no principal antigo, intocados. Sem reapontar
   webhook, sem janela de risco.

**As duas confirmações que o import exige, medidas:**

- **o path.** O gerador **não seta** o path do webhook — é campo órfão do
  `agente-principal.json` (a família de `PENDENCIA-GERADOR-CAMPO-ORFAO`).
  Importar o JSON do repo por cima da cópia trocaria o path para
  `/agente-lavanderia-chatwoot-teste-teste`, e o n8n **recusa ativar** dois
  workflows no mesmo path: a cópia ficaria inativa e o `sendbox` mudo, sem
  ninguém ver. **Decisão: o JSON já vem com o path** — uma variante
  `agente-principal.sandbox.json`, **derivada** do principal por script
  (`scripts/derivar-principal-sandbox.mjs`), diferindo só em `Webhook.path`
  (`Hercules-teste`) e no `name` (sufixo ` — SANDBOX (copia)`, para o
  `n8n:diff` parar de confundir as duas). Um teste afirma que a variante
  difere do principal **exatamente** nesses dois campos e em nada mais; se o
  principal mudar, a variante é regerada, não editada. Depois do import:
  Save, **recarregar**, e `GET /rest/workflows/eIRQNUl6xO7TarBv` com
  `active:true` e `path:Hercules-teste` — e uma mensagem no `sendbox` com a
  execução na cópia;
- **as credenciais.** A comparação de 14/09 normalizou os nós **com**
  `credentials` e achou só duas diferenças (path e `Portao Transferiu?`):
  Postgres `Agent ia Supabase`, Redis, OpenAI e WAHA são os mesmos do
  principal — a cópia foi duplicada pela UI. O JSON do repo traz id **e nome**
  das credenciais, e o import por cima preserva a resolução pelo id; ainda
  assim, antes do Save, os quatro nós com credencial são conferidos na tela
  — o `Consulta Pausa` ficou dez dias quebrado por uma credencial vazia.

O passo 0 fica ativo e sem caixa. Para a migração, a pista do sandbox já é a
cópia: no dia em que o serviço novo responder, o Hércules aponta para ele.

---

## 9. O que já está decidido e o desenho não reabre

**Revisto em 15/09 pelo Felipe: o n8n congela.** Nada mais entra nele — nem a
fusão, nem a tool de pagamento, nem rotação de segredo dentro dos workflows.
"A funcionalidade dos dois vai ser diferente; foco na migração o mais rápido
possível e depois ajustamos." Consequências:

- o experimento da fusão **não roda no n8n**; a pergunta da sobrecarga fica
  para o código, com a versão do prompt no trace (hash) e conversas sintéticas;
- os dois segredos (`x-foto-secret`, `x-limpeza-secret`) nascem como env do
  serviço; os valores antigos continuam nos workflows até o n8n ser desligado
  — a exposição por export acaba com o n8n, não antes;
- o encerramento do link (desativar + remover cobrança pendente) continua
  sendo pré-requisito de contratar `pagamento`, e nasce no código;
- o `sendbox` é a caixa do serviço novo; a cópia `/Hercules-teste` fica onde
  está até a caixa ser apontada.

---

## 10. Custo, sem maquiar

- **Semanas de trabalho focado**, não dias: 64 nós + 8 sub-workflows + fila +
  trace + telas do trace; na minha conta 2–3 mil linhas de TypeScript e os
  sete testes da §4 antes da primeira linha de módulo.
- **O risco está concentrado em comportamento sutil**, não em volume: o loop
  do LangChain (§3) tem defaults que ninguém mediu; a corrida do debounce
  levou três execuções para aparecer no n8n e vai reaparecer aqui se o teste
  não existir antes.
- **Um período com dois sistemas vivos** — 60 dias, com regra de manutenção
  (§7) e um consumidor a mais no banco em toda migração.
- **Operação nova**: o agente passa a ser processo nosso, com healthcheck,
  alarme e deploy separado. Hoje isso é do n8n; depois é de quem cuida do
  Coolify.
- O que **não** custa: o banco. As 28 funções, as policies, os testes de
  isolamento e o `mensagens_log` ficam como estão.

## 11. As perguntas, juntas

1. ~~Onde o painel roda?~~ Coolify; dois projetos (§1).
2. ~~Rateio por componente?~~ Continua importando (§3).
3. ~~60 dias?~~ Sem prazo real; 60 dias vira ponto de revisão (§7).
4. ~~O `ceejaar` é cliente real?~~ É, do dono do `emporio`, ciente do teste; migra antes do `emporio` (§8).
5. ~~O passo 0 pode ser ativado agora?~~ Ativado. O roteamento está provado
   pela cópia (§8), que foi o Felipe — e a cópia **fica**: é nela que a fusão
   entra. Nada é reapontado.
