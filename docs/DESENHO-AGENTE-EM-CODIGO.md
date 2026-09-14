# Desenho — o agente em código

**Só desenho.** Nenhum código de runtime, nenhum serviço, nenhuma migração.
Escrito em 14/09/2026 a partir do `agente-principal.json` do repo (64 nós, 6
tools — a fusão), dos 8 sub-workflows e da conferência da instância do mesmo
dia. Cada seção termina com uma **decisão** ou uma **pergunta para o Felipe**.

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
| Redis | continua — memória da conversa e acúmulo do debounce, **nas mesmas chaves** (§3) |
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

**Pergunta para o Felipe:** o painel hoje roda em Coolify (há `Dockerfile`),
mas o `CLAUDE.md` diz Vercel. Onde está de fato, e o Coolify tem CPU/RAM para
um segundo container com Node + cliente Redis?

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
| Acumula Mensagem (RPUSH), Lista Antes (GET), **Wait Debounce**, Lista Depois (GET), Ultima Mensagem? (`antes == depois` **e** `depois.length > 0`), Acumulo Sumiu?, Acumulo Sumiu (corrida) (**stopAndError**), Separa Lidos, Remove Lidos do Acumulo (LPOP ×N), Volta a Um Item | `debounce/janela.ts` | a corrida custou três execuções para aparecer (README). O `Wait` é **durável** no n8n; o `Limit` impede N respostas |

### `perfil/` e `agente/`

| nó | módulo | nota |
|---|---|---|
| Tools Ativas (`api_n8n_tools_ativas`), Vende?, Perfil Nao Resolvido (**stopAndError**) | `perfil/resolver.ts` | básico × vendas |
| **OpenAI Chat Model** | `agente/modelo.ts` | modelo e temperatura por tenant (`Resolve Tenant`) |
| **Redis Chat Memory** (`tenant_<t>_memory_<conv>`, TTL 2400, janela 20) | `agente/memoria.ts` | formato do LangChain — §3 |
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
| memória do LangChain no Redis | Redis Chat Memory | **mesmo formato e mesma chave** (`tenant_<t>_memory_<conv>`, lista de `{type:'human'\|'ai', data:{content}}`, TTL 2400, janela 20). Motivo: o `Limpar Memoria` do painel apaga por padrão de chave, e uma conversa que troca de lado no meio (não planejado, mas possível) não pode perder o contexto. Vira teste: escrever pelo código, ler o que o LangChain leria |
| loop do AI Agent | AI Agent Basico/Vendas | escrever o que hoje é default do nó: **máximo de 10 iterações** (default do LangChain), tool + texto na mesma resposta → executa a tool e ignora o texto, resultado de tool volta como string. Cada decisão dessas muda comportamento e **nenhuma está medida** — é o maior risco de paridade |
| `$fromAI` | 6 tools | JSON Schema por tool, `additionalProperties: false`; `tenant_id`/`conversation_id` **nunca** no schema (regra do README, mantida) |
| tool não contratada | sub-workflow recusa com `tool_ativa=false` | o código **nem oferece** a tool ao modelo (lista vem de `api_n8n_tools_ativas`) — **e** a função de banco continua conferindo por dentro. Duas camadas, como hoje. Muda o que o modelo vê; por isso é **depois** do experimento da fusão |
| `$execution.id` em `mensagens_log` | Registra Mensagem | vira `turno_id` (uuid) — coluna já é `text` |
| `Estima Tokens` / `componentes_json` | pós-turno | tokens **reais** por chamada (`usage.prompt_tokens`/`completion_tokens`, somados). `componentes_json` continua sendo gravado com o rateio **estimado** (system, memória, tools, mensagem) porque é o que separa "quem usa mais ferramenta" — e ganha um campo `real_total` ao lado |

**Pergunta para o Felipe:** com o total real da OpenAI, o rateio por
componente continua importando para a cobrança por consumo, ou o número certo
basta? Muda o que `/admin/consumo` mostra.

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
| memória: formato do LangChain | nenhum | escrever pelo código, ler com o cliente do LangChain (ou fixture do formato real lido do Redis de produção) |
| busca KB: consolidação e o piso de similaridade | `teste:recall` (custa OpenAI) | `busca-kb-consolida.js` com fixtures — hoje sem teste |

**Decisão:** os seis sem teste (debounce, corrida, transcrição, mensagem
pronta, foto-resposta, memória, consolida KB) são **pré-requisito da fatia 1**,
escritos contra o JS atual. Nenhum módulo é migrado antes de o teste do
comportamento atual existir.

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
`/painel/conversas`. Retenção: 30 dias de passos, turnos para sempre (é
auditoria de dinheiro quando há pedido).

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

**Pergunta para o Felipe:** 60 dias é o número certo? É o tempo de uma
migração por tenant a cada ~2 semanas com folga; menos que isso pula o
critério 4 (7 dias de `sendbox`).

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

**Pergunta para o Felipe, e ela muda o passo 5:** o `ceejaar` (conta 60, caixa
281) tem **262 mensagens nos últimos 7 dias** — mais que o `emporio` (64). É
cliente real? Se for, "o `emporio` é o único com cliente real" está errado, o
`ceejaar` é o último a migrar junto com ele, e o critério 5.2 (replay) o inclui.

---

## 9. O que já está decidido e o desenho não reabre

- o experimento da fusão roda **antes e no n8n** — importar e rodar as 10
  conversas. Medir no sistema novo não responde a pergunta sobre o atual;
- a rotação do `x-foto-secret` e do `x-limpeza-secret` **não espera** a
  migração: os dois vazam a cada export enquanto o n8n existir;
- o encerramento do link (desativar + remover cobrança pendente) continua
  sendo pré-requisito de contratar `pagamento` para qualquer tenant — no n8n
  ou no código, quem chegar primeiro.

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

1. Onde o painel roda hoje (Coolify × Vercel) e há espaço para o segundo container?
2. Rateio por componente continua importando com o total real da OpenAI?
3. 60 dias de transição é o prazo certo?
4. O `ceejaar` é cliente real?
5. O passo 0 pode ser ativado agora, para provar o roteamento antes de qualquer código?
