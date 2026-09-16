# Revisão do painel depois da migração do agente para código — 16/09/2026

Feita a pedido do Felipe ("agora que é código, como funciona o catálogo de
tools?"). Lida no código e no banco, não navegando tela a tela — o que precisa
de olhar humano está na §4.

## 1. O que a migração deixou MORTO ou enganoso no painel da agência

### 1.1 `/admin/catalogo` — "Criar tool", `workflow_id padrão`, `descrição padrão`

A tela deixa criar uma tool nova com nome, descrição "que ensina a IA quando
usar" e `workflow_id` do sub-workflow no n8n. **Nada disso cria capacidade
nenhuma**:

- uma tool nova é **código** (`agente/src/tools/*.ts` + funções `api_n8n_*` no
  banco + seção do prompt em `agente/src/agente/prompt.ts`). Criar a linha no
  catálogo sem o código produz um módulo que aparece em *Módulos* do cliente,
  pode ser contratado, e não faz nada;
- a "descrição que ensina a IA" **nunca chegou ao modelo** — nem no n8n. Medido
  em 16/09: os nós `toolWorkflow` do `agente-principal.json` têm `description`
  estática, e o código porta essas strings verbatim (`DESCRICAO` em cada
  tool). `catalogo_tools.descricao_padrao` e `tenant_tools.descricao` sempre
  foram texto que só o painel lia;
- `workflow_id_padrao` e `tenant_tools.workflow_id` estão **nulos em todas as
  linhas** (7 do catálogo, 17 de tenant_tools dos três tenants vivos) e o
  código não os lê.

**Proposta:** o catálogo vira **derivado do código** (`REGISTRO_TOOLS` em
`src/lib/tools/registro.ts` já é a fonte que o painel do cliente usa): a
página lista rótulo, resumo, tipo (tool do modelo × capacidade do fluxo),
contratável/desligável, quantos tenants usam — **sem** criar/editar. Um aviso
fixo diz: "tool nova = código; a linha em `catalogo_tools` é criada pela
migração que traz a tool". Um teste afirma `catalogo_tools == chaves do
registry` (fonte↔derivado, para a linha não faltar quando o código ganhar uma
tool — a 61 fez isso à mão para `pagamento`).

O que `catalogo_tools` continua fazendo: `ativo` (a agência tira um módulo de
circulação sem apagar contratação) e `tipo`. As colunas `workflow_id_padrao`
e `descricao_padrao` podem ser dropadas junto com `tenant_tools.workflow_id`
e `.descricao` quando o n8n desligar — hoje só custam confusão, não risco.

### 1.2 `/admin/tenants/[id]` — "Descrição da tool (ensina a IA quando transferir)"

Mesmo caso: o campo grava `tenant_tools.descricao` de `transferir_humano`
("transfira quando pedirem atendimento humano", no emporio), e o modelo nunca
o viu. O que a agência precisa configurar ali é **só a sessão do WAHA**
(`notificacao.sessao`). **Proposta:** tirar o campo (e o `workflow_id`) do
formulário; o dado fica no banco até a coluna cair.

### 1.3 Quem atende cada cliente não aparece em lugar nenhum

`tenants.agente_runtime` (`n8n` | `codigo`) é a coluna que decide tudo na
transição, e hoje só eu a mudo por SQL. A lista de clientes não mostra;
a página do cliente não mostra; o `/admin/agente` mostra "(n8n)" no filtro e
só. **Proposta:**

- coluna **Agente** na lista de clientes (`código` / `n8n`) e o mesmo badge
  no cabeçalho do cliente;
- na página do cliente, um card **"Quem atende"** com o botão de trocar o
  runtime e, ao lado, a URL que o bot da conta precisa ter no Chatwoot para
  aquele runtime (com o token do webhook do serviço vindo do ambiente do
  painel). É o roteiro de `agente/README.md` §"Apontar uma conta" virando
  tela — e é o que a migração do `ceejaar`/`emporio` vai usar.

### 1.4 Menor

- `/admin/consumo`: soma `mensagens_log` sem distinguir fonte, então já é
  real para quem está em código. Falta dizer **quanto** é real: um
  "`n` real / `m` estimado" por cliente. Opcional.
- `/admin/agente` (novo hoje) não tem link a partir da conversa do cliente
  nem da lista de conversas do admin — quem está olhando uma conversa quer
  "ver os turnos dela". Um link `?tenant=…` já resolve o primeiro; o segundo
  pede filtro por conversa (`&conversa=51`), que é uma linha.

## 2. Painel do cliente

Nada ficou morto: o cliente não vê n8n em lugar nenhum (só comentários de
código citam). Duas coisas melhoraram hoje sem ele saber:

- a lista de conversas passa a mostrar **resolvido** de verdade (65) — antes
  tudo era "ativo" para sempre;
- Relatórios → "conversas que o agente resolveu sozinho" passa a ter dado.

O que continua valendo olhar com o cliente: a tela de Configurações (o que
ele pode mexer é o corte cliente/agência da `transferir_humano`, mensagens e
debounce) — é o lugar onde um "esquecer após N minutos" **do cliente** faria
sentido se um dia a agência quiser delegar (hoje é agência-only, 66).

## 3. Ordem sugerida

1. **Quem atende** (1.3) — é operacional e destrava as migrações sem SQL.
2. **Catálogo derivado do código** (1.1) + tirar os campos mortos da
   transferência (1.2) — tira o engano.
3. Links do trace a partir das conversas (1.4).
4. Consumo real × estimado (1.4), se quiser.

## 4. O que só se vê navegando

Não fiz passagem visual. Vale uma sessão de 20 minutos com você clicando e
eu anotando: textos que envelheceram, cards que ninguém abre, o que falta na
primeira tela do admin (hoje é a lista de clientes — uma "saúde de hoje"
com turnos/falhas/mudos por cliente seria a primeira tela natural depois da
migração).
