# Pagamento via Asaas — fase de sandbox

**Nada aplicado, nada importado.** Migração 61 escrita e testada, não aplicada;
workflows escritos, não importados; nenhuma credencial de Asaas em lugar nenhum.

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
| 1 | `supabase/migrations/20260910230000_61_pagamento_asaas_sandbox.sql` + rollback | **não aplicada**; `teste:pagamento-asaas` 84/84 |
| 2 | regra 3 do portão em `n8n/aplica-portao.js` | escrita; `teste:portao-pagamento` 43/43 |
| 3 | `tests/notificacao-nao-pausa.mjs` | 17/17 |
| 4 | `scripts/sonda-asaas-expiracao.mjs` (`npm run sonda:asaas-expiracao`) | escrita; **não rodou** — não há credencial |

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

**Ela não diz, e eu não testei.** Não há credencial de Asaas neste ambiente —
`.env.local` não tem nenhuma. A sonda está escrita
(`scripts/sonda-asaas-expiracao.mjs`), recusa chave que não tenha forma de chave
do Asaas, aponta só para o host de sandbox, e limpa o objeto que cria. Ela não
entra na suíte de propósito: fala com serviço externo e custa objeto lá.

### A consequência: `endDate` não alinha uma janela de 30 minutos

O enunciado pedia *"o link nasce com vencimento alinhado à janela do tenant, para
que os dois expirem juntos"*. **Com granularidade de dia, isso não cabe no
campo.** O que foi feito:

- a autoridade sobre o prazo é **nossa** e mora em `pedido_cobrancas.expira_em`,
  com precisão de segundo, calculada de `tenants.pagamento_expira_minutos`;
- o `endDate` vai para o **dia** da expiração — teto grosseiro, não alinhamento;
- o alinhamento fino seria um `PUT active=false` na hora em que nossa janela
  vence. **Não está feito**, e não por esquecimento: depende da sonda (desativar
  um link cujo comportamento não conhecemos é trocar um desconhecido por outro),
  e a decisão de quando disparar — preguiçoso, como a expiração de pedido, ou
  agendado — não está tomada.

**Consequência que precisa estar escrita: enquanto isso, o link continua pagável
depois de a nossa janela fechar.** Não é defeito da migração, é o estado de
fato — e é exatamente o que o caminho `fora_do_prazo` trata.

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

## 6. O que a sonda tem de responder, e o que muda conforme a resposta

Rode `ASAAS_SANDBOX_KEY='$aact_...' npm run sonda:asaas-expiracao` e escreva o
resultado **aqui**.

| se… | então |
|---|---|
| o link **expira** sozinho de forma confiável | `fora_do_prazo` vira caso raro de corrida (o cliente pagou no segundo 29:58), e o alinhamento por `active=false` é opcional |
| o link **não expira** | `fora_do_prazo` é o caminho **normal** de todo cliente que demora, e desativar o link ao fim da nossa janela deixa de ser opcional — vira trabalho próprio: quem dispara, quando, e o que responder |

*(resultado: pendente — não há credencial)*

---

## 7. O custo no painel — listado agora, não construído

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

## 8. O que **não** foi feito, e por quê

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

## 9. Os dois vermelhos da suíte, e qual lado está certo

`npm run teste`: **60 de 62**. Os dois vermelhos são **o mesmo fato**, e ele é
verdadeiro:

```
teste:migracao-portao  FALHA toda coluna que o portao LE vem na query do no
                             — faltam: pagamento_confirmado
teste:portao-venda     FALHA jsCode do no == n8n/aplica-portao.js
                             — arquivo 24526 chars, no 16911
```

`n8n/aplica-portao.js` ganhou a regra 3; a cópia dentro do
`agente-principal.json` não, porque tocar naquele arquivo não estava autorizado.

**Qual lado está certo: o arquivo.** Ele é a fonte declarada — o cabeçalho do
próprio `aplica-portao.js` diz isso, e a cópia no JSON é injetada.

E vale notar **como** o primeiro vermelho apareceu: ninguém escreveu a asserção
"a query precisa de `pagamento_confirmado`". O injetor **deriva** a lista de
colunas de `estado.<campo>` no corpo do portão, e o teste executa a query do nó
contra a função real. É a máquina do caso dez do `CLAUDE.md` funcionando —
derivar o derivado em vez de escrever a asserção, executar em vez de comparar
texto.

**Um comando os fecha**, quando houver autorização:

```bash
node scripts/aplicar-portao-venda.mjs
```

Ele escreve só o arquivo do repo — importar continua sendo passo humano e
separado. Enquanto ele não roda, os dois vermelhos são o relatório correto do
estado: **o nó carrega código mais velho que a fonte.**

`tests/portao-pagamento.mjs` roda contra o **arquivo**, então a regra 3 tem
cobertura desde já, independente desse passo. Os dois testes são os dois lados do
par derivado, e nenhum sozinho basta.
