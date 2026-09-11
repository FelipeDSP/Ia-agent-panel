# Pagamento via Asaas — fase de sandbox

**Migração 61 APLICADA em 10/09/2026** (ledger `20260910230000`). Workflows
escritos e **não importados**; nenhuma credencial de Asaas em arquivo versionado.

Medido no ato da aplicação:

- `api_n8n_estado_pedido` mudou de corpo (`e4eef344…` → `d328b7c2…`) e o **ACL
  sobreviveu ao `drop` IDÊNTICO** — `{postgres, service_role, n8n_agent}` dos
  dois lados. Era o risco real desta migração (a armadilha das 40/41);
- **aplicar não contratou para ninguém**: `tenant_tools` com `pagamento`
  continua em 0, contado antes e depois;
- as duas tabelas novas com RLS, uma policy cada, e **sem grant para `anon`**;
- as cinco funções novas com `n8n_agent` **e** `service_role`, sem `anon` nem
  `authenticated`;
- `n8n_agent` chamou de verdade e recebeu `pagamento_confirmado`;
- **e o nó em produção continua funcionando**: a query do `Estado do Pedido`,
  rodada verbatim contra a função nova, devolve as seis colunas que ela pede. Ela
  seleciona um subconjunto, então a coluna nova simplesmente não é pedida.

> **O AGENTE NUNCA CONFIRMA PAGAMENTO.** Não há ferramenta que confirme, marque
> ou altere pagamento, e a propriedade é verificada por varredura e não por
> convenção: `teste:pagamento-asaas` §4 procura `set status = 'pago'` em **toda**
> `api_n8n_*` e exige que exista em exatamente uma — a do webhook, que pede um
> token que o modelo não tem. Função nova amanhã cai nessa varredura sozinha.

---

## 1. O que está pronto, e em que ordem ele entra

| # | artefato | estado |
|---|---|---|
| 0 | `n8n/workflows/pagamento-sandbox-passo0.json` + `n8n/passo0-identifica-origem.js` + `scripts/gerar-passo0.mjs` | escrito, **não importado** |
| 0 | `scripts/conferir-roteamento-sandbox.mjs` (`npm run n8n:roteamento-sandbox`) | roda; hoje diz **PASSO 0 NÃO PROVADO** |
| 5 | `n8n/workflows/tool-gerar-link-pagamento.json` + `webhook-pagamento-asaas.json` | escritos em 11/09, **não importados** — só depois do experimento; §11 |
| 1 | `supabase/migrations/20260910230000_61_pagamento_asaas_sandbox.sql` + rollback | **APLICADA** em 10/09; `teste:pagamento-asaas` 100/100 |
| 2 | regra 3 do portão em `n8n/aplica-portao.js` | escrita; `teste:portao-pagamento` 43/43 |
| 3 | `tests/notificacao-nao-pausa.mjs` | 17/17 |
| 4 | `scripts/sonda-asaas-expiracao.mjs` (`npm run sonda:asaas-expiracao`) | **RODOU** em 10/09 — resposta parcial, §6 |
| 4 | `scripts/lib/asaas.mjs` + `tests/asaas-classificacao.mjs` | 29/29, sem rede |

**O passo 0 não pôde ser executado por mim**, e ele é a porta de tudo. Importar
workflow e repontar o webhook do Chatwoot são atos na instância, e os dois estão
fora do que foi autorizado. O que dá para entregar é o artefato e o verificador —
e o verificador está escrito para **falhar** enquanto não houver prova, em vez de
ficar verde por falta de dado:

```
✓ (57, 282) -> estudyou-sendbox   [workflow de TESTE (passo 0)]
✓ (59, 279) -> emporio            [workflow PRINCIPAL]
✓ e são tenants distintos
✓ caixa nula estoura 22023 (não escolhe ninguém)
✗ NADA A MEDIR: nenhuma mensagem no sendbox nos últimos 30 min.
  PASSO 0 NÃO PROVADO — não siga para pagamento.
```

Ele não fala com o n8n nem com o Chatwoot, e não é escolha: o token dos tenants
conectados é de Agent Bot, e a API do Chatwoot responde **401** em
`/accounts/{id}/inboxes` para bots (medido, é o que sustenta
`PENDENCIA-CAIXA-SEM-VALIDACAO.md`). O que ele mede vem do banco — os dois pares
resolvem para tenants diferentes pela mesma função que o workflow chama, e
`mensagens_log` mostra a marca da duplicidade se ela existir: **a mesma mensagem
gravada por execuções diferentes**, que é o que dois workflows no mesmo par
produzem.

### O roteiro do passo 0

1. importar `n8n/workflows/pagamento-sandbox-passo0.json`, ativar, copiar a URL
   de produção do webhook;
2. no Chatwoot da conta **57**, apontar o webhook da caixa **282** para ela — e
   conferir que o `emporio` (**59** / **279**) continua no principal;
3. mandar **uma** mensagem de cliente no sendbox e **uma** no `emporio`;
4. `npm run n8n:roteamento-sandbox`.

---

## 2. O que o Asaas documenta, e o que ele não documenta

Lido em 10/09/2026. Cada item aqui mudou alguma decisão.

**Medido na documentação:**

- **`endDate` do link de pagamento é uma DATA**, não data-hora — o exemplo da
  própria referência é `"2024-09-05"`;
- entrega é **at least once** e a doc manda deduplicar: *"O mesmo evento pode ser
  enviado mais de uma vez"*, *"Use o campo `id` como chave única"*, *"Não repita
  a regra de negócio quando o evento já tiver sido processado"*. O `id` tem a
  forma `evt_05b708f961d739ea7eba7e4db318f621&368604920`;
- webhook autentica por header **`asaas-access-token`**, token de **32 a 255**
  caracteres, e a doc é explícita que ele **não pode ser uma API Key**;
- **15 falhas consecutivas INTERROMPEM a fila**, e reativar é manual. Não é
  "perde um evento": é para de chegar tudo;
- `PAYMENT_RECEIVED` é o evento de Pix e boleto; `PAYMENT_CONFIRMED` é o
  intermediário de cartão — e são eventos **diferentes, com `id` diferente**;
- sandbox é `https://api-sandbox.asaas.com`, header de API `access_token`;
- existe `PUT /v3/paymentLinks/{id}` com `active`, e `DELETE` (removido pode ser
  restaurado).

**A documentação NÃO diz — e é a pergunta que o enunciado mandou não assumir:**

> **o que acontece com uma tentativa de pagamento em link expirado ou
> desativado.** Quatro páginas lidas, nenhuma descreve o comportamento da página
> de pagamento depois de `endDate` ou de `active=false`.

**A documentação não diz — a SONDA respondeu metade.** Ela rodou em 10/09 contra
o sandbox: link **desativado** a página recusa; link **expirado** eu **não
consegui medir**, porque o Asaas não deixa produzir um. Os dois não são a mesma
coisa e a §6 não os escreve como se fossem.

### A consequência: `endDate` não alinha uma janela de 30 minutos

O enunciado pedia *"o link nasce com vencimento alinhado à janela do tenant, para
que os dois expirem juntos"*. **Com granularidade de dia, isso não cabe no
campo.** O que foi feito:

- a autoridade sobre o prazo é **nossa** e mora em `pedido_cobrancas.expira_em`,
  com precisão de segundo, calculada de `tenants.pagamento_expira_minutos`;
- o `endDate` vai para o **dia** da expiração — teto grosseiro, não alinhamento;
- o alinhamento fino é um `PUT active=false` na hora em que nossa janela vence.
  **Não está feito**, mas a incógnita que o travava caiu: a sonda mostrou que
  desativar FUNCIONA — a página recusa com todas as letras. O que falta agora é
  decisão de fluxo (quem dispara, preguiçoso ou agendado), não conhecimento.

**Consequência que precisa estar escrita: enquanto ninguém desativar, o link
continua pagável depois de a nossa janela fechar.** Não é defeito da migração, é
o estado de fato — e é exatamente o que o caminho `fora_do_prazo` trata.

E há um piso que a documentação também não anunciava e a recusa entregou:
**R$ 5,00 para Pix e boleto.** Ver §7.

---

## 3. Banco (migração 61)

### Credencial por tenant, e por ambiente

Em `tenant_credenciais`, que já é a casa do token do Chatwoot e já nasce fechada
(policy é `auth_is_super_admin()` e mais nada):

```
asaas_ambiente               'sandbox' | 'producao'
asaas_api_key_sandbox        asaas_api_key_producao
asaas_webhook_token_sandbox  asaas_webhook_token_producao   (CHECK de 32..255)
```

As duas chaves convivem e `asaas_ambiente` diz qual vale. **Migrar para produção
vira virar um enum** — auditável, reversível, e a chave de sandbox continua lá
para testar. Uma coluna só faria da migração uma troca de string no escuro.

**A URL base é DERIVADA, nunca guardada.** Guardar a URL ao lado da chave permite
o estado impossível "chave de sandbox apontando para produção", e esse estado não
dá erro — dá cobrança de verdade com credencial de teste, ou o contrário. O teste
afirma que **não existe coluna de URL para divergir da chave**.

E o token do webhook segue o mesmo par, com uma consequência que vale escrever:
**só o token do ambiente ativo autentica.** Um token de sandbox esquecido para de
valer no instante em que o tenant vira produção, sem ninguém ter de lembrar de
apagá-lo. (`teste:pagamento-asaas` §2 mede isso nos dois sentidos.)

### A janela, por tenant

`tenants.pagamento_expira_minutos`, default 30, `CHECK between 1 and 10080` — ao
lado de `debounce_segundos` e `pausa_expira_minutos`, e pelo mesmo motivo: uma
padaria e um curso on-line não têm a mesma janela.

Ela **nasce agência-only de graça, e isso é propriedade e não sorte**:
`tenants_guard_colunas` compara `to_jsonb(new) - <lista branca>` com
`to_jsonb(old) - <lista branca>`, então coluna fora da lista é imutável para
`tenant_admin` (`42501`). O teste afirma que ela não está na lista.

### O vínculo, e o registro do webhook

`pedido_cobrancas` — uma linha por link gerado. **FK COMPOSTA**
`(tenant_id, pedido_id) → pedidos(tenant_id, id)` (com a `uq_pedidos_tenant_id`
que faltava), pelo mesmo motivo da 57: FK simples permitiria uma cobrança do
tenant A apontar para um pedido do B, e RLS não valida FK.

`pagamento_eventos` — a trava de idempotência e o registro de auditoria.
**Sem coluna de payload**: o corpo do webhook do Asaas traz nome e documento do
pagador, e nada aqui precisa deles. Deduplicar precisa do `id` do evento; auditar
precisa do veredito. **O que não é guardado não vaza**, e o teste afirma que a
coluna não existe.

As duas com RLS + policy, `revoke all` antes do `grant` (objeto novo neste
projeto nasce com `arwdDxtm` para `anon`), e `anon` **recusado no grant** — mais
forte que "lê 0 linhas".

### `pedidos.status` não ganhou estado novo

`aguardando_pagamento` → `pago` já existiam e servem. `expirado` continua sendo
da expiração de pedido, que é outra coisa e tem outro relógio.

### A ferramenta, e o que ela não recebe

```
api_n8n_gerar_cobranca(p_tenant_id uuid, p_conversation_id bigint)
```

É a assinatura inteira, e o teste a afirma literalmente. **Não recebe valor, não
recebe produto, não recebe nome de item** — não há parâmetro que o agente possa
envenenar porque não há parâmetro. O valor sai de `pedidos.total_centavos` dentro
da função.

Ela não chama o Asaas (o banco não faz HTTP): devolve o que POSTar mais a
credencial, e `api_n8n_registrar_cobranca` grava o que voltou. É o mesmo par
reserva/confirma de `api_n8n_notificar_venda` + `api_n8n_confirmar_notificacao`.

**Reuso:** chamada duas vezes no mesmo pedido devolve a **mesma** cobrança viva
(`ja_existia = true`). Dois links vivos para um pedido é o caminho mais curto
para cobrar duas vezes.

**Link de pagamento, não cobrança nominal** — cobrança nominal exigiria CPF/CNPJ
do pagador, o que significaria a IA pedindo documento por WhatsApp. A descrição
que vai para a página do Asaas é `Pedido nº N — <tenant>`, e o teste afirma que
ela não carrega dado do cliente, porque aquela página é pública por URL.

### Idempotência em DUAS camadas, e uma só não basta

| | o que é | o que ela pega |
|---|---|---|
| camada 1 | `unique (tenant_id, evento_id)` + `on conflict do nothing` | o **mesmo** evento reenviado |
| camada 2 | `update pedidos ... where status='aguardando_pagamento'` e `update pedido_cobrancas ... where pago_em is null` | eventos **diferentes** sobre o mesmo pagamento (`CONFIRMED` depois de `RECEIVED`) |

A camada 1 sozinha deixa o par CONFIRMED/RECEIVED aplicar duas vezes; a camada 2
sozinha deixa dois registros e duas notificações para o mesmo evento reenviado.

`aplicou` só é verdadeiro na transição real, e é ele que autoriza a notificação —
**duas confirmações não viram duas mensagens.**

O teste tira um **md5 do retrato do banco** (contagens + `pago_em` +
`atualizado_em`) antes e depois do reenvio e exige que seja idêntico. Estado, não
resposta 200.

### Pagamento fora do prazo

A autoridade é `expira_em`, nossa, com precisão de segundo — e não
`pedidos.status`, que a expiração preguiçosa pode não ter alcançado. Quando o
evento chega tarde:

- **não marca `pago`**;
- **o pedido NÃO reabre** — reabrir seria revalidar preço e estoque de um pedido
  velho sem ninguém olhando;
- grava `fora_do_prazo_em` e retém o `pagamento_id`;
- devolve `precisa_humano = true` e **nenhuma mensagem automática**.

### `api_n8n_estado_pedido` mudou de assinatura

Ganhou `pagamento_confirmado`. Isso é **troca de tipo de retorno**, e
`create or replace` não faz isso (`42P13`) — então é `drop function` pela lista
completa de tipos, e com ele vão **todos** os grants (a armadilha das 40 e 41). O
bloco de `revoke` + os **dois** `grant` está no arquivo, e o teste confere o ACL
**por diff** contra o de antes, com uma sabotagem (S5) que remove os grants e
exige que o diff acuse.

**Por que uma coluna nova e não ler `pedido_status = 'pago'`:** `pedido_status` é
do pedido da *janela* (tocado no turno) ou do rascunho. O cliente que pagou e
volta a perguntar "caiu?" meia hora depois não tem nem um nem outro —
`tem_pedido` seria falso e a regra 3 barraria uma resposta **correta**, mandando
"ainda não tenho nenhum item anotado" para quem acabou de pagar.

E `escreveu_neste_turno` passa a contar `pedido_cobrancas`: gerar o link é
escrita do turno. Sem isso, a mensagem que **entrega** o link ("Prontinho! aqui
está o link") cairia na regra 1 — afirma efeito consumado, e nenhuma linha de
`pedidos` se mexeu.

---

## 4. O portão ganhou a regra 3

```
REGRA 3 — afirma PAGAMENTO RECEBIDO e o pedido NÃO está `pago`  ->  BARRA.
```

**A assimetria é o INVERSO da regra 2**, e não alinhar as duas é o ponto:

- **errar para mais** barra uma mensagem que fala de pagamento sem afirmá-lo — e
  a substituta que sai no lugar diz a verdade ("ainda não apareceu a confirmação
  do pagamento aqui do meu lado"), então o cliente recebe informação correta;
- **errar para menos** deixa passar "seu pagamento foi confirmado" quando nada
  caiu — mercadoria entregue contra dinheiro que não existe.

Não há simetria entre esses dois erros, então o marcador é **largo** e a negação
é **estreita**.

**O falso positivo que importa** é conhecido e está no teste como caso de
controle: a mensagem que **entrega o link** contém a palavra "pagamento" e
termina em "assim que o pagamento for confirmado eu te aviso". Ela não pode ser
barrada — é o passo que a fase inteira existe para dar.

A regra 3 **não passa pelo `ehCandidata`**, e isso é deliberado: o gatilho largo
das regras 1 e 2 exige marca de efeito consumado ou valor monetário, e "o pix
caiu aqui, já pode retirar" não tem nem um nem outro.

**A narração do status vem do banco.** O bloco 📋 ganhou `Status: aguardando
pagamento` / `pago` / `em montagem`, lido de `pedido_status`. O modelo não
escreve essa linha, então não pode errá-la — e status sem rótulo aparece cru em
vez de sumir em silêncio.

### O par de sabotagens que prova o espelho

| | muta | quebra | fica verde |
|---|---|---|---|
| **S1** | `regra3Barra = afirmouPagamento` (sem olhar o banco) | o **espelho**: pedido `pago` passa a ser barrado | o caso direto |
| **S2** | marcador de pagamento morto | o **caso direto**: a afirmação falsa chega ao cliente | o controle do link |
| S3 | tira a negação de futuro | a mensagem do **link** passa a ser barrada | |
| S4 | lê `pedido_status` no lugar de `pagamento_confirmado` | o cliente que volta meia hora depois | o mesmo turno |

Cada uma imprime **md5 antes e depois**, não tamanho.

**Um defeito real que a §1 pegou:** `recebemos (o |seu )?pagamento` casa uma
palavra só, e a frase real é "Recebemos **o seu** pagamento". Passava. Corrigido
para `(o )?(seu )?`.

---

## 5. A notificação, e a armadilha

O webhook chega ao servidor, não ao WhatsApp. A mensagem sai como `outgoing` no
Chatwoot, e o Chatwoot dispara webhook **de volta** para o próprio fluxo. O
`Roteia Evento` separa bot de humano pelo `sender.type`, e essa condição é o
único guarda-corpo contra o bot se pausar sozinho.

`tests/notificacao-nao-pausa.mjs` **lê as condições do switch do
`agente-principal.json` e as executa** contra payloads sintéticos — não tem a
regra escrita dentro dele. Se alguém mexer no switch, o teste muda de resposta
junto.

Os dois lados, e nenhum sozinho basta:

1. a notificação com token de **agent bot** cai no `fallbackOutput: none` — não
   vira `humano`, não vira `cliente`, é descartada;
2. a **mesma** notificação com token de usuário vira `humano`, e da saída
   `humano` **se alcança `Pausa Conversa` no grafo real** (busca no grafo, não
   afirmação de que existe).

Só (1) passaria numa leitura em que nada nunca é roteado para `humano` — a pausa
estaria quebrada e o teste diria "seguro".

E há um **segundo** guarda-corpo que é fácil perder de vista: `ev8`
(`sender.type` não-vazio). Mensagem criada sem `sender` também não pausa. A
sabotagem de cada condição sonda o payload que **aquela** condição protege — a
primeira versão sondava as duas com o mesmo payload e ficou vermelha com razão.

> **O que este teste NÃO prova:** que o Chatwoot de fato carimba
> `sender.type = 'agent_bot'` para o nosso token. Isso é comportamento de
> serviço externo e só a sandbox responde. Fica provado o que é nosso: **dado
> esse carimbo, o fluxo não pausa.** A verificação na sandbox é o passo 5 do
> roteiro.

**A notificação usa a mesma credencial que o `Envia Mensagem Chatwoot` já usa**
(`api_n8n_credencial_chatwoot`) — não é um caminho novo, é o caminho existente
disparado por outro gatilho. Essa é a razão pela qual ela não pausa.

---

## 6. A sonda rodou. Resposta PARCIAL, e ela fica escrita como parcial.

Rodada em 10/09/2026 contra o sandbox, com chave de homologação. A chave e a
autenticação estavam certas o tempo todo — **nenhum** dos erros foi de
credencial.

### 6.1 O que a primeira execução devolveu, e por que a recusa é o dado

O plano era criar o link já com `endDate` no passado. O Asaas recusou com HTTP
400 e **três** erros de uma vez:

```
O valor mínimo para cobranças via Boleto e Pix é R$ 5,00.
É necessário informar a quantidade de dias úteis para vencimento da cobrança.
A data de encerramento do link de pagamento não pode ser inferior a data de hoje.
```

O terceiro mata a estratégia: **não dá para criar um link já expirado.** Os
outros dois viraram os achados 2 e 3.

### 6.2 EXPIRADO — **NÃO MEDIDO**

Tentei o caminho que restava: criar válido e **recuar** o `endDate` com
`PUT /v3/paymentLinks/{id}`. O Asaas recusa igual:

```
PUT endDate=2026-09-09 (ontem)  ->  HTTP 400  falha_de_chamada
  · A data de encerramento do link de pagamento não pode ser inferior a data de hoje.
```

**Não consegui produzir um link genuinamente expirado, então não medi link
expirado.** Não há aproximação escrita como se fosse medição.

Os outros caminhos, avaliados e o porquê da escolha:

| caminho | veredito |
|---|---|
| **`endDate` = hoje e um `GET` amanhã** | **é o caminho definitivo, e é o que falta fazer.** Custa um link e uma verificação no dia seguinte, e responde sem aproximar. Não foi feito porque leva até 24 h e a sonda existe para decidir agora |
| `PUT endDate` para o passado | tentado. Recusado, como acima |
| cobrança avulsa (`/v3/payments`) com `dueDate` no passado | **descartado: mede outra coisa.** Cobrança vencida é `PAYMENT_OVERDUE` e continua pagável por desenho — é o boleto atrasado de sempre, não um link de pagamento fora da janela |
| deixar o link vencer sozinho | é o mesmo que a primeira linha, com outro nome |

### 6.3 DESATIVADO (`active=false`) — MEDIDO, e a página RECUSA

Este é o estado que consegui produzir, e ele responde uma pergunta **parecida**,
não A pergunta.

```
PUT active=false                 ->  HTTP 200
reler o link                     ->  active=false   (a mutação entrou)
a página pública                 ->  HTTP 200, 41.716 bytes
```

E a página diz, com todas as letras:

> **"Seu fornecedor desabilitou esse link de pagamento."**

O valor aparece marcado como *"somente à vista"* e não há forma de pagamento
selecionável. **Link desativado não é pagável.**

### 6.4 O erro que essa medição pegou na própria sonda

A primeira leitura da sonda foi **`pagavel`** — errada. A página do Asaas é uma
SPA: o HTML servido traz "pix", "boleto", "qr code" e "forma de pagamento" no
esqueleto **mesmo quando o link não vale**. O classificador contou essas
palavras e concluiu o oposto do que a tela mostra.

O que o pegou não foi revisão: foi **abrir a URL no navegador**. A sonda já
avisava — ela reportou que a página encolheu 28% (57.761 → 41.716 bytes) e
imprimiu *"mudou MUITO e ainda assim deu `pagavel`: o HTML é indício, não prova.
ABRA A URL NO NAVEGADOR"*. O aviso estava certo e a conclusão estava errada.

Consertado em `scripts/lib/asaas.mjs`, e a frase real virou fixture em
`teste:asaas-classificacao`, com a contraprova de que é a **ordem** que resolve
(pista de recusa é avaliada antes de pista de oferta; sem a frase, o mesmo HTML
volta a dar `pagavel`).

Fica a regra, que vale para a próxima medição desta família: **`pagavel` a
partir de HTML é indício.** Se a decisão depender dele, abra no navegador.

### 6.5 A discriminação que o enunciado exigiu, provada

> *"force um erro de valor e confirme que a sonda NÃO o classifica como link
> expirado."*

A sonda faz isso **antes** de qualquer medição, contra o Asaas de verdade — uma
sonda que não separa os dois casos não deveria chegar a opinar sobre nenhum:

```
criar link de R$ 1,00 (esperado: recusa por VALOR)
    HTTP 400  ->  falha_de_chamada  (o Asaas recusou a REQUISIÇÃO (validação))
      · O valor mínimo para cobranças via Boleto e Pix é R$ 5,00.
  ✓ erro de valor foi classificado como `falha_de_chamada`, NÃO como link inválido
```

E a prova que **não** depende de rede nem de credencial está na suíte:
`npm run teste:asaas-classificacao`, 29 asserções, com o 400 real como fixture e
uma sabotagem que troca `falha_de_chamada` por `link_indisponivel` e exige que o
teste fique vermelho.

### 6.6 `dueDateLimitDays` = 1, e o porquê

Obrigatório (achado 2). O valor é **1**, o menor que faz sentido — não um número
redondo.

Ele é *"dias úteis que o cliente pode pagar depois do boleto ser gerado"*, ou
seja: **um segundo prazo, do lado do Asaas.** A autoridade sobre o prazo no nosso
desenho é `pedido_cobrancas.expira_em`, em minutos. Um valor maior aqui criaria
um prazo mais longo competindo com o nosso, e "está fora do prazo?" passaria a
ter duas respostas diferentes conforme quem pergunta.

### 6.7 O que muda no desenho, com o que se sabe hoje

| | |
|---|---|
| **`fora_do_prazo` continua obrigatório** | e continua sendo o caminho normal, não a corrida rara. Sem desativação explícita, nada faz o link parar de valer ao fim da nossa janela — `endDate` é de dia |
| **desativar ao fim da janela deixou de ser opcional** | agora se sabe que `active=false` **funciona**: a página recusa. Era a incógnita que travava a decisão. Vira trabalho próprio: quem dispara (preguiçoso, como a expiração de pedido, ou agendado), e o que responder a quem chegar depois |
| **o que ainda falta** | rodar o `endDate`=hoje + `GET` amanhã, para saber se link expirado se comporta como desativado. Se sim, a desativação vira redundância barata; se não, ela é a única defesa |

### 6.7b A chave quase vazou, e quem pegou foi varredura

Escrevendo o teste de redação, digitei uma "chave falsa" de fixture. Ela
começava com os **30 primeiros caracteres da chave de sandbox real** — eu a
tinha reproduzido de cabeça sem perceber.

O arquivo ainda não estava no git, e o que a pegou não foi releitura: foi uma
varredura comparando cada arquivo com pedaços da chave do ambiente.

A fixture passou a ser **construída** (`'$aact_' + 'hmlg_' + 'FIXTURE'.repeat(6)`),
de forma que não possa coincidir com credencial nenhuma — e a varredura virou
seção fixa de `teste:asaas-classificacao`: ela percorre os 434 arquivos de
`git ls-files` procurando qualquer trecho de 24 caracteres da chave, com
contraprova de que encontra quando há o que encontrar.

Sem a chave no ambiente ela emite **AVISO** e diz que não rodou, em vez de
passar. Verde por falta de dado é como o `x-foto-secret` deste projeto vazou
três vezes.

### 6.8 Um achado lateral, de privacidade

A página pública do link exibe **nome, CPF, e-mail, telefone e cidade do titular
da conta Asaas** — visto na inspeção. No desenho BaaS (subconta por cliente), o
titular é **o nosso cliente**, então o CPF/CNPJ dele fica numa URL pública que o
consumidor final abre.

Não é defeito nosso e não muda nada nesta migração. Entra aqui porque é decisão
de produto que ninguém deve descobrir depois de vender o módulo — e porque
reforça a regra que já estava na função: **a descrição da cobrança não carrega
dado de ninguém.** Não vale acrescentar dado do comprador a uma página que já
expõe o do vendedor.

### 6.9 Sondas A e B — a medição de link EXPIRADO, em duas execuções

A única forma de obter um link genuinamente expirado é criá-lo com `endDate` de
hoje e conferir depois da virada do dia. Isso não cabe numa execução, então são
duas — e `sonda-asaas-expiracao.mjs` (que mede DESATIVADO) não é reaproveitada,
de propósito.

| | quando | o que faz |
|---|---|---|
| **A** `npm run sonda:a-criar` | hoje, cedo | cria com `endDate` = hoje, grava id/URL/relógio em `.sonda-asaas/link-expiracao.json` (gitignored) |
| **B** `npm run sonda:b-conferir` | amanhã | lê o arquivo, mede **aquele** link **pela API**, remove no fim |

**A rodou em 11/09/2026, 08:04 local (12:04 UTC):**

```
POST /v3/paymentLinks (endDate=2026-09-11)  ->  HTTP 200
relógio do Asaas (header Date, UTC):            Fri, 11 Sep 2026 12:04:37 GMT
CRIADO  id uc21d65el566a7nq   endDate 2026-09-11   active:true  deleted:false
ACEITOU endDate de hoje: no relógio do Asaas ainda é hoje.
```

A pergunta do fuso ficou respondida de graça: às 08:04 local (09:04 em Brasília)
o Asaas **aceitou** `endDate` de hoje — lá também era 11/09. O relógio dele vem
do header `Date` da resposta, que é o relógio **dele**, não o da máquina.

**B ainda não mediu — e foi rodada hoje de propósito, para provar que se
recusa a medir cedo demais:**

```
######## 0. Autoteste: erro de VALOR não é expiração ########
    HTTP 400  ->  falha_de_chamada
      · O valor mínimo para cobranças via Boleto e Pix é R$ 5,00.
  ✓ erro de valor saiu como `falha_de_chamada`, não como expiração
    GET id inexistente -> HTTP 404 -> falha_de_chamada
  ✓ 404 saiu como `falha_de_chamada`, não como "expirou e removeu"

######## 1. Que dia é no Asaas? ########
    header Date (UTC): Fri, 11 Sep 2026 12:04:46 GMT
    dia em Brasília:   2026-09-11   (endDate do link: 2026-09-11)

######## 2. O link, pela API ########
    ->  ainda_no_prazo
✗ CEDO DEMAIS. Nada foi medido, e nada foi removido.
```

Três coisas que a B garante, e onde cada uma está provada:

- **não lê HTML.** O veredito sai do que a API diz do objeto (`active`,
  `deleted`) depois da virada, comparado campo a campo com o que a A gravou —
  se a expiração se manifestar num campo que eu não conheço, ele aparece na
  lista "campos que mudaram". O que "aceita" e "recusa" **significam** pela API
  está escrito em `classificarLinkDepoisDoPrazo`, inclusive a cadeia
  *inativo ⇒ recusa na página*, medida em 10/09;
- **separa as três coisas** — `expirou_recusa`, `expirou_aceita`,
  `falha_de_chamada` — e prova que separa nos dois lugares: sem rede, na suíte
  (`teste:asaas-classificacao` §3b, 42/42), e com rede, no §0 dela mesma,
  forçando um erro de valor contra o Asaas de verdade antes de opinar;
- **o relógio é o do Asaas, convertido para Brasília.** Entre 21h e 00h de
  Brasília o UTC já está no dia seguinte; sem converter, a B diria "virou" sem
  ter virado e chamaria um link válido de "aceita depois de expirar". O caso
  está na suíte (02:00Z do dia 12 → `ainda_no_prazo`).

**O que muda no desenho conforme a resposta de amanhã:**

| se a B disser… | então |
|---|---|
| **`expirou_recusa`** | o descompasso entre a nossa janela (minutos) e a do Asaas (fim do dia) é inofensivo: no pior caso o link vale até 23:59 do dia, e depois disso o Asaas mesmo o fecha. "Pagamento chegou para pedido expirado" volta a ser **caso raro** — a corrida de quem pagou no último minuto da nossa janela. Desativar ao fim da janela vira redundância barata |
| **`expirou_aceita`** | **deixa de ser caso de borda.** Nada do lado do Asaas fecha o link, nunca. A diferença entre a nossa janela e a vida do link passa a ser de **horas ou dias, todo dia**, e "pagamento chegou para pedido expirado" vira **caminho central** — o `fora_do_prazo` da 61 passa a ser o que acontece com todo cliente que demora. Desativar ao fim da janela (`PUT active=false`, que a sonda de 10/09 provou funcionar) deixa de ser opcional e vira a única defesa |

*(veredito da B: pendente — rodar em 12/09 depois das 00:00 de Brasília)*

### 6.10 Sonda C — subconta no sandbox: **BLOQUEADA no cadastro da conta raiz**

`npm run sonda:c-subconta`, rodada em 11/09/2026, 15:47 local. Ela recusa
qualquer chave que não seja de sandbox — em produção a primeira subconta via API
inicia o prazo regulatório de 60 dias, e essa decisão não é dela.

**Medição 1 — a criação passa com a conta raiz atual? NÃO.**

Antes de tentar, ela pergunta ao Asaas quem é a raiz:

```
GET /v3/myAccount -> personType=FISICA  companyType=null  documento com 11 dígitos
```

E a tentativa, com CNPJ sintético válido, `companyType=MEI`, CEP real:

```
POST /v3/accounts -> HTTP 403
  · Contas de pessoa física (CPF) não podem criar subcontas no Asaas. Apenas
    contas de pessoa jurídica (CNPJ) podem acessar essa funcionalidade.
```

**A conta sandbox foi aberta como pessoa física.** O bloqueio é de cadastro, não
de código — exatamente o caso que o enunciado mandou parar e relatar. A resposta
vem em `message` (não em `errors[]`), e a primeira leitura da sonda a chamou de
`autenticacao`: errado, a chave vale, a **conta** é que não pode. O classificador
ganhou a classe `permissao` para 403 com mensagem, a frase real virou fixture, e
`teste:asaas-classificacao` afirma que ela **não** sai como autenticação nem como
pendência de documentação (55/55).

**Medições 2, 3 e 4 — NÃO MEDIDAS.** Sem subconta não há `walletId`, não há
`apiKey` de subconta e não há cobrança para tentar. Não há aproximação escrita
como se fosse medição: o arquivo `.sonda-asaas/subconta.json` registra
`medicoes_2_3_4: "NÃO MEDIDAS"`.

**O que destrava, e não é meu.** No painel do sandbox (*Minha conta →
Informações → Dados comerciais*) existe o seletor **"Tipo da conta: Pessoa Física
/ Pessoa Jurídica"**. A situação cadastral está `Aprovado` nas três etapas. Virar
PJ exige um CNPJ e os dados da empresa, e reabre a aprovação — é cadastro do
titular, decisão sua, e eu não toquei. Depois disso a sonda C roda de novo sem
mudança nenhuma; ela já está escrita para as três medições que faltaram:

| medição | o que a sonda faz quando a criação passar |
|---|---|
| 2 — `walletId` e `apiKey` | grava os dois **no ato** (a doc diz que `apiKey` só vem na criação e não se recupera), no arquivo gitignored; a chave nunca sai impressa |
| 3 — a subconta já cobra? | cria um link **com a chave da subconta**; `classificarCobrancaDaSubconta` separa `ok` / `pendencia_cadastro` / `falha_de_chamada` / `permissao` |
| 3, autoteste | força um link de R$ 1,00 com a chave da subconta e exige `falha_de_chamada`, não pendência — provado sem rede na §3c do teste |
| efeito, dos dois lados | `GET` do link com a chave da subconta → 200; com a chave da **raiz** → 404. E o espelho: um link da raiz lido com a chave da subconta → 404 |
| 4 — campos não pedidos | lista todo campo da resposta fora da lista da doc, em vez de ignorar |

**O que isto força no desenho, já escrito na 61 e reafirmado aqui:** com
subconta, **cada tenant tem chave própria**. A ferramenta de gerar link usa a
chave **do tenant**, lida de `tenant_credenciais.asaas_api_key_sandbox` /
`_producao` por `api_n8n_credencial_asaas` — nunca uma chave global de ambiente.
As colunas já existem; nenhuma foi criada.

**Segurança.** A varredura da §5 de `teste:asaas-classificacao` passou a cobrir
**também** a `apiKey` de subconta gravada em `.sonda-asaas/subconta.json`, quando
existir — hoje não existe, e o teste diz quantas chaves varreu (`1 chave(s): a
raiz`). O quase-vazamento de ontem é o motivo.

**O que muda conforme a resposta, quando a raiz for PJ:**

| se a subconta… | então |
|---|---|
| nasce **operando** (link criado com a chave dela) | o teste do agente com subconta é viável na hora: contratar `pagamento` para o `estudyou-sendbox`, pôr a `apiKey` da subconta em `asaas_api_key_sandbox`, e a ferramenta de gerar link (trabalho separado) já tem tudo de que precisa |
| nasce **pendente de documentação** | o teste do agente está **bloqueado** até a aprovação, e o fluxo de onboarding de cliente ganha uma etapa que hoje não existe no painel: "subconta criada, aguardando documentação". Vira item da §8 (telas) |
| a criação passa mas **sem `apiKey`** na resposta | não há como a subconta cobrar por API — a sonda para ali e diz isso |

*(estado em 11/09: bloqueado em 1 — aguardando a conta raiz virar PJ)*

---

## 7. O piso de R$ 5,00 — regra do sistema, não detalhe da sonda

**Pix e boleto no Asaas têm valor mínimo de R$ 5,00.** Não foi lido em
documentação: foi o sandbox recusando, com essa frase.

### 7.1 Quanto isso morde, medido em produção

| | |
|---|---|
| dos **14 pedidos** já feitos | **nenhum** ficaria abaixo do mínimo |
| menor do `emporio` | R$ 12,00 · média R$ 32,36 |
| menor do `sendbox` | R$ 69,90 |
| **mas** | **3 dos 41 produtos do `emporio` custam menos de R$ 5,00** |
| e o pão de queijo | R$ 1,50 — **dois dão R$ 3,00 e não podem ser cobrados** |

Improvável não é impossível, e é o caso que aparece quando ninguém previu.

### 7.2 É COLUNA, não constante

`tenants.pagamento_minimo_centavos`, default 500, agência-only pela mesma lista
branca do `tenants_guard_colunas`.

É número de **terceiro** e pode mudar quando o Asaas quiser. Cravado em código
vira `S = 622`: medido certo num dia, silenciosamente errado depois, e sem
ninguém para ligar "o provedor mudou a regra" a "o número no código
envelheceu". Aqui muda sem deploy.

Por tenant, e não global, porque é onde as outras configurações de pagamento já
moram — e porque no dia em que o provedor for outro para um cliente, o piso é
dele.

O teste mede os dois lados: **sem ser super_admin, mudar o piso é recusado com
`42501`**; como super_admin, baixá-lo para R$ 1,00 faz o mesmo pedido de R$ 3,00
passar. Configuração que não muda nada não seria configuração.

### 7.3 O comportamento abaixo do mínimo: **cair para o fluxo manual**

O agente **não** vai pedir para o cliente comprar mais. A escolha, e o porquê:

1. **é o fluxo que existe e funciona hoje** para 100% das vendas — o atendente
   passa a chave Pix. Esta fase inteira é aditiva, não substitui nada; quando o
   link não pode existir, a venda continua pelo caminho de sempre;
2. **o piso é problema NOSSO, não do cliente final.** Fazer alguém comprar mais
   para satisfazer o processador da agência é o tipo de coisa que se lê como
   manipulação, e a diferença entre "quer levar mais um?" e "você precisa levar
   mais um" desaparece na conversa;
3. **é a MESMA saída que a recusa por TETO já tem.** `vendas-tetos-e-provedor.md`
   decidiu que cobrança acima do teto não vira erro: o pedido fica preservado e o
   fluxo cai em `transferir_humano`. Usar a mesma porta para o piso mantém **um**
   caminho de exceção em vez de dois, e o princípio é literalmente o mesmo — "a
   recusa é conversa, não exceção".

**O agente não descobre isso por erro da ferramenta.**
`api_n8n_gerar_cobranca` devolve `motivo = 'abaixo_do_minimo'` com
`minimo_centavos` e `faltam_centavos` — informação que o modelo sabe tratar.
O 400 cru do Asaas nunca chega a ele: pedir para o modelo improvisar em cima de
erro de integração é o comportamento que o portão existe para conter.

`faltam_centavos` viaja junto para quem quiser, um dia, **oferecer** completar o
pedido. Oferecer não é a saída escolhida — mas o número estar lá custa zero e
tirá-lo depois custa uma migração.

> A tool do n8n que consome isso **não foi escrita** (a ordem manda esperar a
> sonda). O que está pronto e testado é o lado do banco: a recusa, o motivo, e a
> prova de que nenhuma cobrança é criada quando ela acontece.

---

## 8. O custo no painel — listado agora, não construído

Toda primitiva desta migração vira tela. Nada disto foi construído; está aqui
porque decisão de produto que aparece depois vira retrabalho.

| superfície | onde | quem vê | decisão em aberto |
|---|---|---|---|
| **Credencial do Asaas por tenant** | admin → cliente → *Integrações* | **agência**, nunca o cliente | é chave de subconta dele, mas quem responde pelo contrato somos nós — segue o padrão do token do Chatwoot (`tenant_credenciais`, super-only) |
| **Seletor de ambiente** (sandbox/produção) | mesma tela | agência | precisa de confirmação explícita ao virar para produção: é o momento em que dinheiro passa a ser real |
| **Janela de expiração** (`pagamento_expira_minutos`) | painel do cliente → *Configurações* **ou** admin | **decisão em aberto.** Hoje nasce agência-only pelo guard | é operacional (a padaria sabe o prazo dela) mas mexe em cobrança. Se virar cliente-editável, é mexer na lista branca do `tenants_guard_colunas`, em migração própria |
| **Status de pagamento no pedido** | `/painel/pedidos` e `/painel/pedidos/[id]` | cliente | mostrar link, `expira_em` e `pago_em`; e o que fazer com `fora_do_prazo_em`, que precisa de ação humana |
| **Visão do que foi pago e do que não foi** | `/painel/pedidos` com filtro, ou tela própria | cliente | filtro numa lista que já existe é bem mais barato que tela nova — decidir antes de construir |
| **Fila de "pagou fora do prazo"** | tela própria, agência **e** cliente | os dois | é a única superfície que exige ação: dinheiro retido, pedido não reaberto. Sem ela, `fora_do_prazo_em` é uma coluna que ninguém lê |
| **Ícone no menu** | `src/components/sidebar.tsx` | — | só se houver rota nova |

**Todas obedecem à regra de superfície de tool** (`CLAUDE.md`): só existem para
quem contratou `pagamento`, a checagem vai em **cada** Server Action, e
`teste:superficie` reprova rota sob `/painel/` sem dono. E `pedido_cobrancas` +
`pagamento_eventos` entram em `SUPERFICIE_DE_DADO` quando a tool tiver tela —
descontratar esconde, nunca apaga.

---

## 9. O que **não** foi feito, e por quê

- **passo 0 não executado** — importar workflow e repontar o webhook do Chatwoot
  são atos na instância, fora do autorizado. Tudo abaixo dele está entregue mas
  **gated**: medir pagamento antes de provar o roteamento mede outra coisa;
- **sonda do Asaas não rodada** — não há credencial neste ambiente;
- **`n8n/workflows/agente-principal.json` não tocado**, conforme instruído. Ver
  §9;
- **sub-workflow da tool de pagamento não escrito** — ele nasce do repo, é
  gerado, e daí é copiado para o workflow de teste; escrevê-lo antes do passo 0 e
  antes da sonda seria construir sobre duas incógnitas. As funções de banco que
  ele vai chamar estão prontas e testadas;
- **telas do painel não construídas** (§7 lista o que serão);
- **sem estorno automático**, sem tocar no `emporio`, sem credencial de produção,
  sem `$fromAI` em nada.

---

## 10. Os dois vermelhos da suíte são o estado CORRETO. **Não os feche.**

```
teste:migracao-portao  FALHA toda coluna que o portao LE vem na query do no
                             — faltam: pagamento_confirmado
teste:portao-venda     FALHA jsCode do no == n8n/aplica-portao.js
```

`n8n/aplica-portao.js` ganhou a regra 3 e lê `estado.pagamento_confirmado`. A
cópia dentro do `agente-principal.json` não.

### O comando que "fecha os dois" é uma armadilha, e eu a ofereci na entrega anterior

Sugeri `node scripts/aplicar-portao-venda.mjs` como se fosse limpeza pendente.
**Estava errado, e o erro é da mesma família que este projeto já catalogou como
caso dez.**

O injetor **deriva** a lista de colunas da query do nó a partir de
`estado.<campo>` no corpo do portão. Rodá-lo agora faria a query passar a pedir
`pagamento_confirmado` — **coluna que só existe depois da migração 61, que não
está aplicada.** Importado nesse estado, o `Estado do Pedido` responderia
`42703`, e ele está no **caminho único**: não seria o portão ficar mudo, seria
**o agente parar de responder para todos os tenants**.

É exatamente o defeito de 09/09 reintroduzido por outra porta — a porta de
"fechar dois vermelhos com um comando".

### A ordem, e ela não é negociável

1. aplicar a migração 61;
2. **só então** `node scripts/aplicar-portao-venda.mjs`;
3. e o import do workflow depois disso, com o passo 0 já provado.

Entre 1 e 2 os dois vermelhos **têm de ficar vermelhos**. Eles não são sujeira
no repositório: são o relatório correto de que a fonte andou à frente do
derivado e de que o banco ainda não suporta o derivado novo.

### ATUALIZAÇÃO 10/09, depois de a 61 entrar: a guarda deixou de segurar

**Com a 61 aplicada, `api_n8n_estado_pedido` em produção já declara
`pagamento_confirmado`.** A condição que fazia o injetor abortar está satisfeita
— ele não vai mais parar ninguém.

Então o que separa o repositório da injeção agora é **só a autorização**, não uma
trava. Os dois vermelhos continuam sendo o estado correto pelo outro motivo: o nó
não foi tocado porque tocar no `agente-principal.json` não foi autorizado, e
importar o workflow também não.

A ordem que sobra é: **injetar** (um comando, escreve só o arquivo do repo) e
**importar** (na instância, depois do passo 0 provado). As duas continuam
esperando você.

### A regra é máquina, não nota de rodapé — e foi ela que segurou até agora

Uma advertência em documento não impede ninguém de rodar um comando. Então o
próprio injetor passou a se recusar: ele **consulta produção** e compara com o
que o portão lê. Rodado ANTES da 61, ele parava antes de escrever qualquer
coisa —

```
colunas declaradas vem de 20260910230000_61_pagamento_asaas_sandbox.sql

ABORTADO: o portao le coluna que PRODUCAO ainda nao tem:
   - estado.pagamento_confirmado
  producao declara: tem_pedido, pedido_id, pedido_status, ...
  Injetar agora gravaria uma query que responde 42703 no CAMINHO UNICO —
  o agente pararia de responder para TODO tenant, nao so o portao.
```

Duas correções entraram junto, e as duas eram deriva da mesma família:

- ele conferia contra o **arquivo da migração 56**, cravado. A 61 mexeu na mesma
  função e o cravado passou a descrever um mundo velho — agora ele procura a
  migração **mais recente** que declara `api_n8n_estado_pedido`;
- conferir contra o arquivo nunca foi suficiente: **o arquivo declara, produção é
  que tem.** São perguntas diferentes e as duas são feitas.

Sem `SUPABASE_DB_URL` ele **aborta** em vez de pular a checagem. A assimetria
decide: um aborto injusto custa rodar de novo com a URL; um "pulei e segui" custa
o agente mudo para todos os clientes.

> **Para quem vier depois:** a guarda protege contra injetar coluna que o banco
> não tem. Ela **não** protege contra injetar sem querer — isso continua sendo
> decisão de gente. Confira se o passo 0 está provado antes de importar o que
> sair dela.

`tests/portao-pagamento.mjs` roda contra o **arquivo**, então a regra 3 tem 43
asserções de cobertura independentes desse passo. Os dois testes são os dois
lados do par derivado, e é justamente por serem dois que dá para deixar um
vermelho de propósito sem ficar sem medição.

---

## 11. As duas peças no n8n: gerar o link, e o webhook que confirma

**Escritas em 11/09. NÃO importadas, e não podem ser enquanto o experimento da
fusão não fechar** — as 10 conversas medem 6 ferramentas; uma sétima muda o que o
modelo vê e a medição deixa de medir. Importar é depois, na ordem da §11.6.

| peça | artefato | fonte | teste |
|---|---|---|---|
| a ferramenta | `n8n/workflows/tool-gerar-link-pagamento.json` | `n8n/tool-pagamento-fonte.mjs` + `n8n/tool-pagamento-resposta.js`, gerado por `scripts/gerar-tool-pagamento.mjs` | `teste:tool-pagamento` 75/75 |
| o webhook | `n8n/workflows/webhook-pagamento-asaas.json` (`POST /asaas-pagamento-sandbox`) | `n8n/webhook-pagamento-extrai.js`, gerado por `scripts/gerar-webhook-pagamento.mjs` | idem |
| o principal | **inalterado no repo** (é o artefato do experimento). Com a ferramenta: `GERAR_COM_PAGAMENTO=1 node scripts/gerar-principal.mjs`, e só depois de o sub-workflow ter id | — | o teste dispara o gerador com a flag e exige que ele **aborte** (id ainda é placeholder) e deixe o arquivo intocado |

### 11.1 Decisão: ferramenta separada, não sexta ação da fundida

Acabamos de reduzir de 8 para 6 de propósito, e uma ferramenta nova devolve uma.
Mesmo assim é separada, por três motivos que não são de gosto:

1. **Contrato.** `pagamento` é uma linha própria de `catalogo_tools` (61). A
   fundida checa `vendas` no `Busca Config`; uma sexta ação teria de checar
   `pagamento` num segundo nó do mesmo sub-workflow, e a `description` da fundida
   anunciaria uma ação que um tenant com vendas-sem-pagamento não tem — o modelo
   chamaria e receberia "indisponível". Uma tool = um contrato é a regra de
   superfície do `CLAUDE.md`.
2. **O experimento.** A `description` da fundida é a variável medida. Engordá-la
   depois contaminaria qualquer comparação futura: "a fabricação mudou porque são
   menos tools ou porque a description mudou?" deixaria de ter resposta.
3. **Dinheiro atrás de `$fromAI('acao')`.** A nota da fatia 2 temia `fechar` em
   "quanto ficou?". Gerar cobrança atrás do mesmo parâmetro que `ver` é o mesmo
   risco com dinheiro em cima. Ferramenta própria carrega condição própria, e o
   modelo escolhe a **ferramenta**, não um valor de string.

O preço: 7 ferramentas em vez de 6, e `S` sobe de **778 para 938** (802 chars de
schema a mais, pela mesma calibração da §8 da fusão — estimativa, `medido:
false`).

### 11.2 A ferramenta: o que o modelo não controla

- **Zero propriedades no schema.** Entradas são só `tenant_id` e
  `conversation_id`, do fluxo. Não há `$fromAI` — o gerador **aborta** se
  encontrar um, e o teste também.
- **O valor é do banco.** `Reserva Cobranca` chama
  `api_n8n_gerar_cobranca($1, $2)` e o teste afirma que a query tem dois
  argumentos e nenhum `$3`.
- **A chave é a do tenant.** Vem na linha da reserva (`api_key`, `base_url`
  derivada do `asaas_ambiente`) e vai para o header do nó HTTP por expressão. Não
  há credencial do n8n para o Asaas — credencial do n8n é uma por instância, a
  chave é uma por tenant. **Consequência:** a chave passa pelos dados de execução
  da instância (§11.4).
- `tool_ativa` primeiro (`Busca Config → Pagamento Ativa?`), e
  `api_n8n_gerar_cobranca` confere de novo por dentro.
- `dueDateLimitDays = 1` e o piso de R$ 5,00 — os dois achados da sonda A. O piso
  vem de `tenants.pagamento_minimo_centavos`, dentro da função.
- A conversão centavos → decimal acontece **uma** vez, no corpo do nó HTTP, na
  fronteira com o Asaas.
- O Asaas fora do ar não derruba a execução: `onError` no HTTP, o ramo de falha
  registra em `pedido_cobrancas.falhou_em` e o modelo recebe *"NÃO invente um
  link. Transfira."*

**O texto que volta ao modelo é escrito em código** (`tool-pagamento-resposta.js`),
por caso — e o teste roda o corpo **do JSON** contra cada um:

| caso | o que o modelo recebe |
|---|---|
| ok | a URL **crua, sozinha numa linha**; *"mande EXATAMENTE essa URL, sem encurtar e sem texto clicável"*; a hora de validade em Brasília; e a única frase sobre o futuro: *"NÃO afirme que o pagamento foi feito: o sistema avisa quando cair"* |
| reuso | a mesma URL, dizendo que é o mesmo link |
| `abaixo_do_minimo` | quanto falta e o piso; *"sugira completar o pedido"*; atendente **só se o cliente não quiser**. Nunca o 400 cru |
| `sem_pedido_fechado` / `ja_pago` / `total_zero` / `tool_inativa` | frase própria, sem inventar link |
| falha do Asaas | *"NÃO invente um link"*, sem URL nenhuma no texto |

> **Isto muda a decisão da §7.3.** Lá a saída escolhida era cair direto para o
> fluxo manual. O enunciado desta rodada decidiu diferente — sugerir completar
> primeiro, atendente só se o cliente não quiser — e é isso que está no texto e
> no teste. A §7.3 fica como registro da decisão anterior; a vigente é esta.

### 11.3 O webhook

```
Webhook (POST /asaas-pagamento-sandbox)
  -> Extrai Evento          token do header, ids, valor em centavos — e NADA do pagador
  -> Aplica Webhook         api_n8n_pagamento_webhook: a ÚNICA que escreve `pago`
  -> Responde 200           SEMPRE, com o estado, ANTES de qualquer HTTP para fora
       -> Aplicou?        sim -> Credencial Chatwoot -> Notifica Cliente -> Confirma Notificado
       -> Precisa Humano? sim -> Credencial (humano) -> Nota Privada Fora do Prazo
```

- **Origem validada** por `asaas_webhook_token_sandbox`, no banco. Token errado
  → `reconhecido=false`, nenhum efeito, nenhum evento gravado — afirmado no teste
  com um token forjado.
- **Idempotência pelo efeito**, dos dois lados: o mesmo evento reenviado dá
  `ja_processado` e o md5 do retrato (pedidos + cobranças + eventos) é idêntico;
  a sabotagem S2 troca o `evento_id` por `Date.now()` e o retrato **acusa** — e o
  pedido continua pago **uma** vez, porque a camada 2 (estado) segura mesmo
  quando a camada 1 (evento) é burlada.
- **Só o webhook muda `pedidos.status` para `pago`.** A varredura de
  `teste:pagamento-asaas` §4 continua valendo: uma função, e ela pede o token.
- **Responde 200 sempre**, com só o estado (`reconhecido`, `ja_processado`,
  `aplicou`, `motivo`) — sem tenant, conversa nem valor, porque quem chamou pode
  não ser o Asaas. 15 falhas consecutivas interrompem a fila; 401 a um forjador
  não protege nada, e 401 ao Asaas de verdade por um token mal configurado nosso
  derrubaria a fila.
- **Fora do prazo**: a função não reabre, retém o `pagamento_id`, devolve
  `precisa_humano`; o webhook manda **nota privada** ao atendente — *"o pedido
  NÃO foi reaberto; decida: entregar e reabrir à mão, ou estornar"*.

### 11.4 A armadilha da notificação, e a verificação de cinco minutos

A notificação sai pelo **mesmo caminho** do `Envia Mensagem Chatwoot` do
principal: `api_n8n_credencial_chatwoot` (token de Agent Bot), mesmo endpoint,
`message_type: 'outgoing'`, `private: false`. É isso que faz o `Roteia Evento`
ver `sender.type = 'agent_bot'` no webhook de volta e cair no fallback — sem
pausar. `tests/notificacao-nao-pausa.mjs` prova a regra lendo o switch do JSON.

**O que ele não prova, e precisa ser verificado na instância antes de importar
o webhook:** que o Chatwoot carimba `agent_bot` para *o nosso* token. Cinco
minutos:

1. com o principal já importado, mande pela API do Chatwoot uma mensagem
   `outgoing` na conversa 1864 do sendbox usando o token que
   `api_n8n_credencial_chatwoot` devolve (é o mesmo que o webhook usará);
2. `select status, motivo_pausa from conversas where conversation_id = 1864` —
   tem de continuar **sem pausa**;
3. e a execução do principal disparada por esse webhook tem de ter caído no
   fallback do `Roteia Evento` (nenhuma saída).

Se pausar, o token não é de Agent Bot, e o webhook **não pode** ser importado
até isso mudar.

**Um custo que fica escrito:** a chave do Asaas do tenant viaja no item do n8n
até o nó HTTP, então ela **fica nos dados de execução da instância** enquanto a
retenção de execuções guardar aquela run. Não há como redigir dado de execução
no n8n. O que dá para fazer é configurar a retenção do workflow de pagamento
para não salvar execuções bem-sucedidas (*Settings → Save successful
executions: off*), e isso é passo do import, anotado na §11.6.

### 11.5 Pendente da sonda B: a política de expiração

`n8n/tool-pagamento-fonte.mjs` tem `POLITICA_EXPIRACAO = null`. O gerador do
webhook lê daí e **não liga nenhum passo de desativação** enquanto for `null`; o
teste afirma que o JSON do webhook não contém `active: false`.

| se a B disser… | a política vira | e o que muda |
|---|---|---|
| `expirou_recusa` | `'expirou_recusa'` | descompasso inofensivo; fora do prazo é a corrida do último minuto; desativar ao fim da janela é redundância barata — pode ficar sem |
| `expirou_aceita` | `'expirou_aceita'` | a diferença é de horas todo dia; **desativar o link (`PUT active=false`) ao fim da nossa janela deixa de ser opcional**, e vira passo próprio — quem dispara (preguiçoso ou agendado) é decisão a tomar |

Nos dois: pedido expirado que recebe pagamento **não reabre sozinho** — já está
na função da 61 e na nota privada do webhook.

### 11.6 Ordem de import — depois das 10 conversas

1. terminar o experimento da fusão e registrar o resultado;
2. importar `tool-gerar-link-pagamento.json` como workflow **novo**; anotar o id
   em `ID_WORKFLOW` (`n8n/tool-pagamento-fonte.mjs`);
3. `GERAR_COM_PAGAMENTO=1 node scripts/gerar-principal.mjs` — só agora ele
   aceita; importar o principal por cima;
4. fazer a verificação de cinco minutos da §11.4; se pausar, parar;
5. importar `webhook-pagamento-asaas.json`, ativar, desligar *Save successful
   executions*, copiar a URL de produção;
6. no Asaas sandbox, cadastrar o webhook com essa URL e o mesmo token gravado em
   `asaas_webhook_token_sandbox` do tenant; eventos `PAYMENT_RECEIVED` e
   `PAYMENT_CONFIRMED`;
7. contratar `pagamento` para o `estudyou-sendbox` e pôr a chave em
   `asaas_api_key_sandbox` — **a chave da raiz, enquanto a subconta estiver
   bloqueada (§6.10)**. A ferramenta não sabe a diferença: lê a chave do tenant.
