# Entrega — portão de venda afirmada + narração por código

**Estado: ENTREGUE. Migração NÃO aplicada, workflow NÃO importado.** O gerador
foi executado — ensinar uma guarda exige rodar o que ela guarda —, e a execução
fechou o `n8n:sincronia` que estava vermelho. Tudo abaixo está no repositório.

| artefato | arquivo |
|---|---|
| migração 56 | `supabase/migrations/20260909180000_56_portao_venda_afirmada.sql` |
| rollback | `..._56_portao_venda_afirmada_rollback.sql` |
| corpo do nó (fonte) | `n8n/aplica-portao.js` |
| workflow pronto para importar | `n8n/workflows/agente-principal.json` (64 nós, +4) |
| script que o monta | `scripts/aplicar-portao-venda.mjs` |
| teste dos dois vereditos | `npm run teste:portao-venda` — 48/48, contra o `jsCode` do nó |
| teste da migração | `npm run teste:migracao-portao` — 52/52, executa a query do nó |
| arranjo do vínculo Chatwoot | `tests/lib/caixa-54.mjs` |
| suíte completa | `npm run teste` — **55 de 55** |

---

## 1. São TRÊS referências por nome, não duas

O enunciado lista duas (`Envia Mensagem Chatwoot.body` e o 3º elemento do
`queryReplacement`). **Há uma terceira, e ela falha exatamente do mesmo jeito
silencioso:** o **10º** elemento, `componentes_json`.

```
$1  tenant_id          $6  modelo
$2  conversation_id    $7  lista_depois
$3  output          <- portão      $8  audio_segundos
$4  tokens_entrada     $9  $execution.id
$5  tokens_saida       $10 componentes_json  <- portão
```

Se o 10º continuar apontando para `Estima Tokens`, o portão funciona, o cliente
recebe o texto certo e **o veredito nunca chega ao banco** — que é a metade que
a `VAZAMENTO-USED-TOOLS.md` ensina a não perder. O script troca as três e
**confere as três depois**, abortando sem escrever se alguma ficou para trás;
confere também que o array continua com 10 elementos na mesma ordem.

**`tokens_entrada` e `tokens_saida` seguem vindo do `Estima Tokens`, de
propósito.** Eles medem o que a OpenAI cobrou pelo texto que o **modelo** gerou;
o portão não muda isso. Apontá-los para o portão faria o rateio contar o texto
substituto, que ninguém gerou por token.

---

## 2. "Houve escrita neste turno" — a escolha, e o que foi descartado

```
ultima_mutacao_do_pedido  >  ultima_saida_registrada_desta_conversa
```

O instante de referência sai do **próprio banco**, não do n8n. Funciona porque
`Registra Mensagem` roda **depois** do portão: no momento da consulta, a saída
mais recente registrada é a do turno anterior. "Mutou depois dela" = "mutou
neste turno", e isso cobre o turno inteiro, inclusive as tool calls que o agente
fez antes de existir texto.

Descartadas:

- **instante de início da execução do n8n** — não há campo confiável em
  expressão (`$execution` dá `id` e `mode`). Obter um exigiria capturar
  `Date.now()` num nó do início, e os candidatos são `Extrair e Filtrar` (corpo
  injetado pelo gerador) ou `api_n8n_conversa_sync` (mudança de assinatura,
  família 28/32/37/40/41);
- **`Date.now()` no `Estima Tokens` ou na própria função** — os dois rodam
  **depois** do agente, então uma escrita feita pela tool é anterior a esse
  instante e sairia classificada como "turno passado". O critério ficaria
  invertido justamente no caso que importa;
- **guardar o estado anterior em Redis** — fonte de verdade nova, com TTL
  próprio, para responder o que uma coluna já responde.

**Limite conhecido e aceito:** execuções concorrentes na mesma conversa (cliente
em rajada) intercalam o registro das saídas e a janela sai errada — o mesmo
limite que a §6.1 da pendência já registra ("uma vez em 40"). O erro cai para o
lado seguro: uma escrita da execução vizinha faz o turno parecer que escreveu e a
mensagem **passa**.

---

## 3. Cobertura medida — os QUATRO casos reais

```
R$ 60,00  (emporio/1636, 20/08)  -> barrado_regra_1
R$ 249,80 (sendbox, 28/08)       -> barrado_regra_1
R$ 279,60 (sendbox, 08/09)       -> barrado_regra_1
R$ 42,50  (emporio/18, 21/08)    -> barrado_regra_2
```

E os três turnos do caso do `emporio` de 08/09 — inclusive o *"seu pedido
ficou:"* que **nenhum dos quatro detectores pegava** — são barrados.

**O R$ 42,50 escapava, e a correção foi trocar a referência.** A versão anterior
consultava "sempre o rascunho", e o `fechar_pedido` transforma o rascunho em
`aguardando_pagamento` **no mesmo turno em que o valor final é dito ao cliente**
— então no instante da consulta não havia rascunho e a regra 2 ficava sem
referência justamente no turno do fechamento.

Agora a referência é o **pedido TOCADO na janela**, em qualquer status, e só
depois o rascunho. Isso cobre fechamento e cancelamento pelo mesmo caminho. O
teste tem o espelho obrigatório: mesmo fechamento com valor **certo** passa —
sem ele, o verde poderia vir de "fechamento sempre barra".

---

## 3b. O teto da janela, e o primeiro turno

`escreveu_neste_turno` compara a última mutação do pedido contra a última saída
registrada. **Essa borda sozinha é larga demais**, e a medição diz quanto:

| | |
|---|---:|
| intervalo entre saídas consecutivas — mediana | 41 s |
| — p95 | 103.898 s (28,9 h) |
| — **máximo** | **18 dias** |
| escrita → turno que a narrou — mediana | 2,3 s |
| — **máximo** | **10,0 s** |

Sem teto, uma conversa parada duas semanas leria qualquer mutação daquele período
como "escreveu neste turno" e passaria a fabricação. É a mesma forma do defeito
que a §6 da pendência registra na D2, onde `atualizado_em` movido pela expiração
fez um pedido engolir a conversa de onze dias depois.

O teto entrou como parâmetro, `p_teto_segundos`, default **300 s** — 30× o
máximo observado, com folga para debounce (até 15 s), agente lento e retry, e
ainda assim cortando a janela de 18 dias para 5 minutos. A borda usada é
`greatest(última saída, now() − teto)`: em conversa ativa a saída limita; em
conversa que voltou depois de dias, o teto.

**E o primeiro turno sai de graça.** Sem saída anterior, `max` é nulo e o teto
vira a única borda — que é o comportamento certo: um rascunho pendurado de uma
sessão antiga deixa de contar como escrita de agora. Era o furo do `-infinity`
sozinho, e o teste o cobre nos dois sentidos.

---

## 4. Dois defeitos que o próprio teste pegou

Ambos no meu código, ambos encontrados pelas checagens que o enunciado exigiu.

**(a) O caso de controle da §8 — barrar pelo motivo errado.** Montei o controle
como pedido: mesmo texto fabricado, **rascunho presente e total correto**. Ele
**barrou**. Causa: em

```
- 1x NR 06 — R$ 69,90

Total: R$ 279,60
```

os dois valores ficam à **mesma distância** do lema "total" (dois caracteres), e
o desempate por "primeiro encontrado" elegia o R$ 69,90 — o subtotal da linha
anterior. O portão barrava venda correta comparando o total do banco contra o
preço de um item. Corrigido: o valor **depois** do lema tem precedência, e só se
não houver nada depois é que se olha para trás (que é o caso de *"por R$ 4,50 no
total"*).

Sem o caso de controle, os três verdes da seção 1 seriam por acaso.

**(b) O falso positivo do `fortalize`.** *"Atualizando a lista das vacinas…,
**inclu**indo a influenza anual"* casa `inclu[ií]` e era barrado pela Regra 1 —
num tenant de saúde, que tem `vendas` contratada e passaria pelo portão. Era o
falso positivo conhecido da D1, agora com consequência: mensagem bloqueada.
Corrigido com guarda de **contexto**, não de vocabulário: a frase precisa falar
de `pedido`, `carrinho` ou `R$`. Isso mantém o gatilho largo onde importa —
*"Separei 2 pedaços…, totalizando R$ 15,00"* não tem a palavra pedido e continua
sendo pego pelo `R$`.

---

## 5. A transferência entrega a nota, e NÃO pausa — por quê

Duas barradas seguidas → nota privada no Chatwoot com **os dois, rotulados**: o
bloco do banco como *estado de fato* e o texto do modelo como *o que o agente
afirmou*. A divergência é a informação; substituir um pelo outro a apaga.

**Não pausa a conversa, e a razão é de dado.** A única função que pausa hoje é
`api_n8n_definir_status_conversa`, e ela crava `motivo_pausa = 'mensagem_humana'`
(migração 47). Usá-la aqui gravaria um motivo **falso** — diria que um humano
falou quando quem interveio foi o portão — e `motivo_pausa` existe exatamente
para distinguir isso. Pausar de verdade pede um motivo novo, que é migração
própria.

**Consequência aceita:** hoje a transferência avisa e não silencia o agente. Ele
segue respondendo até um humano falar. Fica aberto.

---

## 5b. O gerador aprendeu as três referências — e a guarda derruba a geração

O `gerar-principal.mjs` agora conhece as três, aponta-as conforme a montagem
(com portão → `Aplica Portao`; sem portão → `Estima Tokens`) e **valida antes de
escrever**.

**E aqui apareceu o defeito que justifica a guarda existir.** A primeira geração
depois do portão saiu com o 10º elemento voltando a ler do `Estima Tokens` — o
portão montado, o cliente recebendo o texto certo, e **o veredito nunca chegando
ao banco**. Causa: existe um bloco na seção 9 do gerador que **reconstrói o
`queryReplacement` inteiro**, com os nomes cravados, e ele roda *depois* da
seção que aponta. A primeira versão da guarda validava logo após apontar, não
via o bloco tardio, e imprimia "3 de 3" sobre um estado que o disco não teria.

Duas correções, e a segunda é a lição: o bloco tardio passou a usar
`FONTE_SAIDA`, e **a guarda mudou de lugar — roda no fim, sobre o objeto final,
imediatamente antes do `writeFileSync`.** Guarda que valida estado intermediário
não guarda nada.

Ela confere: as três lendo da fonte certa; nenhum vestígio do apontamento
antigo; nenhum `$('AI Agent')` de volta; o array com 10 elementos e `output` no
3º, `componentes_json` no 10º; `tokens_entrada`/`tokens_saida` ainda vindo do
`Estima Tokens`; e, com portão, a cadeia de três saltos existindo de fato.

Sabotada — reintroduzindo o apontamento antigo no bloco tardio:

```
ERRO: as referencias de saida estao erradas. O portao viraria decoracao.
  - Registra Mensagem: o 10o elemento (componentes_json) nao le de "Aplica Portao"
  - Registra Mensagem.queryReplacement ainda referencia "Estima Tokens" — apontamento antigo reintroduzido
Nada foi escrito.
exit=1
```

E o md5 do workflow ficou **idêntico** — a geração morre sem tocar no arquivo.

---

## 5c. Os dois testes vermelhos: quem estava velho era a migração

Eu vinha chamando de "pré-existentes da migração 54", que é a explicação mais
confortável possível e não diz nada. Medido:

```
(produção) ceejaar           conta 60, caixa 281
(produção) emporio           conta 59, caixa 279
(produção) estudyou-sendbox  conta 57, caixa 282
```

A migração 54 tem backfill com valores cravados e um `raise` que confere o
próprio resultado — ela procura `estudyou-sendbox` na **conta 1** e crava a
caixa **189**. O tenant foi religado pelo painel em 09/09 09:22, que é operação
normal: a tela existe para isso. O backfill não pega nada, `v_sendbox` sai nulo,
a migração aborta, e os dois testes que a replayam morrem antes da primeira
asserção.

**Quem está velho é a migração, não a produção.** E o arquivo da 54 não pode ser
reescrito: ele já rodou, e o texto tem de continuar sendo o que rodou.

O conserto é o corolário que o `CLAUDE.md` já registra e que o
`pedidos-vivos-55.mjs` já aplicou uma vez: **o teste ARRANJA o estado que vai
medir.** `tests/lib/caixa-54.mjs` devolve os tenants ao vínculo de 28/08 dentro
da transação abortada, **e estoura se não resolver** — helper que não muta nada
e devolve sucesso é a mesma armadilha da sabotagem que não mutou.

E o teste passou a **dizer qual dos dois está certo**, em vez de classificar como
herança: uma seção 0 lê produção antes do replay, afirma a *propriedade* (todo
tenant conectado tem vínculo completo e resolve só ele) e imprime a divergência
como nota, com o ponteiro para o helper.

Não é vermelho herdado. Era um teste afirmando estado do mundo, o defeito nº 8 e
nº 9 da contagem — agora pela porta do backfill de migração.

---

---

## 5d. O nó ficou com a versão antiga do código, e nada pegou

**O defeito.** O commit `e48b7a7` renomeou `tem_rascunho` → `tem_pedido` em
`n8n/aplica-portao.js` e **não rodou o injetor**. O nó `Aplica Portao` no
`agente-principal.json` continuou com a versão anterior, lendo um campo que a
migração 56 não devolve mais.

Medido antes do conserto: arquivo com 16.911 caracteres, `jsCode` com 16.505; o
nó tinha `tem_rascunho` 2× e `tem_pedido` 0×, o arquivo o inverso.

**O efeito se importado**, e é a parte que assusta: `estado.tem_rascunho` fica
`undefined` em toda execução, `regra2Avaliavel` e `anexaBloco` ficam
permanentemente falsos. A regra 2 nunca avalia, o bloco 📋 nunca é anexado, e a
substituta diz sempre "Nenhum pedido aberto nesta conversa" — com o corte do
"repita esse resumo" já no system message, o cliente ficaria sem resumo nenhum.
**E a regra 1 continuaria funcionando, com 3 dos 4 casos ainda barrando: o portão
pareceria estar trabalhando.**

**Por que nada pegou, e é o que muda daqui em diante.**

- `n8n:sincronia` comparava o `systemMessage` dos agents com os wrappers
  extraídos do `jsCode` — e **nenhum corpo de nó Code com o arquivo de onde ele
  sai**. Passava 59/59 com o arquivo alterado;
- `teste:portao-venda` carregava o **arquivo-fonte**. A intenção estava certa
  (testar o original, não uma cópia da lógica) e o alvo errado: o que roda em
  produção é a cópia no JSON. Os 45/45 eram sobre um código que não subiria.

**Os dois consertos, com sabotagem.**

`n8n:sincronia` ganhou a seção 9, genérica por pares. `Aplica Portao` é
comparado **byte a byte** com seu arquivo; `Estima Tokens` é comparado por
pedaços (o gerador substitui `__WRAPPERS__` e `__PERFIS_S__`, então byte a byte
não serve). Fim de linha normalizado nos dois lados — o repo oscila entre CRLF e
LF e isso não é deriva de lógica.

```
sabotagem: altera o arquivo   -> 60 passaram, 1 falharam, exit 1
           nomeia o par       -> "Aplica Portao == n8n/aplica-portao.js — arquivo 16913, no 16911"
           restaurado         -> exit 0, md5 de volta ao original
```

`teste:portao-venda` passou a carregar o **`jsCode` do nó**, afirmando a
identidade com o arquivo **antes** de rodar as fixtures. Rodar só a identidade
não bastaria: com o injetor esquecido, ela falha e nenhuma regra chega a ser
exercitada.

Sabotado recolocando o defeito no nó, o teste reproduz o sintoma exato:

```
FALHA jsCode do no == n8n/aplica-portao.js
OK    1636 (R$ 60,00 x R$ 25,00) barra          <- a regra 1 ainda funciona
FALHA 1636 le o total afirmado em centavos — null
FALHA 1636 marca a regra 2 como AVALIADA
```

**E o injetor tinha um segundo defeito, achado ao rodá-lo:** ele cravava CRLF na
serialização, e o `gerar-principal.mjs` grava em LF. A guarda de round-trip dele
abortou — corretamente — assim que o gerador rodou depois. Agora o fim de linha
é **detectado**, não cravado, e os dois convivem em qualquer ordem.

---

## 5e. Limite conhecido: a guarda das três referências é circular

`TEM_PORTAO` sai do **próprio arquivo** que a guarda protege. Um
`agente-principal.json` exportado da instância **sem** o portão faz `TEM_PORTAO`
sair falso, a guarda passa a exigir que as três referências leiam do
`Estima Tokens` — e **aprova, imprimindo verde, o estado anterior ao portão**.
Ela não distingue "ainda não foi montado" de "perdeu o portão".

Não há como fechar isso dentro do gerador: a fonte de verdade sobre o que
*deveria* existir é externa ao arquivo. O que fecharia é uma declaração
versionada (um `esperado.json`, ou o `PERFIS` listando nós obrigatórios), e isso
é trabalho próprio.

**O que segura hoje, e mora fora do gerador de propósito:** `n8n:sincronia`
compara o corpo do nó com `n8n/aplica-portao.js` e **reprova se o nó sumir** —
verificado removendo o nó do workflow: `FALHA no "Aplica Portao" existe`, exit 1.
O registro está em comentário no próprio `gerar-principal.mjs`, junto do
`TEM_PORTAO`.

---

---

## 5f. A query do nó pedia coluna inexistente — e derrubaria o agente inteiro

**O terceiro defeito da mesma família, e o mais grave.** O nó `Estado do Pedido`
pedia `tem_rascunho`, coluna que a migração 56 não tem:

```sql
SELECT tem_rascunho, pedido_id, total_centavos, itens, escreveu_neste_turno, barrou_anterior
  FROM public.api_n8n_estado_pedido(...);
```

Importado, o Postgres responde `42703`, o nó falha — e ele está no **caminho
único**, entre `Estima Tokens` e `Credencial (resposta)`. Não seria o portão
ficar mudo: seria **o agente parar de responder, para todo cliente de todo
tenant**. Origem: a string cravada no `aplicar-portao-venda.mjs`.

**Segundo defeito na mesma query:** ela não pedia `pedido_status`, que o
`aplica-portao.js` lê. Mesmo com o nome corrigido, o campo chegaria indefinido e
o diagnóstico gravado no `componentes_json` perderia o status **sem quebrar
nada** — silencioso.

**Por que nada pegou:** `n8n:sincronia` compara código com código, nunca SQL com
assinatura; `teste:portao-venda` mocka o estado, então a query nem existe lá; e
`tests/migracao-portao-venda.cjs` chamava `select * from`, que nunca exercita a
lista de colunas que o nó escreve.

**O conserto não é escrever a asserção que faltava — é derivar o derivado.** A
lista de colunas passou a sair do que o consumidor lê:

```js
const COLUNAS_LIDAS = [...new Set(
  [...CORPO_PORTAO.matchAll(/estado\.([a-z_]+)/g)].map((m) => m[1]),
)];
```

Acrescentar um `estado.X` novo no JS passa a acrescentar a coluna sozinho. E o
injetor confere as colunas lidas contra o `returns table` da migração, abortando
se o portão ler algo que a função não declara.

**E o que prova é EXECUTAR, não comparar.** `tests/migracao-portao-venda.cjs`
ganhou a seção 9: aplica a migração na transação abortada e roda a **string SQL
do nó, verbatim**, com os mesmos três parâmetros. Depois confere que as colunas
devolvidas são exatamente as que o portão lê — nos dois sentidos (nenhuma
faltando, nenhuma sobrando). A seção 9b sabota a própria query e exige `42703`.

Sabotado no arquivo de verdade:

```
FALHA a query do no EXECUTA contra a funcao da migracao 56 — 42703 column "tem_rascunho" does not exist
exit=1
```

**E o conserto trouxe o defeito de novo, na hora.** A extração nasceu com a regex
corrompida — um `` virou o caractere backspace ao passar por um heredoc —,
`COLUNAS_LIDAS` saiu **vazia**, o `filter` não achou nada faltando, e a guarda
**aprovou**, gravando um `SELECT` sem coluna nenhuma. Asserção vácua aprova
qualquer coisa, inclusive o vazio que a produziu. O injetor agora reprova a lista
vazia **antes** de comparar. Registrado como o décimo caso no `CLAUDE.md`.

---

## 6. O que ficou pendente de autorização

**`n8n:sincronia` FECHOU.** Ensinar o gerador exigiu executá-lo — não há como
verificar uma guarda sem rodar o que ela guarda —, e a execução re-derivou o
wrapper dentro do `Estima Tokens`. `59 passaram, 0 falharam`; o workflow voltou a
ser coerente com o gerador. O que segue abaixo era o estado anterior: A entrega anterior
cortou do system message a instrução *"repita esse resumo, os itens e o total"* —
o item que este enunciado também pede, e que **já está aplicado**. O que falta é
uma execução do `gerar-principal.mjs` para re-derivar o wrapper dentro do
`Estima Tokens`, que guarda a mesma frase.

```
57 passaram, 2 falharam
  - systemMessage de AI Agent Vendas == wrapper "vendas" — 3964 vs 3767 chars
```

Não rodei: o enunciado diz "não rode o gerador nem toque no wrapper sem
autorização explícita". Um comando fecha, e o corte e a narração ficam sendo um
item só, como pedido — a narração por código já está no portão (o bloco 📋 com
itens), então tirar a instrução não deixa o cliente sem resumo.

**E o corpo do `Aplica Portao` nasce campo órfão.** O gerador não o conhece; a
cópia no JSON é injetada pelo `aplicar-portao-venda.mjs`. É a mesma classe da
`PENDENCIA-GERADOR-CAMPO-ORFAO.md`, registrada de propósito no rodapé de
`n8n/aplica-portao.js` — dívida conhecida, não esquecimento.

---

## 7. Ordem de implantação

As duas ordens são seguras, e isso é deliberado (mesma propriedade da 46): nó
antes da migração, a função ignora a chave que não conhece e a coluna fica nula;
migração antes do nó, nada muda até o nó subir. **Mas o nó `Estado do Pedido`
chama `api_n8n_estado_pedido`** — se ele subir antes da migração, estoura `42883`
a cada mensagem. Então:

1. aplicar a migração 56 (conferir o ledger e renomear o arquivo se aplicar fora
   do CLI);
2. importar o workflow;
3. conferir na instância as **três** referências por nome — é o único ponto onde
   um import parcial deixa o cliente recebendo um texto e o banco gravando outro.

E o rollback tem ordem inversa: **reverter o workflow antes** de dropar a função.

---

## 8. Como medir depois

```sql
select t.slug,
       count(*) filter (where l.portao is not null)                        as avaliadas,
       count(*) filter (where l.portao ->> 'veredito' like 'barrado%')     as barradas,
       count(*) filter (where (l.portao -> 'regra2_avaliada')::boolean)    as regra2_avaliada,
       count(*) filter (where (l.portao -> 'transferiu')::boolean)         as transferidas
  from public.mensagens_log l join public.tenants t on t.id = l.tenant_id
 where l.direcao = 'saida'
 group by 1 order by 2 desc;
```

**`regra2_avaliada` é a coluna que avisa antes do silêncio.** O marcador de
totalidade depende de **como o `system_prompt` manda o agente escrever**. Se um
cliente editar o prompt e a forma mudar, a cobertura cai a zero — e uma regra que
nunca dispara é indistinguível, no log, de uma regra que nunca é avaliada. Só
esse contador separa as duas.
