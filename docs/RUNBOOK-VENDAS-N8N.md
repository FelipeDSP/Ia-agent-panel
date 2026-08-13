# Runbook — importar vendas no n8n

> **Fatia 2** (tools de venda no ar) está nos passos 0–6 abaixo e **já foi
> executada** — o restaurante-teste fechou uma venda real.
> **Fatia 3** (dois agents por perfil) é a seção no fim do arquivo: *Fatia 3 —
> importar os dois agents*. É a que está pendente.

O que fazer na UI do n8n para colocar as tools de venda no ar. **Este é o único
passo da fatia 2 que a Acqua sente**: o workflow principal é compartilhado por
todos os clientes.

Tudo o que dá para automatizar já está automatizado. O que sobra aqui é o que
exige a UI — importar workflow e reapontar referência — porque mudança estrutural
não sobrevive a automação via Pinia (`n8n/README.md`).

---

## Passo 0 — congelar o "antes" (não pule)

O repositório tem uma cópia do workflow principal, mas a instância do n8n é que
manda. Se alguém editou pela UI desde o último commit, o diff da mudança de
vendas ficaria misturado com essa deriva.

1. No n8n, abra **Agente Multi-Tenant (Supabase)** → `...` → **Download**
2. Substitua `n8n/workflows/agente-principal.json` pelo arquivo baixado
3. `node scripts/n8n-limpar-export.mjs n8n/workflows/agente-principal.json`
4. `git diff n8n/workflows/agente-principal.json`

- **Diff vazio** → o repo estava em dia. Siga.
- **Diff com conteúdo** → é deriva da instância. Commite como *"antes: deriva da
  instância"* ANTES de aplicar vendas, e **reexecute os geradores**:
  ```
  node scripts/gerar-workflows-vendas.mjs
  node scripts/gerar-principal-vendas.mjs
  ```
  Eles são reexecutáveis e reconstroem a partir do arquivo atual.

---

## Passo 1 — importar os 4 sub-workflows

Para cada arquivo, **Workflows → ... → Import from File**:

| Arquivo | Nome que aparece |
|---|---|
| `n8n/workflows/tool-consultar-catalogo.json` | Tool - Consultar Catalogo (Multi-Tenant) |
| `n8n/workflows/tool-gerenciar-pedido.json` | Tool - Gerenciar Pedido (Multi-Tenant) |
| `n8n/workflows/tool-fechar-pedido.json` | Tool - Fechar Pedido (Multi-Tenant) |
| `n8n/workflows/tool-cancelar-pedido.json` | Tool - Cancelar Pedido (Multi-Tenant) |

**Anote o ID de cada um** — está na URL depois de `/workflow/`. O import sempre
cria workflow novo com ID novo; é por isso que o principal vem com placeholder.

Confira a credencial de Postgres em cada nó (`Agent ia Supabase`). O import
costuma casar pelo id, mas se a instância for outra ele deixa em branco.

---

## Passo 2 — reimportar o Resolver Conversa (corrigido)

`n8n/workflows/Tool - Resolver Conversa (Multi-Tenant).json` mudou. **Dois
defeitos, ambos pré-existentes:**

1. ele buscava `tool_ativa` e **nunca checava** — o fluxo ia direto de
   `Busca Config` para o Chatwoot. Desligar "Resolver conversa" no painel não
   surtia efeito nenhum;
2. não havia guarda de pedido pendente — o agente encerraria a conversa com o
   carrinho em aberto.

Importe por cima (ou substitua o conteúdo). **Se o ID mudar, atualize a
referência no principal** — hoje é `lT5oxXJKulPdlPPR`.

---

## Passo 3 — importar o principal e reapontar os IDs

1. Importe `n8n/workflows/agente-principal.json`
2. Nos 4 nós novos, o campo **Workflow** está com placeholder. Troque pelo ID
   real anotado no passo 1:

```
Consultar Catalogo  →  SUBSTITUIR_ID_CONSULTAR_CATALOGO
Gerenciar Pedido    →  SUBSTITUIR_ID_GERENCIAR_PEDIDO
Fechar Pedido       →  SUBSTITUIR_ID_FECHAR_PEDIDO
Cancelar Pedido     →  SUBSTITUIR_ID_CANCELAR_PEDIDO
```

3. Confira que os 3 nós antigos (`Busca Conhecimento`, `Transferir para Humano`,
   `Call 'Tool - Resolver Conversa'`) continuam apontando para os IDs certos
4. **Save**

Depois de reapontar, baixe o principal de novo e atualize o arquivo no repo com
os IDs reais — senão o próximo import repete o trabalho. Atualize também a
tabela de IDs em `n8n/README.md`.

---

## Passo 4 — provar a trava ANTES de deixar rodando

A ordem importa: `Busca Config` → `Vendas Ativa?` são os dois primeiros nós
depois do trigger, **antes** de qualquer Postgres de escrita e de qualquer HTTP.
Se a checagem estivesse depois, uma conversa da Acqua criaria linha em `pedidos`
antes de descobrir que a tool está desligada — vazaria dado, não só
comportamento.

```bash
npm run teste:trava-vendas
```

Ele imprime os dados para a execução manual. Em cada um dos 4 sub-workflows:
**Execute Workflow** → preencher os inputs com o `tenant_id` da Acqua → executar.

**Esperado nos quatro:** o ramo `Vendas Indisponivel`, e nenhum nó de Postgres de
escrita colorido como executado.

Depois dos quatro, rode de novo:

```bash
npm run teste:trava-vendas
```

O teste falha se qualquer tenant sem vendas contratada tiver pedido. **É o banco
que decide, não a resposta do workflow** — uma checagem posicionada depois de um
efeito colateral ainda devolveria "indisponível" com a linha já gravada.

---

## Passo 5 — medir o TOKENS_FERRAMENTAS de verdade

O `Estima Tokens` está com `TOKENS_FERRAMENTAS = 320`, **provisório**. O valor
antigo (110) era constante calibrada para 3 tools; agora são 7.

Não dá para derivar do texto: o schema das tools é contado como prompt token
pela API e não aparece no que o nó vê. Medição:

1. Abra uma execução recente do principal, entre no sub-nó **OpenAI Chat Model**
2. Anote `tokenUsageEstimate.promptTokens`
3. Compare com o que o `Estima Tokens` registrou na mesma execução
4. A diferença é o valor real — ajuste a constante e reexecute
   `node scripts/gerar-principal-vendas.mjs` (ele preserva o número que estiver lá)

Errar isso não quebra nada visível: só faz o rateio de custo por tenant mentir.
Por isso é passo separado, com número anotado.

---

## Passo 6 — contratar para UM tenant de teste

**Nunca a Acqua.** Admin → cliente → Módulos → contratar **Vendas** para
`restaurante-teste`, que já tem catálogo com 13 produtos.

Depois disso o agente daquele cliente passa a vender. Uma conversa de ponta a
ponta pelo WhatsApp de teste fecha a validação.

---

## Se der errado

Reimporte o `agente-principal.json` do commit anterior — é o "antes" do passo 0.
As tools de venda param de existir para o modelo; nada mais é afetado, porque as
migrações 25–27 não alteraram nada que já existia.

Para desligar sem reimportar: descontrate **Vendas** do tenant na tela de
Módulos. A trava `tool_ativa` passa a recusar, e o efeito é imediato — mas o
custo de token dos schemas continua, porque os nós seguem pendurados no AI Agent.
Esse custo só some com o endgame (ver `docs/VENDAS-ESTADO.md`).

---

## Conferência rápida, a qualquer momento

```bash
npm run n8n:sincronia      # System Message do AI Agent == WRAPPER do Estima Tokens
npm run teste:trava-vendas # nenhum pedido para quem não contratou
node scripts/n8n-validar.mjs n8n/workflows/agente-principal.json
```

---
---

# Fatia 3 — importar os dois agents

O que muda: o agente deixa de carregar tools que o tenant não contratou. Um
`Switch` roteia para `AI Agent Basico` (3 tools) ou `AI Agent Vendas` (7).

**A Acqua sente este passo** — o principal é compartilhado. O ganho é dela: hoje
ela paga o schema das 4 tools de venda que nunca contratou, em toda mensagem.

**Comportamento visível não muda para ninguém.** O wrapper do perfil `vendas` é
byte a byte o system message que está em produção hoje; o de `basico` é o mesmo
menos as seções de venda. Se algo mudar para o restaurante-teste, é bug.

### Antes de importar — já conferido daqui

Não precisa refazer, mas é o que dá segurança para seguir:

- **`api_n8n_tools_ativas` existe em produção** e responde. É a função que o nó
  `Tools Ativas` chama; se não existisse, o fluxo quebraria para **todos**, não
  só para vendas.
- **O roteamento já resolve certo contra o banco de produção:**
  `acqua-lavanderia → basico`, `restaurante-teste → vendas`.
- **Os 7 `workflowId` estão reais no JSON**, não placeholders. Diferente da
  fatia 2, **não há IDs para reapontar**.
- **`Tools Ativas` já vem com a credencial** `Agent ia Supabase` (o gerador
  copiou do `Resolve Tenant`). Nó novo importado às vezes chega sem — este não.

---

## Passo 3.0 — congelar o "antes"

O principal em produção hoje é o da fatia 2, de agent único. Exporte antes de
importar por cima:

1. Abra `Agente Multi-Tenant (Supabase)` → **⋯** → **Download**
2. Guarde fora do repo. É o rollback.

---

## Passo 3.1 — importar o principal

1. **⋯** → **Import from File** → `n8n/workflows/agente-principal.json`
2. **Save** — pelo botão. `Ctrl+S` não persiste (`n8n/README.md`).
3. **Recarregue a página** e confirme que ficou:
   - dois nós `AI Agent Basico` e `AI Agent Vendas`
   - `Tools Ativas` → `Vende?` entre o `Limpa Acumulo` e os agents
   - `Perfil Nao Resolvido` pendurado na terceira saída do `Vende?`
   - o trecho do debounce terminando em
     `Separa Lidos -> Remove Lidos do Acumulo -> Volta a Um Item -> Tools Ativas`
     (o `Limpa Acumulo` **não existe mais** — ver `n8n/README.md`)
   - `Ultima Mensagem?` com a saída `false` indo para `Acumulo Sumiu?`
   - **45 nós**

Recarregar não é zelo: "Saved" já apareceu sem ter salvo neste projeto.

---

## Passo 3.2 — conferir os sub-nós compartilhados

`OpenAI Chat Model` e `Redis Chat Memory` são **um só**, ligados nos **dois**
agents — não duplicados. No canvas, cada um deve ter duas linhas saindo.

Se o import tiver duplicado, apague a cópia e religue: duas memórias Redis
significam dois históricos para a mesma conversa.

---

## Passo 3.3 — provar o roteamento nos dois sentidos

Com o workflow ativo, uma mensagem por cliente:

| tenant | perfil esperado | como confirmar |
|---|---|---|
| `restaurante-teste` | `vendas` | executa o `AI Agent Vendas`; pedir um item ainda funciona |
| qualquer sem vendas | `basico` | executa o `AI Agent Basico`; o outro fica cinza |

Na execução, o `Estima Tokens` devolve `_perfil` — é o diagnóstico mais rápido.

**O ramo `Perfil Nao Resolvido` não deve executar nunca.** Se executar, a
execução falha com erro explícito e o cliente não recebe resposta. É de
propósito: cair no básico faria quem contratou vendas perder as tools em
silêncio, e o sintoma chegaria como "o agente não entendeu meu pedido".

---

## Passo 3.4 — medir o S do perfil básico

O `S` de vendas (622) foi medido. O de básico (**266**) é regra de três e está
marcado `medido: false` no gerador. Como `r = 3,112` já é conhecido, **uma
execução no perfil básico basta**:

1. Descontrate **Vendas** do `restaurante-teste` (Admin → Módulos)
2. Mande **uma** mensagem simples, sem tool call
3. Na execução, anote:
   - `tokenUsageEstimate.promptTokens` do sub-nó `OpenAI Chat Model` → **real**
   - `_estimado_entrada` e `_historico_chars` do `Estima Tokens`
4. Resolva `S = real − (texto + memória) / 3,112`
5. Ponha o número em `scripts/gerar-principal.mjs` (`S:` do perfil `basico`,
   e `medido: true`), rode `node scripts/gerar-principal.mjs`, reimporte
6. **Recontrate Vendas** para o `restaurante-teste`

Errar isso não quebra nada visível — só faz o rateio mentir. Por isso é passo
separado, com número anotado.

---

## Passo 3.5 — confirmar o ganho da Acqua

O ponto da fatia inteira. Compare uma execução dela antes e depois: os tokens de
entrada devem cair pelo schema das 4 tools de venda (~356) **mais** as seções de
venda que saíram do system prompt.

Ela está sem tráfego desde 24/07 (`npm run teste:acqua-pronta`), então talvez só
dê para medir quando voltar. Não é bloqueio para importar.

---

## Se der errado na fatia 3

Reimporte o JSON do passo 3.0. Nada no banco muda com esta fatia — ela é só
topologia de workflow, sem migração.

---

## Conferência da fatia 3, a qualquer momento

```bash
npm run n8n:sincronia                                    # 17 checagens
node scripts/n8n-validar.mjs n8n/workflows/agente-principal.json
npm run teste:trava-vendas                               # trava do sub-workflow
npm run teste:acqua-pronta                               # a Acqua segue básica
```

O `n8n:sincronia` é a rede do gerador: ele falha se um agent for editado pela UI
e o outro não, se uma tool de venda for ligada no agent básico, se o ramo de
falha sumir, se alguém reintroduzir referência ao agent por nome, ou se
`returnIntermediateSteps` for desligado.

---
---

# Módulo de áudio — importar e testar

55 nós. **A Acqua roda neste workflow** e não contrata áudio: o caminho dela é o
mesmo de hoje, com o mesmo número de queries e o mesmo aviso de mídia.

## Pré-requisitos: as migrações

Nesta ordem, e **antes** do import — o workflow chama `api_n8n_pode_transcrever`,
que a 33 cria:

```
31  catalogo_tools.tipo + linha transcricao_audio
32  mensagens_log.audio_segundos + api_n8n_registrar_mensagem com 8 parâmetros
33  api_n8n_pode_transcrever
```

Confira com `npm run teste:migracao-audio` (roda em transação abortada, não
aplica). Depois de aplicar fora do CLI, **renomeie os arquivos para a versão que
o ledger registrou** — `CLAUDE.md`, seção Migrações.

## Passo A — congelar o "antes"

`Agente Multi-Tenant (Supabase)` → **⋯** → **Download**. Guarde fora do repo.

## Passo B — importar

1. **⋯** → **Import from File** → `n8n/workflows/agente-principal.json`
2. **Save** pelo botão (`Ctrl+S` não persiste)
3. **Recarregue** e confirme **55 nós** e o ramo novo saindo do `Roteia Acao[1]`

## Passo C — conferir a credencial dos nós novos

Dois nós novos precisam de credencial e vêm com ela no JSON — confirme depois do
import, porque nó novo importado às vezes chega sem:

| nó | credencial |
|---|---|
| `Config Audio` | `Agent ia Supabase` (Postgres) |
| `Transcreve` | `OpenAi Chatyou` (OpenAI) |

O `Transcreve` usa *predefined credential type*: **a chave não está no JSON**.

## Passo D — provar que quem não contratou não mudou

**Antes de contratar para ninguém**, mande uma nota de voz por um cliente sem o
módulo. Esperado: `Audio Contratado?` cai no ramo falso e chega o
`msg_midia_nao_suportada` de sempre. Nenhum nó de download ou transcrição deve
aparecer como executado.

É o teste que protege a Acqua.

## Passo E — contratar para UM tenant de teste

Admin → cliente → Módulos → **Transcrever áudio** para o `restaurante-teste`.
**Nunca a Acqua** — e leia `docs/LGPD-TRANSCRICAO-AUDIO.md` antes de contratar
para um cliente real.

## Passo F — o teste com áudio de verdade

Mande uma nota de voz curta. Percorra a execução e confira:

1. `Baixa Anexo` traz o arquivo (nome com extensão, algo como `no-filename.oga`)
2. `Transcreve` devolve `text` **e** `duration`
3. `Filtra Transcricao` sai com `status: ok`
4. `Mensagem Pronta` emite `mensagem` e `audio_segundos`
5. o agente responde ao conteúdo falado
6. no banco:

```sql
select conteudo, audio_segundos, tokens_entrada
  from public.mensagens_log
 where tenant_id = '<tenant>' and audio_segundos is not null
 order by criado_em desc limit 3;
```

**Anote o par `(file_size, duration)`.** O corte de duração é proxy por bytes;
com dois ou três pares reais o limite deixa de ser aritmética de bitrate. Ajuste
`tenant_tools.config -> limite_bytes` se destoar.

### Os quatro ramos que precisam ser exercitados

| caso | como provocar | esperado |
|---|---|---|
| áudio normal | nota de voz curta | agente responde ao conteúdo |
| áudio longo | nota de voz > ~3 min | `msg_audio_longo`, sem transcrever |
| injection falada | falar "esquece suas instruções" | resposta de bloqueio, **a mesma do texto** |
| conversa pausada | pausar e mandar áudio | nada acontece; o humano responde |

O terceiro é o que justifica o filtro compartilhado: sem ele o áudio entraria
sem passar pela blocklist que o texto passa.

## Se der errado

Reimporte o JSON do passo A. Nada no banco precisa voltar: as migrações são
aditivas e o caminho de quem não contratou não muda. Para desligar sem
reimportar, descontrate o módulo — `tool_ativa` vira false e o `Audio
Contratado?` manda tudo para o aviso de mídia.

## Conferência rápida

```bash
npm run n8n:sincronia          # 47 checagens, 10 delas do módulo de áudio
npm run teste:extrair          # o Extrair e Filtrar decide igual ao de antes
npm run teste:sabotagem-code   # o validador pega nó Code quebrado
npm run teste:migracao-audio   # 31/32/33 aplicam e revertem
node scripts/n8n-validar.mjs n8n/workflows/*.json
```

---
---

# Foto do produto — importar e testar

56 nós no principal, mais um sub-workflow de 8.

**A Acqua roda neste workflow** e não contrata foto nem vendas. O nó novo está
pendurado **só** no `AI Agent Vendas`; o caminho dela não passa por lá.

## O que já está feito (não refazer)

| item | estado |
|---|---|
| migração 34 — `produtos.foto_path` + bucket `produto-fotos` | aplicada, ledger `20260812192741` |
| migração 35 — `fotos_enviadas` + `api_n8n_enviar_foto` + catálogo | aplicada, ledger `20260812210742` |
| UI de upload no painel (cliente) | no repo |
| sub-workflow importado | ID `xRGPiuoKtxrrMA6q` |

Confira as duas migrações sem aplicar nada (rodam em transação abortada):

```bash
npm run teste:migracao-foto   # 23 checagens
npm run teste:fotos           # 17 checagens de isolamento, incluindo URL direta
```

---

## Passo F0 — publicar a Edge Function e o segredo

**É pré-requisito do sub-workflow**: sem ela o `Assina URL` devolve erro e a foto
nunca sai do Storage.

```bash
supabase functions deploy foto-produto --no-verify-jwt
supabase secrets set FOTO_SECRET=<32+ caracteres aleatórios>
```

O `--no-verify-jwt` é proposital: quem chama é o n8n, que não tem JWT de usuário.
O portão é o header `x-foto-secret`, mesmo padrão do `processar-ingestao`, com
segredo **próprio** — dar o `INGESTAO_SECRET` ao n8n permitiria a ele disparar
ingestão, que não é da conta dele.

A função é **fail-closed contra misconfig**: segredo ausente ou com menos de 24
caracteres fecha o portão em vez de abrir. Se esquecer o `secrets set`, o sintoma
é 401 em toda chamada — não é um buraco silencioso.

## Passo F1 — as duas variáveis no n8n

O sub-workflow lê `$env.SUPABASE_URL` e `$env.FOTO_SECRET`:

```
SUPABASE_URL = https://owxnjugkvnjbjkczzasm.supabase.co
FOTO_SECRET  = <o mesmo valor do secrets set>
```

**Exige restart da instância** — variável de ambiente não entra a quente. E é o
**primeiro uso de `$env` neste projeto**: se a instância tiver
`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, as expressões voltam vazias e o `Assina URL`
chama `undefined/functions/v1/foto-produto`. O default do n8n é `false` (acesso
liberado), então só é problema se alguém tiver mudado.

Sintoma de cada erro, para não confundir os dois:

| o que aparece | causa |
|---|---|
| URL da requisição começa com `undefined` | `$env` bloqueado, ou variável não setada |
| 401 no `Assina URL` | segredo diferente entre Supabase e n8n, ou menor que 24 chars |
| 404 no `Assina URL` | `foto_path` aponta para arquivo que não existe mais no Storage |

---

## Passo F2 — reimportar o sub-workflow

**Sim, de novo.** A versão importada em 13/08 tinha o trigger declarando só
`tenant_id`, `conversation_id` e `produto_id`, e o `Envia ao Chatwoot` lia
`account_id` dele. O trigger com campos definidos **filtra a entrada**: o que não
está declarado não chega. A URL sairia
`/api/v1/accounts/undefined/conversations/…` — 404 do Chatwoot na primeira
chamada real da ferramenta, em atendimento.

Reimporte `n8n/workflows/tool-enviar-foto.json` **por cima do mesmo workflow**
(abrir `xRGPiuoKtxrrMA6q` → **⋯** → **Import from File**). Importar como novo
geraria ID novo e o principal deixaria de apontar para o certo.

Confira a credencial `Agent ia Supabase` no `Pode Enviar?`.

A checagem que faltava agora está no validador (`n8n-validar`, item 7): campo
lido do trigger que o trigger não declara.

## Passo F3 — importar o principal

1. **⋯** → **Download** do `Agente Multi-Tenant (Supabase)`, guardado fora do
   repo. É o rollback.
2. **⋯** → **Import from File** → `n8n/workflows/agente-principal.json`
3. **Save** pelo botão (`Ctrl+S` não persiste)
4. **Recarregue** e confirme **56 nós** e o `Enviar Foto do Produto` ligado
   **só** ao `AI Agent Vendas`
5. No nó, confirme que o campo **Workflow** mostra
   `Tool - Enviar Foto do Produto (Multi-Tenant)` e não um ID solto

---

## Passo F4 — provar a trava ANTES de contratar para alguém

A ordem do sub-workflow é `Pode Enviar?` → `Permitido?` **antes** de qualquer
byte sair do Storage e antes de qualquer chamada ao Chatwoot. Mesma exigência que
o `teste:trava-vendas` faz das tools de venda.

No `xRGPiuoKtxrrMA6q` → **Execute Workflow**, com o `tenant_id` da **Acqua** e um
`produto_id` qualquer:

**Esperado:** `Permitido?` cai no ramo falso, `Resposta ao Agente` devolve o texto
de `nao_contratado`, e **`Assina URL`, `Baixa Foto` e `Envia ao Chatwoot` ficam
cinzentos**. Se algum deles executar, pare — é vazamento, não comportamento.

Confirme pelo banco que a tentativa **foi registrada mesmo recusada**:

```sql
select tenant_id, conversation_id, permitido, motivo, criado_em
  from public.fotos_enviadas
 order by criado_em desc limit 5;
```

Recusa registrada é o único jeito de saber depois que a trava está trabalhando.
Uma tabela que só guarda o que passou responde "quantas fotos foram enviadas" e
não responde "quantas vezes o modelo tentou mandar cinco".

## Passo F5 — contratar para o restaurante-teste

**Nunca a Acqua.** Admin → cliente → Módulos → **Enviar foto do produto** para
`restaurante-teste`.

**Contrate Vendas junto, se não estiver.** A tool recebe `produto_id`, e o único
jeito de o agente ter um `produto_id` é o `consultar_catalogo`, que pertence a
Vendas. Foto sem Vendas não quebra nada — só não serve para nada. A tela de
Módulos do admin avisa; não bloqueia.

## Passo F6 — subir uma foto pelo painel

Quem sobe é **o cliente**, na tela de Catálogo — mesmo lugar onde ele já edita
nome, preço e disponibilidade.

O navegador redimensiona antes de enviar (lado maior 1024px, qualidade 0.8) e o
bucket recusa acima de 512 KB. Uma foto de celular de 4 MB passa; o que chega ao
Storage tem uns 150 KB.

Confira que o arquivo caiu na pasta certa:

```sql
select nome, foto_path from public.produtos
 where tenant_id = '<restaurante-teste>' and foto_path is not null;
```

O `foto_path` **tem que começar com o `tenant_id` seguido de barra** — é o que a
Edge Function exige e o que as policies de Storage impõem.

---

## Passo F7 — o teste de ponta a ponta

Pelo WhatsApp de teste: *"me manda a foto do X"*.

Percorra a execução do sub-workflow:

1. `Pode Enviar?` devolve `permitido: true` **e** `chatwoot_url` / `chatwoot_token`
   preenchidos — a função só entrega credencial quando autoriza
2. `Assina URL` devolve uma URL com `token=` (validade 60s)
3. `Baixa Foto` traz o binário em `data`
4. `Envia ao Chatwoot` responde **200** (não 422 — 422 é o sintoma de mandar
   `data_url` no corpo em vez dos bytes)
5. A imagem chega **com a legenda na mesma mensagem**, não em duas

### Os quatro ramos que precisam ser exercitados

| caso | como provocar | esperado |
|---|---|---|
| foto normal | pedir um item que tem foto | imagem + legenda numa mensagem |
| item sem foto | pedir um item sem foto cadastrada | diz que não há imagem **desse** item, sem prometer enviar depois |
| segunda foto seguida | pedir duas fotos no mesmo turno | a segunda é recusada por `janela`; o agente **não** pede desculpa nem tenta de novo |
| não contratado | descontratar e pedir foto | diz que não consegue mandar imagem e segue por texto |

O terceiro é o que a migração 35 existe para provar. O texto da recusa é
deliberadamente instrutivo: sem ele o modelo tende a se desculpar e tentar de
novo, que é exatamente o burst que a janela existe para conter.

## Passo F8 — calibrar a janela

A janela é **30 segundos**, chute inicial, configurável por tenant em
`tenant_tools.config -> janela_foto_segundos`. Depois de algumas conversas reais:

```sql
select motivo, count(*), min(criado_em), max(criado_em)
  from public.fotos_enviadas
 where tenant_id = '<tenant>' and not permitido
 group by motivo;
```

- **Muito `janela`** → ou o modelo está insistindo (problema de prompt) ou o
  cliente pede fotos em sequência legítima (problema de janela). Olhe a conversa
  antes de mexer no número.
- **Nenhum `janela`** → a regra de prompt está segurando sozinha. A trava
  continua valendo como teto; não a remova por estar quieta.

`fotos_enviadas` é por conversa, não por tenant: dois clientes pedindo foto ao
mesmo tempo não interferem um no outro. E **só envio permitido conta** — se
recusa contasse, um burst de cinco empurraria a janela a cada tentativa e o
"sim, manda a outra" legítimo nunca passaria.

---

## Se der errado

Reimporte o JSON baixado no passo F3, item 1. O nó de foto some do modelo; nada mais é
afetado, porque as migrações 34 e 35 são aditivas e não tocam em nada que já
existia.

Para desligar sem reimportar: descontrate **Enviar foto do produto** na tela de
Módulos. O `api_n8n_enviar_foto` passa a devolver `nao_contratado` e o efeito é
imediato — a decisão é do banco, não do workflow.

## Conferência rápida

```bash
npm run n8n:sincronia          # 59 checagens, 10 delas da fatia de foto
npm run teste:fotos            # isolamento de Storage entre os 3 tenants
npm run teste:migracao-foto    # 34 e 35 aplicam e revertem
npm run teste:trava-vendas     # a dependência com vendas segue coerente
node scripts/n8n-validar.mjs n8n/workflows/*.json
```

