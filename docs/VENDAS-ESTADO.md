# Vendas — estado e decisões

Documento vivo. Registra o que já foi decidido sobre o agente vender, para não
reabrir discussão a cada retomada.

Última atualização: 14/08/2026.

## Onde isto está agora

**O agente vende.** Catálogo, pedido, fechamento e as tools no workflow estão em
produção, exercitados com cliente de teste. O que falta para virar receita é
**pagamento**, e o gargalo dele é contratual, não técnico.

Entregue e em produção:

| fatia | o que faz |
|---|---|
| **Catálogo** | produtos por tenant, tela no painel, preço como fonte única |
| **Pedido** | rascunho → aguardando_pagamento, itens com snapshot de preço, total no servidor |
| **Tools por perfil** | dois AI Agents (básico / vendas); quem não contratou vendas não carrega o schema das 4 tools |
| **Transcrição de áudio** | nota de voz vira texto antes do agente, com `audio_segundos` cobrado à parte |
| **Foto de produto** | agente envia foto do item pelo Chatwoot, com trava de janela |

Fechado nesta rodada, fora de vendas mas encostado nela: billing idempotente nos
dois caminhos (mensagem e ingestão), expiração de pedido não pago e de job
preso, e o ledger de migrações reconciliado.

**O que falta exercitar:** três ramos da foto nunca rodaram — item sem foto,
módulo não contratado, e **duas fotos no mesmo turno**. O terceiro é o único que
testa código que existe só para ele (a recusa por `janela`). É conversa de dois
minutos no WhatsApp de teste, não é código.

**A decisão mais cara em aberto não é técnica** — e o provedor de pagamento
**não está escolhido**. O contrato BaaS que serve de referência (Asaas, o
primeiro lido inteiro) traz responsabilidade **solidária e irrevogável** pelos
impactos financeiros dos clientes finais — chargeback, estorno, saldo negativo —
e multas de R$ 20 mil a R$ 500 mil por infração. Isso precisa entrar no preço do
módulo de vendas e nos critérios de quem pode contratá-lo, **antes de assinar
com quem quer que seja**. Ver "Pagamento".

## Escopo do lançamento

**Item avulso apenas:** quantidade × preço fixo. Serve restaurante, loja,
lavanderia por peça, oficina.

Fora do escopo por ora:
- **Assinatura / plano por período** — exige cliente persistente (chaveado por
  telefone, não por conversa) e controle de validade
- **Agendamento** — exige disponibilidade, conflito e fuso

Entram quando um cliente pagante travar por isso. O sinal não é "um cliente
perguntou se dá"; é "um cliente não fecha por causa disso".

Para o que não encaixa em nenhuma primitiva, a resposta certa é `transferir_humano`,
não improvisar. O agente cobre o pedido repetitivo; o humano pega a exceção.

## As duas travas inegociáveis

**1. Preço e total nunca vêm do `$fromAI`.**
O agente manda `produto_id` e quantidade; o banco resolve o valor a partir do
catálogo daquele tenant. `fechar_pedido` não recebe valor nenhum — soma os itens
no servidor. Se o LLM puder informar preço, um cliente insistente consegue
desconto: o modelo cede para ser prestativo.

**2. O pedido mora no banco, não na memória.**
`memoryRedisChat` está em `contextWindowLength: 20` (subiu de 5 na fatia 2), mas
a trava não depende disso: toda tool que mexe no pedido devolve **o carrinho
inteiro em texto**, o que reinjeta o estado a cada turno. Se a janela voltasse a
5, o pedido continuaria de pé — é essa independência que é a trava, não o
número.

Mesmo princípio do `tenant_id`, que já vem do webhook e nunca do LLM:
**o LLM decide o quê, o servidor decide quanto.**

## Regra de produto: o catálogo é a fonte única de preço

**Quando um tenant contrata vendas, o preço válido é o do catálogo, e a base de
conhecimento não deve conter tabela de preços.**

Não é preferência de organização. Os dois lugares guardam a mesma informação e
nada os mantém em acordo, então eles divergem — e a divergência é cobrada do
cliente final:

1. o agente responde uma pergunta de preço lendo a base (`busca_conhecimento`);
2. o cliente aceita e pede o item;
3. `adicionar_item` grava o preço do **catálogo**, que é o comportamento correto
   e decidido na fatia 2 — preço nunca vem do parâmetro nem do texto;
4. o cliente viu um número e vai pagar outro.

Nenhuma instrução de prompt conserta isso. É dado inconsistente: o modelo pode
acertar em 9 conversas e errar na décima, e o erro chega como cobrança indevida.

### Consequência para o onboarding do módulo

Contratar vendas passa a incluir um passo: **migrar os preços do documento para
o catálogo e remover a tabela de preços do documento**. Antes disso, o módulo não
está pronto para o cliente, mesmo que tecnicamente funcione.

Fora desse caso a base pode ter preço à vontade — para um tenant que não vende,
uma tabela de preços na base é exatamente o que ela deve ter. O problema só
existe quando há duas fontes.

### Mitigação até o dado ficar consistente

O `Tool - Busca KB Multi-Tenant` acrescenta um aviso ao final dos trechos quando
o tenant tem vendas contratada, dizendo que preço válido é o de
`consultar_catalogo`. Sai da mesma query que já busca os chunks, sem round-trip
novo.

**Isso encurta a janela, não fecha.** É instrução ao modelo, mesma natureza
probabilística das regras do wrapper. Não substitui a migração dos preços.

### Pendência operacional: importação em lote no catálogo

A tela de catálogo cadastra um produto por vez. Serve para dezenas; não serve
para um cardápio de restaurante com 80 itens — o onboarding viraria digitação
manual, e o custo cairia sobre a agência ou sobre o cliente, nos dois casos no
pior momento (a venda acabou de ser fechada).

**Não construir agora.** O gatilho é o primeiro cliente com cardápio grande
contratando vendas. Até lá é especulação sobre um formato de importação que
ninguém pediu.

---

## Modelo de dados

`produtos`, `pedidos`, `pedido_itens`. **Aplicado** — migrações 23 a 28, mais a
38 (expiração). O rascunho `vendas_core.sql` ficou fora do repo e **não é fonte
de nada**: o que sobreviveu dele foi ajustado ao padrão do projeto e o que não
sobreviveu não existe. Um exemplo do segundo caso custou uma investigação:
`api_n8n_expirar_pedidos` estava lá, nunca virou migração, e só o estado
`expirado` chegou à CHECK — um estado que nada escrevia, até a migração 38.
Ao procurar algo "que a gente já escreveu", confira no banco, não no rascunho.

**Migração 40 (17/08) fecha uma ponta solta da 38.** A 38 fez a leitura de pedido
expirar o pedido vencido — ou seja, **ler pedido escreve** — e ela mesma
documentou que isso obriga `volatile` em vez de `stable`. Aplicou em
`pedido_aberto_da_conversa`, `api_n8n_tem_pedido_pendente` e
`api_n8n_adicionar_item`, e passou por `api_n8n_ver_pedido`, que chama a mesma
função. Consequência: o PostgREST executa função `stable` em transação **read
only**, então `ver_pedido` por supabase-js estourava `25006` / HTTP 405. O n8n
nunca sentiu porque chama pelo nó Postgres (conexão direta, não read-only) — o
defeito era latente, e apareceu só porque `tests/isolamento-pedidos.mjs` cobre as
duas superfícies. Se acrescentar função de pedido, a pergunta não é "ela parece
leitura?", é **"ela passa por `pedido_aberto_da_conversa`?"** — se passa, é
`volatile`.

Decisões de modelagem:
- Dinheiro em **integer de centavos**, nunca float
- Preço em **snapshot** no item: reajuste no catálogo não muda pedido antigo
- `variacoes` e `metadados` em **jsonb** — é o que faz servir a verticais
  diferentes sem remodelar
- Índice único de **um pedido aberto por conversa**
- Status: `rascunho` → `aguardando_pagamento` → `pago` / `cancelado` / `expirado`.
  Fora de `rascunho`, não aceita alteração
- `adicionar_item` valida que o `produto_id` pertence àquele tenant

Isolamento entre clientes já é garantido pelo padrão existente: toda função
`api_n8n_*` recebe `p_tenant_id` e filtra por ele, RLS ativa, sem grant direto de
tabela. O agente da lavanderia não enxerga prato de restaurante porque a query
nem chega perto.

### Risco aberto: `descricao` tem dois públicos

A coluna `descricao` de `produtos` serve ao mesmo tempo para o cliente se
organizar e para o agente explicar o item. São usos diferentes: o segundo vai
para o contexto do LLM a cada busca de produto.

**Não foi criada uma `descricao_agente` separada**, de propósito — seria
especulação sobre um problema que ainda não aconteceu, sem saber o formato de
retorno da tool nem o custo real de contexto.

Se na fatia 2 a descrição virar ruído (catálogo com textos longos inflando o
prompt, agente citando detalhe irrelevante), **a tool trunca antes de mandar ao
LLM** — não se cria coluna nova. Só vale separar se truncar provar-se
insuficiente, e aí com evidência de conversa real, não com hipótese.

## Achados do cadastro real (fatia 1)

Levantados em 11/08/2026 cadastrando 16 produtos de verdade na tela — cardápio de
restaurante e serviços de lavanderia, em dois tenants. São observações de uso,
não hipóteses de projeto.

**Resolvido na hora:** faltava a unidade `pessoa` (couvert, rodízio, buffet — o
restaurante cobra por pessoa, não por unidade). Migração 24.

### Regra de negócio na descrição — não criar campo

Cadastrando, a descrição virou depósito de regra: "Prazo de 48h", "Mínimo de 3kg
por pedido", "Servida sábados e quartas", "Não atende couro legítimo".

**Não vira campo estruturado.** Já existe lugar para regra de negócio: a base de
conhecimento, que o agente busca. A linha de produto carrega o que ele precisa
para *vender* — nome, preço, unidade, disponibilidade.

E o risco real não é o que parecia. Não é o agente ler prosa e entender errado;
é ele **não conectar a regra ao produto certo** — saber que existe um mínimo de
3kg e não amarrar isso à lavagem por quilo na hora de fechar o pedido. Isso não
se resolve com coluna nova, se resolve com o desenho da conversa.

A fatia 2 responde com **comportamento observado**: rodar pedido real e ver onde
o agente erra. Só depois disso, se errar, discutir estrutura.

### Variação — DECIDIDO: não entra agora. Proposta pronta, com gatilho

Revisto em 11/08/2026, ao abrir a fatia 2, olhando os 19 produtos reais
cadastrados em vez da hipótese. **A necessidade não se confirmou.**

O que o catálogo real mostrou, item a item:

- "Moqueca para 2", "Picanha 600g", "Chopp 300ml" — **tamanho no nome**, e
  funciona;
- "Terno 2 peças" e "Passadoria avulsa" — **serviços distintos**, não variações
  do mesmo item. O trabalho é outro, o preço é outro, o prazo é outro;
- "Água com ou sem gás", "Caipirinha com vodka" — variação que **não muda
  preço**: resolve em `observacao`, texto que pode vir do LLM sem risco;
- o caso canônico **P/M/G com preços diferentes não apareceu** num cardápio
  completo nem numa lista de serviços de lavanderia.

**Consequência: `pedido_itens` NÃO tem coluna `variacao`.** Pedido é produto ×
quantidade. `observacao` fica, para texto que não afeta preço.

#### O achado estrutural que produziu essa decisão

A especificação original da fatia 2 pedia `pedido_itens.variacao jsonb` **sem**
definir variação no catálogo. Isso é a **trava 1 furada por outra porta**: sem
fonte de verdade no catálogo, o conteúdo daquela coluna viria do LLM em texto
livre — e variação afeta preço. Ou variação existe no catálogo e o servidor
resolve, ou a coluna não deve existir. Meio-termo é o pior dos três.

Escolhida a terceira via: cortar a coluna.

#### Proposta pronta, para quando o gatilho disparar

**Gatilho:** um cliente real com **o mesmo item em três tamanhos e preços
diferentes**. Não "seria bom ter"; um catálogo concreto que não cabe em produtos
separados.

Desenho já discutido e aprovado no papel — retomar daqui, não do zero:

```json
variacoes = {
  "rotulo": "Tamanho",
  "obrigatoria": true,
  "opcoes": [
    { "chave": "p", "nome": "P", "preco_centavos": null },
    { "chave": "g", "nome": "G", "preco_centavos": 5990 }
  ]
}
```

- **Um eixo só.** Dois eixos (tamanho × cor) é grade combinatória, N×M preços e
  custo de token multiplicativo no `buscar_produtos` — é onde vira ERP.
- **Preço opcional por opção**, absoluto e anulável. `null` herda o preço do
  produto: P/M/G sem preço não obriga a digitar três vezes; terno 2 e 3 peças
  preenche cada um. Absoluto e não delta porque é como o cliente pensa o preço
  ("G custa 59,90"), e delta convida a erro de sinal.
- **O agente manda TEXTO, o servidor resolve.** Normaliza (minúscula, sem
  acento, trim) e casa contra as opções daquele produto. Sem correspondência,
  devolve a lista válida como erro recuperável ("Temos P, M e G — qual?"). É a
  trava 1 aplicada à variação: o LLM decide o quê, o servidor decide qual, e
  erro vira turno de conversa em vez de preço errado.
- **A `chave` nunca entra no contexto do LLM.** Existe para o banco, para o
  snapshot no item e para a foto se ligar depois (ver seção de foto).
  `buscar_produtos` devolve só os nomes.
- **`obrigatoria: true`** faz `adicionar_item` sem variação perguntar em vez de
  adicionar — senão entra pizza sem tamanho e o preço fica ambíguo.
- **Descartados:** tabela `produto_variacoes` (compra estoque e SKU por variação
  que ninguém pediu, custa join em todo retorno de tool e uma segunda tela),
  dois eixos, estoque por variação, preço por delta.
- **UI:** uma seção recolhida no formulário que já existe — "☐ Este produto tem
  variações" → rótulo + linhas de (nome, preço opcional). Quem não usa não vê
  nada novo.

A coluna `variacoes jsonb` continua em `produtos` desde a migração 23, vazia e
sem UI. Não atrapalha e evita uma migração quando o gatilho vier.

### Foto de produto — ENTREGUE e em produção

Transporte verificado em 11/08/2026 contra o sandbox real (ChatYou,
`chatwoot_account_id = 1`, inbox "WA - Testes", conversa 1864). Implementada e
no ar desde 13/08: o agente envia a foto do item pelo Chatwoot, com trava de
janela para não disparar várias na mesma conversa.

O que segue abaixo é o registro do que o teste de transporte respondeu — vale
como referência de por que o multipart é obrigatório e por que `data_url` no
corpo não funciona. **Uma foto por produto**, e o motivo está em "Foto por
variação, quando `variacoes` entrar".

**O que ainda não foi exercitado:** item sem foto, módulo não contratado, e duas
fotos no mesmo turno. O terceiro é o único que testa código escrito só para ele
(a recusa por `janela`), e por isso é o que importa.

#### O que o teste respondeu

**1. O token de Agent Bot envia anexo.** Envia mensagem de texto (é o que o
agente já faz hoje) e envia anexo pelo mesmo endpoint. A recusa documentada em
`docs/DIAGNOSTICO-CREDENCIAL-CHATWOOT.md` vale para a API de *plataforma*
(listar conversas), não para o envio — são caminhos diferentes.

**2. URL no corpo NÃO funciona.** `POST .../messages` com
`attachments: [{ file_type: 'image', data_url: '<url assinada>' }]` devolve
**422**:

```
Could not find or build blob: expected attachable, got #<ActionController::Parameters ...>
```

O parâmetro `attachments` do Chatwoot é ActiveStorage: espera o arquivo, não um
link. Não há TTL a calibrar porque não há URL nossa em jogo.

**3. Multipart funciona.** `attachments[]` com os bytes, `content-type`
`multipart/form-data`: **200**, anexo criado com `file_type: "image"`.

**4. No WhatsApp chega como FOTO, com a legenda no mesmo balão.** Confirmado no
aparelho: renderizou como preview inline, não como documento/arquivo, e o
`content` da mensagem veio junto da imagem, num balão só, com timestamp único.

Consequência para a fatia 2: **a tool de foto devolve UMA mensagem com imagem +
legenda.** Não há duas mensagens para ordenar, nem risco de a legenda chegar
antes ou depois da foto — que seria o problema clássico e é o motivo de a
pergunta ter sido feita.

**5. E o achado que decide a arquitetura: o Chatwoot RE-HOSPEDA a imagem.** O
`data_url` que ele devolve aponta para o próprio Chatwoot:

```
https://app.chatyou.chat/rails/active_storage/blobs/redirect/<blob>/picanha.png
```

Confirmado nos logs de Storage do Supabase: durante todo o teste o objeto foi
buscado **duas vezes, ambas pelo nosso próprio script** (user-agent `node`).
Nenhuma requisição do Chatwoot, do WhatsApp ou de qualquer origem externa.

#### O que isso implica

- **O bucket fica privado, sem exceção.** Nenhuma URL nossa chega ao WhatsApp.
- **A pergunta do TTL da URL assinada morreu.** O único consumidor da URL é o
  próprio n8n, dentro da execução do workflow — segundos, não o prazo
  incontrolável de um fetch do WhatsApp. Uma assinatura curta basta.
- **O fluxo é:** n8n baixa do Storage (URL assinada curta) → reenvia ao Chatwoot
  em multipart → o Chatwoot hospeda e entrega ao WhatsApp. Duas transferências
  de bytes por foto enviada, o que importa para produto com várias fotos.
- **Adiado de propósito:** medir o custo das duas transferências com imagem de
  tamanho real. O teste usou 1,7 KB e foto de cardápio tem centenas de KB, mas
  medir agora seria medir a premissa errada — **vamos querer redimensionar no
  upload de qualquer jeito**, então o peso que trafega será o da imagem já
  reduzida, não o do arquivo que o cliente subiu. A medição (limite de tamanho
  do Chatwoot, tempo de round-trip, quantas fotos cabem numa resposta) entra
  quando foto virar prioridade, junto com a decisão de redimensionamento.

#### Storage

Existe um bucket só, `kb-arquivos`: privado, 10MB, e aceita apenas PDF, DOCX e
TXT (migração 14). Foto precisa de bucket novo — o MIME type não bate. O padrão
de path a seguir é o de lá: `{tenant_id}/{uuid}.{ext}`, com RLS de Storage
escopando por tenant.

#### Foto por variação, quando `variacoes` entrar

Hoje é **uma foto por produto**, e foi decisão consciente de não esperar
`variacoes` para entregar o caso comum.

O pedido óbvio seguinte é **foto por variação** — camisa azul e vermelha não
mostram a mesma imagem. Quando `variacoes` entrar (gatilho na seção acima), a
foto será remodelada junto: o custo dessa remodelagem foi aceito de propósito,
em troca de o restaurante ter foto de prato agora.

A saída natural na hora será `fotos jsonb` em `produtos` ou na variação, uma
lista de paths. Não vale desenhar antes — `variacoes` é que decide a forma.

#### Exclusão — decidido: o arquivo fica

Produto tem soft delete para preservar histórico de pedido; apagar a imagem
quebraria a visualização de um pedido antigo. Limpeza vira job quando o volume
justificar, não regra agora.

### Paginação da tela de catálogo — gatilho definido

`/painel/catalogo` carrega o catálogo inteiro num `select` e renderiza tudo. Para
30 produtos é o certo; para 500 a tela trava, e o `idx_produtos_busca` (migração
23) fica sem uso no painel — ele existe só para a fatia 2.

**Gatilho:** o primeiro cliente passar de **~100 produtos**. Antes disso,
paginar custa complexidade sem ganho.

### Visibilidade de produto para o agente (fatia 2)

Regra única, também documentada no `comment` da coluna `disponivel`:

```sql
deletado_em is null and disponivel and (estoque is null or estoque > 0)
```

`disponivel` é separado de `estoque` porque "hoje não tem" não é "acabou o
estoque": forçar `estoque = 0` para pausar um item empurraria o cliente para o
modo de controle de estoque que ele não quis, e a alternativa seria remover o
produto — perdendo o cadastro para repor amanhã.

## Lado n8n — cuidado com a Acqua

O workflow principal é **hardcoded e compartilhado por todos os tenants**: não lê
`api_n8n_tools_ativas`. Plugar uma tool nova no AI Agent a habilita para a Acqua
também, que não contratou vendas e tem catálogo vazio.

Por isso **todo sub-workflow de venda começa checando `tool_ativa`** via
`api_n8n_config_tool(tenant_id, '<tool_nome>')`. Padrão em
`Tool - Transferir para Humano`, nó `Pode Transferir?`.

O "endgame" do `docs/ADICIONAR-TOOL.md` — AI Agent montando tools e system prompt
a partir de `api_n8n_tools_ativas` — vale fazer perto de 3–4 tools. Vendas soma
pelo menos 3, então a decisão chega junto.

## Fatia 3 é o endgame do workflow principal

Registrado em 11/08/2026, ao dimensionar as tools de venda. **Não fazer agora** —
mas saber que a fatia 2 está pagando um preço que a fatia 3 elimina.

### O sintoma

Os schemas das tools vão em **toda requisição de todo tenant**: o workflow
principal é compartilhado e os nós `toolWorkflow` ficam pendurados no `AI Agent`
incondicionalmente. `tool_ativa` bloqueia o **efeito**, não o **custo**. A Acqua,
que não contratou vendas, paga o schema das tools de venda em cada mensagem,
para sempre.

Foi isso que empurrou a consolidação de 6 sub-workflows para 4 na fatia 2.

### Por que a consolidação é contorno, não solução

Consolidar tool para economizar token está resolvendo o sintoma. O problema é
que **o painel não é a fonte da verdade do que o agente carrega** — é o que o
"endgame" de `docs/ADICIONAR-TOOL.md` descreve: migrar o `AI Agent` para montar
tools e system prompt a partir de `api_n8n_tools_ativas`, em vez de nós fixos.

Feito isso, cada tenant carrega só o que contratou, `contratado/ativo` passa a
cortar o agente de verdade, e adicionar tool deixa de exigir mexer no principal.

### O gatilho já foi ultrapassado

`ADICIONAR-TOOL.md` diz que vale fazer perto de **3–4 tools**. Com vendas:

```
busca_conhecimento, transferir_humano, resolver_conversa     3
consultar_catalogo, gerenciar_pedido, fechar_pedido,
cancelar_pedido                                             +4
                                                          -----
                                                             7
```

**Sete, bem acima do gatilho.** A fatia 2 entrega mesmo assim, com nós fixos,
porque o endgame é refatoração do fluxo principal e não cabe junto com a
entrega de vendas — misturar as duas tornaria impossível saber o que quebrou.

### O que a fatia 3 ENTREGOU — e por que não foi o endgame

**Entregue: dois AI Agents, um por perfil**, roteados por Switch (`Vende?`).
Quem não contratou vendas cai no agente básico e não carrega o schema das 4
tools de venda em nenhuma mensagem — que é o custo que `tool_ativa` não cobria,
porque ele bloqueia o EFEITO, não o CUSTO.

**Não foi a montagem dinâmica descrita acima, e o motivo é do n8n, não de
escopo:** as conexões `ai_tool` são **estáticas na definição do workflow**. Não
existe montar a lista de tools em runtime a partir de `api_n8n_tools_ativas`. O
endgame como imaginado não é implementável no n8n atual.

O corte "vende ou não vende" foi escolhido por ser o único que não vira
combinatória (2^7 perfis), e se sustenta porque as 3 tools básicas são baseline
— todo tenant tem. Se um dia houver um terceiro eixo de contratação com peso de
contexto parecido, a conta muda e vale reabrir.

O que o endgame prometia e **continua não valendo**: `contratado/ativo` do painel
ainda não corta o agente por tenant, só o perfil corta. Adicionar tool nova
continua exigindo mexer no workflow principal (`docs/ADICIONAR-TOOL.md`, passos
2 e 3).

### Regra que fica desta rodada

**Ação destrutiva não fica atrás de `$fromAI` junto com ação reversível.**

`gerenciar_pedido` agrupa adicionar/remover/ver porque o pior caso é um turno
perdido — o carrinho devolvido mostra o engano na hora. `fechar_pedido` e
`cancelar_pedido` são tools próprias: o agente chamar `fechar` quando o cliente
perguntou "quanto ficou?" trava o pedido, e `cancelar` por engano apaga o
carrinho. Ação irreversível precisa ser escolha positiva do modelo, não um valor
de parâmetro no meio de outros.

## Janela conhecida entre o debounce e a resolução do perfil

Registrada em 11/08/2026, ao desenhar a fatia 3.

O nó `Tools Ativas` fica **depois** do `Wait Debounce`, de propósito: assim roda
uma vez por invocação real do agente, e não em toda mensagem que o
`Ultima Mensagem?` vai descartar.

O efeito colateral é uma janela: entre a mensagem chegar e o perfil ser
resolvido passam os segundos do debounce (8s na Acqua). **Se alguém desligar
vendas nesse intervalo, a rota usa o estado novo** — a mensagem que chegou com o
módulo ligado é atendida pelo agente básico.

**Não é grave**, e por dois motivos: a trava `tool_ativa` do sub-workflow recusa
a ação de qualquer forma, então nada é gravado indevidamente; e a janela é de
segundos, contra uma ação (descontratar) que é rara e deliberada.

O inverso — ligar vendas durante a janela — faz a mensagem já ser atendida pelo
perfil de vendas, que é o comportamento desejável.

Fica anotado porque é o tipo de coisa que, se aparecer como "o agente ignorou meu
pedido uma vez", ninguém conectaria à posição de um nó.

## Duas janelas que interagem: debounce e trava de foto

Registrado em 12/08/2026, antes de existir o caso.

São dois temporizadores no mesmo fluxo, configuráveis por tenant e independentes:

| janela | onde | default | quem configura |
|---|---|---|---|
| `debounce_segundos` | `tenants` — o `Wait Debounce` | 8s (Acqua) | agência |
| `janela_foto_segundos` | `tenant_tools.config` de `foto_produto` | 30s | agência |

**Hoje não há conflito**, porque 30 > 8 com folga. A relação importa quando um
tenant tiver **debounce longo**: com debounce de 40s, por exemplo, o cliente
manda "manda a foto da picanha", espera, o agente responde; ele pede outra, e
essa segunda pergunta chega numa execução que começa *depois* de a janela de 30s
já ter expirado. A trava deixa passar — o que está certo — mas a distância entre
as duas fotos vira o debounce, não a janela.

O inverso é mais incômodo: **janela maior que o debounce mais o tempo de
resposta** faz o follow-up legítimo ser recusado. Com debounce de 8s, resposta em
~10s e o cliente digitando, o segundo pedido chega perto de 30s — na fronteira.

**Não mexer agora.** A trava registra toda recusa em `fotos_enviadas` com
`motivo = 'janela'`; se aparecerem recusas seguidas de um pedido explícito do
cliente, o número está apertado e o dado diz em quanto. Calibrar antes de ter
evidência seria trocar um chute por outro.

O que **não** fazer: derivar `janela_foto_segundos` de `debounce_segundos`
automaticamente. Elas medem coisas diferentes — uma agrupa mensagens que chegam
juntas, a outra impede uma sequência de imagens — e acoplá-las faria mexer no
debounce mudar o comportamento de foto sem ninguém pedir.

## Ideia futura: transformar a aba "Uso" em relatório para o cliente

Registrado em 12/08/2026, a pedido do Felipe. **Não construir agora** — ele quer
focar em outra coisa. O que segue é o que já se sabe, para a fatia não começar
do zero.

### O que a aba é hoje

`/painel/consumo`, rotulada **"Uso"** na barra lateral. Ela existe e funciona,
mas mostra **volume, não dinheiro**:

```
billing_volume_mensal()  ->  mes | mensagens | conversas_ativas
```

O custo em dólar vive em outra função, `billing_consumo_mensal()`, que é
**super_admin only** e alimenta `/admin/consumo`. Ela soma tokens de conversa e
de ingestão, multiplicados por `precos_modelo`.

Ou seja: a separação entre "quanto você usou" e "quanto isso custa" já está
feita, e não por acaso.

### A decisão que a fatia precisa tomar antes de escrever código

**O cliente vê custo?** Não é pergunta de UI. Mostrar dólar para ele é revelar a
base de custo da agência — o que ele paga menos o que a agência paga é a margem.
Três desenhos possíveis, em ordem de exposição:

1. **volume melhorado** — mensagens, conversas, minutos de áudio, documentos
   indexados. Nenhum valor monetário. É o que a aba já faz, com mais dimensões;
2. **consumo em unidade neutra** — "créditos", desacoplado do preço da OpenAI.
   Permite cobrar sem expor a base;
3. **custo real** — só faz sentido se o modelo comercial for repasse
   transparente (custo + taxa), e aí a margem é acordada, não escondida.

Enquanto isso não estiver decidido, qualquer tela construída vai ter de ser
refeita.

### O que já está pronto para alimentar o relatório

- `mensagens_log`: `tokens_entrada`, `tokens_saida`, `modelo`, `criado_em` e —
  desde a migração 32 — `audio_segundos`, **por tenant e por conversa**;
- `uso_ingestao`: tokens de embedding por documento;
- `precos_modelo`: preço por 1M tokens, com vigência por data.

### O que falta, e é pré-requisito de qualquer versão com dinheiro

**Áudio não tem preço.** `precos_modelo` só tem colunas por 1M tokens; Whisper
cobra por minuto. Sem isso, o áudio do cliente aparece registrado e custando
zero — o `billing_consumo_mensal` nem o enxerga.

O encaixe natural é uma coluna `usd_por_minuto` nullable mais uma linha
`whisper-1`, seguindo a forma que a tabela já tem (`usd_embedding_por_1m` já é
null para modelo de chat), e um terceiro braço na `billing_consumo_mensal`.

**Isso é independente da decisão acima** e vale fazer antes: sem preço, o custo
de áudio não existe em lugar nenhum, nem para a agência.

## Ideia futura: memória de longo prazo por cliente

**Sem código.** Registrada em 11/08/2026 para não se perder.

Hoje a memória é por conversa (`Redis Chat Memory`, chave
`tenant_{id}_memory_{conversation_id}`) e morre com ela. Um cliente recorrente
recomeça do zero toda vez.

Desenho: tabela `clientes` chaveada por **(`tenant_id`, `telefone`)**, com
preferências que o agente lê no início da conversa e escreve quando aprende algo
— alergia, endereço de entrega, "sempre sem cebola", forma de pagamento
preferida.

**O limite é o que define a ideia: escopo de PREFERÊNCIA, nunca de PEDIDO.**

Memória é escrita pelo LLM. Carrinho em memória significa **total vindo do
modelo** — a trava 1, exatamente. O carrinho fica no banco, em `pedidos` e
`pedido_itens`, resolvido pelo servidor, e nada nessa tabela pode influenciar
preço ou quantidade. Preferência muda *como* se atende; não muda *quanto* custa.

**Gatilho:** cliente recorrente pedindo a mesma coisa — quando repetir o pedido
inteiro virar atrito visível na conversa, não antes.

Ponto de atenção para quando vier: `telefone` como chave é dado pessoal e a
tabela é escopada por tenant, então nasce com RLS e policy na mesma migração,
como todas.

## Pagamento

**Provedor NÃO definido. Asaas está em avaliação, e trocar continua sobre a
mesa.** Foi o primeiro contrato lido inteiro e virou o **benchmark** — é dele
que saiu a lista de perguntas a fazer a qualquer provedor (ver
[`vendas-tetos-e-provedor.md`](vendas-tetos-e-provedor.md)). Ser referência não é
ser escolhido.

Stripe segue descartado — histórico irregular no Brasil e sem os meios de
pagamento que os clientes esperam.

> **Correção de 2026-08-17.** Esta seção dizia "Provedor definido: Asaas". Era
> falso: a reunião aconteceu e a proposta ainda não chegou. Fica registrado
> porque a frase estava a caminho de virar premissa — quem lesse o doc começaria
> a integração pelo provedor errado, e doc errado sobrevive à conversa que o
> corrigiria.

**Nenhuma linha de código escrita, e não deve ser escrita ainda.** O que trava
não é técnico: é o contrato e a decisão de preço que sai dele.

### O perfil é BaaS, e isso não é detalhe de nomenclatura

O guia do Asaas separa três formas de trabalhar com eles, e a nossa é a terceira:

| perfil | o que é | contrato específico |
|---|---|---|
| Parceiro de indicação | você indica, o cliente abre a conta dele | não |
| Gateway | você integra o checkout, a conta é do cliente | não |
| **BaaS** | **você cria subconta por cliente e opera via API dentro da sua marca** | **sim** |

É BaaS porque o cliente final nunca vê o Asaas como fornecedor dele: a conta é
criada por nós, por API, e a experiência é do ChatYou. Isso é exatamente o que
queremos do produto — e é o que aciona o contrato específico, com o Anexo I
descrito abaixo.

O desenho financeiro não mudou: **conta raiz** nossa, **subconta por cliente**
(CNPJ e banco dele), dinheiro caindo direto na conta do cliente. Nunca passa por
nós — se passasse, seria intermediação financeira e exigiria autorização do
Banco Central.

### Estado da conta

- Reunião **feita**.
- Limites do período de avaliação (10 subcontas, R$ 2.000 por subconta, 60 dias)
  são **negociáveis** — não são teto rígido.
- **Proposta comercial na próxima semana.**
- **Em aberto:** a pergunta sobre sandbox ficou sem resposta. Sem ela não dá
  para estimar quanto da integração é testável antes de assinar, e isso muda a
  ordem de construção.
- Só CNPJ (Resoluções Conjuntas 16 e 17 do BC) — inalterado.
- BaaS exige exibir a marca Asaas nos pontos de contato com o cliente final.

### A exposição do Anexo I — decidir ANTES de assinar

Este é o ponto que muda o preço do módulo, e é decisão de negócio, não de
engenharia. Fica registrado aqui porque ninguém deve descobrir isso durante a
implementação.

**Responsabilidade solidária e irrevogável pelos impactos financeiros dos
clientes finais.** Chargeback, estorno e saldo negativo de qualquer subconta
podem ser cobrados de nós. Na prática: um cliente nosso que suma com saldo
negativo vira dívida nossa, e "solidária" significa que o Asaas pode cobrar de
nós direto, sem precisar tentar o cliente primeiro.

**Multas do item 13: de R$ 20 mil a R$ 500 mil por infração.**

Três consequências que precisam de decisão antes da assinatura:

1. **O preço do módulo de vendas tem que embutir esse risco.** Vender pagamento
   pelo mesmo valor dos outros módulos é subsidiar o prejuízo de quem der
   chargeback com a margem de quem não der.
2. **Cliente de vendas precisa de critério de entrada.** Se qualquer tenant pode
   contratar o módulo, qualquer tenant pode gerar saldo negativo em nosso nome.
   Hoje contratar é um booleano no admin — sem análise, sem garantia, sem limite.
3. **Precisa haver teto por subconta.** O limite de R$ 2.000 do período de
   avaliação some quando a conta for liberada, e some junto o único freio
   automático que existe hoje.

Nada disso é código antes da proposta chegar. Mas o **desenho** do módulo muda
conforme a resposta: se a exposição for aceita, o painel precisa de campos de
análise e limite por cliente que hoje não existem.

### Consequência para a ordem

Enquanto a proposta não chega e o sandbox não é respondido, **não vale escrever
integração**. O que vale é o que não depende do Asaas: exercitar os três ramos
da foto, e decidir o preço do módulo com o Anexo I na mesa.

## Catálogo: a busca informa o total (migração 41, **aplicada** em 17/08)

**O defeito.** O agente do `emporio` (40 produtos) respondeu *"o que vocês teriam
para me oferecer?"* listando **três queijos**, como se fosse o catálogo inteiro.
`api_n8n_buscar_produtos` tinha `limit 10` e devolvia só as linhas: o agente
recebia N e apresentava N, sem saber que houve corte. O cliente final também não.

**A forma escolhida: uma linha sempre**, com `total_encontrado`,
`total_catalogo`, `mostrando`, `houve_busca` e `texto`. A alternativa óbvia —
uma coluna de total repetida em cada linha — quebra no caso que mais importa:
busca sem resultado não tem linha, e portanto não tem onde pendurar o total.

Isso é o que permite distinguir duas situações que antes chegavam iguais (zero
linhas) e pedem respostas opostas:

| situação | o que o agente lê |
|---|---|
| termo não casou, catálogo cheio | `Busca "queijo azul": 0 encontrados. O catálogo tem 40 itens disponíveis.` |
| catálogo não cadastrado | `Catálogo vazio: nenhum item disponível.` |

**Amostra de 10 para 5.** Com o total no retorno o agente para de precisar da
lista para responder bem — "tenho 23 opções, procura para petisco ou para
cozinhar?" conversa melhor que dez linhas que ninguém rola no WhatsApp.

**O texto saiu da query do n8n e entrou na função.** Antes ele vivia numa string
dentro de um JSON de workflow, fora do alcance de teste — e este projeto já
perdeu produção por escapamento errado em nó de workflow. Agora muda por migração
com rollback, e `tests/migracao-vendas.mjs` exercita cada ramo.

**Pergunta aberta continua em aberto** — registrada em
[`PENDENCIA-CATEGORIA-PRODUTO.md`](PENDENCIA-CATEGORIA-PRODUTO.md). `termo = ''` devolve os primeiros por
ordem alfabética, e no `emporio` os nomes começam com número (`1 -`, `10 -`,
`11 -`), então a amostra sai `1, 10, 11, 12, 13`: não é só arbitrária, parece
defeito. A resposta boa depende de **categoria de produto**, que é a próxima
fatia. O que a 41 fez foi tornar o corte visível e dizer ao agente que não houve
busca — o suficiente para ele perguntar em vez de fingir que listou tudo.

## Ordem de construção

Os passos 1 a 5 estão **feitos e em produção**:

1. ~~Migração de vendas + rollback~~
2. ~~Teste de isolamento: tenant B não vê produto nem pedido do tenant A~~
3. ~~Tela de catálogo no painel~~ — foi mesmo o custo real da feature, não o SQL
4. ~~Sub-workflows das tools, com a trava `tool_ativa`~~
5. ~~Catálogo + contratar para um tenant de teste~~ (`restaurante-teste`,
   nunca a Acqua)
6. **Pagamento** — bloqueado no contrato, não no código. Ver a seção Pagamento.

O passo 4 antes do 6 era de propósito e se provou certo: a parte difícil não foi
gerar link de pagamento, foi o agente conduzir a conversa até o fechamento sem
se perder — e isso já está exercitado, com pedido fechado à mão.

## Pendências fora de vendas

Fechadas nesta rodada:

- ~~Limpeza do ledger~~ — reconciliado; ver `docs/DIVERGENCIA-LEDGER-MIGRACOES.md`.
  Os objetos `podcast_*` **não** eram código morto e não foram dropados.
- ~~Índice do histórico em `mensagens_log`~~ — aplicado como migração 39
  (era o segundo arquivo numerado 18). 72 linhas, 70 ms.

Abertas:

- **Acqua sem tráfego desde 24/07.** Token não foi revogado, o que favorece a
  hipótese de webhook parado em vez de cliente perdido. Continua sem diagnóstico.
- **Três ramos da foto nunca exercitados** — ver "Onde isto está agora".
- **`S_básico` ainda não medido** (266, `medido: false` em
  `scripts/gerar-principal.mjs`). O perfil de vendas já foi calibrado; o básico
  não, então o rateio dele carrega a incerteza que o outro já não tem.

## Rateio de custo: o `Estima Tokens` estava errado em até 10x

Medido em 11/08/2026 contra execuções reais, ao fechar a fatia 2.

```
execução   chamadas ao modelo   real (soma)   registrado   erro
3948813            1                1554         1045       1,5x
3948994            2                3828         1045       3,7x
3948818            6               10481         1049      10,0x   ← a venda
```

**O erro não era uniforme entre tenants** — e é isso que o quebra. O próprio nó
diz que não é fatura, é estimativa *consistente* para ratear. Mas quem usa
ferramenta era subcobrado 10x contra quem só conversa, e vendas multiplica
justamente o uso de ferramenta.

### Três causas

**1. Multiplicidade — a de 10x.** O nó contava UMA chamada ao modelo. Cada tool
call é outro round-trip que reenvia o prompt inteiro; a venda fez seis.
**Corrigido.** A aritmética `K × base + 55 × K(K−1)/2` foi calibrada contra as
três execuções e errou 0,0% / −1,4% / 0,0%. `K` vem de `intermediateSteps`, que
exigiu ligar `returnIntermediateSteps` no AI Agent.

**2. Base subestimada.** A primeira chamada real custou 1554 tokens; a estimativa
deu 1045. Faltam ~509, que são os schemas das tools (`TOKENS_FERRAMENTAS = 320`
está velho, aponta para ~830) mais a janela do Redis. **Não corrigido** — não dá
para separar "schema" de "memória" com os dados que temos.

**3. Memória invisível.** Duas execuções com conteúdo de memória diferente
estimaram o mesmo 1045, enquanto o real diferiu em 306 tokens. E a janela acabou
de ir de 5 para 20.

### Calibrado: 3,11 chars/token e 622 tokens de schema

Duas execuções com o **mesmo texto de prompt** e memórias diferentes formam um
sistema de duas equações — e aí os dois desconhecidos se separam:

```
3948813   real 1554 = 2901/r + S           (conversa nova, memória ~0)
3949288   real 2036 = (2901+1500)/r + S
subtraindo:    482 = 1500/r   →   r = 3,112   →   S = 622
```

Conferido contra as quatro execuções disponíveis:

```
3948813   previsto  1556   real  1554   +0,1%
3949288   previsto  2040   real  2036   +0,2%
3948994   previsto  3775   real  3828   −1,4%   (2 chamadas)
3948818   previsto 10485   real 10481    0,0%   (6 chamadas, a venda)
```

Antes disso o mesmo cálculo errava de 1,5x a 10x.

**Os 4 chars/token da heurística genérica estavam errados para português**:
o valor medido é **3,11**, uma diferença de 29%. O tokenizer quebra acento em
mais de um token, e tanto o system prompt quanto as conversas são em português.

**622 cobre as 7 tools atuais — ~89 por tool.** É o número que a fatia 3 vai
precisar por perfil: 3 tools dão ~266, mas isso é **regra de três, não medição** —
a fatia 3 mede o segundo valor pelo mesmo método das duas equações.

#### Pendência: `r` saiu de um tenant só

As duas execuções que resolveram o sistema são **ambas do restaurante-teste**,
com o mesmo estilo de texto — system prompt curto em português, conversa
coloquial. Um tenant que escreva diferente pode ter `r` diferente: mais termos
técnicos, nomes próprios, números ou outro idioma mudam quantos tokens cada
caractere rende.

Isso **não invalida os ±1,4%** medidos, mas eles valem para esse perfil de texto.
`r = 3,112` é um valor calibrado, **não uma constante universal**.

**Recalibrar quando houver um segundo tenant vendendo**, repetindo o método: duas
execuções do mesmo tenant, mesmo prompt, memórias diferentes. Se o `r` do segundo
divergir muito do primeiro, o certo passa a ser um `r` por tenant — o que é
viável, porque o cálculo já roda por tenant.

### A sonda — respondida: NÃO dá

Execução 3949227, com o nó já em produção:

```
_sonda: "erro:first:No data found from `main` input"
```

O nó `OpenAI Chat Model` **é encontrado** — não é erro de nome — mas não tem
saída `main`, e tanto `.all()` quanto `.first()` falham nela. **Um nó Code no
fluxo principal não alcança sub-nó.** A conclusão do autor anterior estava certa;
agora está provada, e a pergunta não precisa ser reaberta.

O `tokenUsageEstimate` também **não agrega** as N chamadas: é uma entrada por
chamada. Foi a primeira hipótese, descartada olhando os dados brutos.

Fica a estimativa. A multiplicidade já está corrigida por aritmética.

### O que a mesma execução revelou sobre a memória

```
execução 3949227    1 chamada    real 2016    estimado 1043    faltam 973
execução 3948813    1 chamada    real 1554    estimado 1045    faltam 509
```

Mesma estimativa, mesmo número de chamadas, e a diferença quase dobrou. **A causa
é a janela de memória**, que subiu de 5 para 20 na fatia 2 — a mesma mudança que
deixou o carrinho sobreviver à conversa alargou o ponto cego do rateio.

E o erro volta a não ser uniforme: cresce com o tamanho da conversa, então quem
conversa muito é subcobrado contra quem resolve em duas mensagens.

**Caminho identificado, não implementado:** `mensagens_log` está sendo escrito
(confirmado em 11/08) e tem `conteudo`, `conversation_id` e `direcao`. Um nó
Postgres antes do `Estima Tokens`, lendo as últimas ~20 mensagens daquela
conversa, daria ao cálculo o texto que hoje ele não vê. Custa uma query por
mensagem.

Com a memória contabilizada, o resíduo passa a ser **só os schemas das tools** —
e aí `TOKENS_FERRAMENTAS` pode ser calibrado de verdade, em vez de absorver dois
erros de uma vez.

Campos de diagnóstico no output: `_fonte_tokens`, `_sonda`, `_chamadas`,
`_estimado_entrada`. Saem quando a sonda der veredicto.

### Lição: mudar contexto do agente mexe no faturamento

Não é óbvio, e por isso fica escrito.

A fatia 2 subiu o `contextWindowLength` do Redis de 5 para 20 — uma mudança de
**comportamento do agente**, feita para o carrinho sobreviver à conversa. O
efeito colateral foi **quadruplicar o ponto cego do rateio**: o `Estima Tokens`
não enxergava a memória, então o erro por mensagem saltou de ~509 para ~973
tokens sem que nada no código de billing mudasse.

Ninguém revisando aquela mudança olharia para o faturamento. Mas janela de
contexto, tamanho de system prompt, número de tools e retorno de tool **são todos
entrada do modelo** — e entrada do modelo é custo.

**Regra que fica:** ao mexer em qualquer coisa que altere o que vai no prompt,
rode `npm run n8n:sincronia` e confira o rateio na execução seguinte. Se o que
mudou não estiver contabilizado no `Estima Tokens`, o rateio passa a mentir em
silêncio — e mentir de forma desigual entre clientes, que é pior que mentir
igual para todos.

### Como o histórico entrou sem virar a quarta query

`api_n8n_conversa_sync` já era chamada antes do AI Agent, no momento exato em que
o histórico é o que a memória vai carregar. A migração 29 fez ela devolver mais
uma coluna, `historico_chars`, e o nó que já existia passou a ler junto. Nenhum
nó novo, nenhuma query nova.

**Devolve contagem, não texto.** O cálculo só precisa do tamanho, e trafegar o
conteúdo colocaria conversa de cliente no log de execução do n8n — onde o token
do Chatwoot já aparece.

E `Registra Mensagem` passou a gravar as **duas direções numa chamada só**: duas
chamadas de função num `SELECT` continuam sendo um statement, então a restrição
de "query com parâmetro = statement único" continua respeitada. A entrada entra
com 0/0 de token para não contar duas vezes em nenhuma soma.

Até então `direcao = 'entrada'` tinha **zero linhas** — só a saída era registrada.
Sem isso o histórico reconstruído seria metade do contexto.

### O corpo do nó virou arquivo

`n8n/estima-tokens.js`. Antes vivia como string dentro do JSON do workflow, onde
não dá para revisar em diff nem rodar lint — e foi em parte por isso que o erro
de multiplicidade passou meses invisível. O gerador injeta, e o `__WRAPPER__` é
substituído pelo mesmo texto do System Message.
