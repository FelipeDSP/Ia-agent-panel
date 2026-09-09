# Desenho — o portão que impede a mensagem de afirmar venda que não houve

**Estado: DESENHO. Nada foi escrito, aplicado nem importado.** Nenhuma linha de
`n8n/`, `supabase/` ou `src/` mudou por causa deste doc. O que existe aqui é
medição contra produção e argumento; a escolha da saída (§2) é do Felipe.

**O problema está em [`PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md`](PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md)**,
que mede a fabricação e para ali. Este doc é o passo seguinte: como impedi-la de
sair.

**A contenção não é este desenho — e, conferido em 09/09 15:50 UTC, ela ainda não
foi aplicada.** Desligar a tool `vendas` do `emporio` está decidido, mas
`tenant_tools.ativo` segue `true` e o nó `Tools Ativas` continua resolvendo
`perfil = 'vendas'` para aquele tenant. Quando for aplicada, a modalidade C some
dali por falta de assunto e volta no dia em que a tool for religada — e é para
esse dia que este doc existe.

**Este desenho continua válido e NÃO descartado, mas deixou de ser o próximo
passo.** Ele consulta `pedidos`, logo é específico de venda; num painel
multi-função cada capacidade nova precisaria do seu portão, e o workflow único
viraria workflow cheio de exceções. Antes de construí-lo, a
[`INVESTIGACAO-POR-QUE-FABRICA.md`](INVESTIGACAO-POR-QUE-FABRICA.md) mede por que
a fabricação acontece nesta montagem — e traz dois achados que mudam a ordem, sem
mudar nada aqui:

- **a leitura cara que este portão precisa é a MESMA que a injeção de estado
  precisa** (§6 de lá). Prevenção e detecção não são desenhos concorrentes: são
  dois consumidores de uma função `stable` que ainda não existe. Construir a
  leitura uma vez resolve a parte cara dos dois;
- **se a fabricação for propriedade do modelo mesmo com a montagem certa**, este
  portão volta — e volta como **capacidade contratável por tenant**, do jeito que
  o `CLAUDE.md` manda toda superfície de tool ser, não como exceção no fluxo.

**Por que não pode ser prompt.** A regra *"só afirme que registrou depois de
receber o retorno da ferramenta"* está no System Message dos dois agents e foi
violada nas oito ocorrências. Mais que isso: nos **10** turnos de confirmação que
afirmaram escrita, **4 chamaram a ferramenta corretamente** — com o mesmo prompt,
no mesmo tipo de turno (§7.2 da pendência). Não existe instrução a acrescentar
que o comportamento certo já não demonstre em 40 % dos casos. Prompt é a solução
que falhou; o que falta é estrutura.

---

## 0. O ponto de intercepção — confirmado, não assumido

Conferido em `n8n/workflows/agente-principal.json`, pelas `connections`:

```
AI Agent Basico  ─┐
                  ├─►  Estima Tokens  ──►  Credencial (resposta)  ──►  Envia Mensagem Chatwoot  ──►  Registra Mensagem
AI Agent Vendas  ─┘
```

O `Estima Tokens` roda **depois** dos dois agents e **antes** do envio. Ele já:

- **corta texto de saída** — `limparVazamento()` retira o `[Used tools: …]`
  fabricado, e é ele que alimenta `saida_cortes` (foi o que a migração 46 fez);
- **conhece `chamadas`** — `1 + intermediateSteps.length`, a mesma coluna sobre a
  qual toda a §6 da pendência se apoia;
- **conhece tenant e conversa** — não como campo próprio, mas por referência de
  nó: `$('Resolve Tenant').first().json.tenant_id` e
  `$('Extrair e Filtrar').first().json.conversation_id`, que são exatamente as
  duas referências que o `Registra Mensagem` usa três nós depois;
- **conhece o perfil** — `$('Tools Ativas').first().json.perfil`, `'vendas'` ou
  `'basico'`. É o filtro natural: em tenant sem vendas o portão não tem o que
  fazer;
- **é o dono do texto que sai** — o `Envia Mensagem Chatwoot` monta o corpo com
  `$('Estima Tokens').first().json.output`, e o `Registra Mensagem` grava **o
  mesmo campo**.

Então a intercepção cabe ali. Duas consequências que o desenho tem de respeitar:

**(a) Quem mexe no `output` mexe no que vai para o cliente E no que vai para o
log.** Os dois leem o mesmo campo. Se o portão substituir o texto sem mais nada,
`mensagens_log.conteudo` passa a guardar a frase honesta, e **o texto fabricado
desaparece** — o portão destrói a própria evidência sobre a qual a pendência
inteira foi construída. O canal para preservá-la já existe e já é usado para
isto: `componentes_json` → `p_componentes jsonb` da migração 42, que é como o
`saida_cortes` viaja hoje sem tocar em assinatura de função. O original vai por
ali.

**(b) O `Estima Tokens` é gerado, não editado.** O corpo vive em
`n8n/estima-tokens.js` e é injetado por `scripts/gerar-principal.mjs`. Editar o nó
pela UI do n8n perde a alteração na próxima geração. Qualquer lógica de portão
entra no arquivo.

---

## 1. A detecção — o que cada detector pega, medido com denominador

### 1.1 A população, e por que ela precisa ser maior que a do detector

A §6 da pendência mede cada detector pelo que ele **achou** — isso responde
"quantos falsos positivos?" e não responde "quantas fabricações ele perdeu?".
Para o segundo é preciso uma população definida por fora dele.

A população aqui é **toda saída que afirma alguma coisa sobre o pedido**, achada
por uma rede propositalmente frouxa (a D1 **ou** um padrão de recitação:
`seu pedido (está|ficou)`, `reservei`, `separei`, `coloquei`, `confirmando:`,
`pedido de <número>`) e conferida **uma a uma** contra `pedidos` e
`pedido_itens`.

| | quantidade |
|---|---:|
| saídas no banco, todos os tenants, desde sempre | **5970** |
| — na janela cega (`chamadas` nulo, até 18/08) | 66 |
| — loop bot-a-bot da conversa 20, que não afirma nada | 5637 |
| **saídas de conversa humana com `chamadas` medido** | **267** |
| das quais **afirmam pedido** | **54** |
| das quais são **fabricação** (banco não tem o que a frase diz) | **22** (15 na janela medível) |

Cada uma das 54 tem veredito explícito: `fab` (fabricação), `ok` (afirmação
verdadeira, a tool rodou e o banco concorda), `ben` (afirma estado que já era
verdadeiro, sem escrita nova), `np` (não é sobre pedido), `out` (diverge por
outra causa — o bug do carrinho da migração 49). A tabela de veredito está no
script da §6 deste doc, para poder ser conferida linha a linha.

### 1.2 O resultado

Sobre as 54, todo o histórico:

| detector | bloqueia | pega | perde | bloqueio indevido | precisão | recall |
|---|---:|---:|---:|---|---:|---:|
| D1 só a regex | 29 | 13/22 | 9 | 16 — **9 delas vendas boas** | 45 % | 59 % |
| **D1 + `chamadas = 1`** | 10 | 8/22 | 14 | **2** (1 fora de pedido, 1 benigna) | 80 % | 36 % |
| D1 ancorada + `chamadas = 1` | 9 | 8/22 | 14 | **1** (1 benigna) | 89 % | 36 % |
| rede frouxa + `chamadas = 1` | 24 | 13/22 | 9 | **11** (10 benignas) | 54 % | 59 % |
| D3 (regex + `not exists`) | 3 | 3/22 | 19 | 0 | 100 % | 14 % |
| D4 (bloco de tool no texto) | 3 | 3/22 | 19 | 0 | 100 % | 14 % |
| **D5 factual** (total afirmado × banco) | 21 | **19/22** | 3 | 2 | 90 % | 86 % |
| **D5 atrás de filtro textual ancorado** | 19 | **19/22** | 3 | **0** | **100 %** | **86 %** |
| D1+`ch=1` **∪** D5 | 25 | **21/22** | 1 | 4 | 84 % | 95 % |

Só na janela medível — que é a única onde um portão pode rodar, porque antes de
18/08 `chamadas` é nulo:

| detector | pega | bloqueio indevido |
|---|---:|---:|
| D1 + `chamadas = 1` | **8/15** | 2 |
| rede frouxa + `chamadas = 1` | 13/15 | **11** |
| **D5 factual** | **12/15** | **0** |
| D1+`ch=1` ∪ D5 | **14/15** | 2 |

**O `chamadas = 1` é o que segura a precisão, e é de graça.** Nenhum dos 13
turnos verdadeiros tem `chamadas = 1` — todos têm 2 ou mais. Não é sorte de
amostra: é a §6.1 da pendência, 37 de 37 escritas sob `chamadas ≥ 2`. **Filtrar
por `chamadas = 1` não pode bloquear uma venda boa, por construção.** Os 9
bloqueios de venda boa que a D1 crua comete somem todos com ele.

### 1.3 O que a D1 não pega, medido — e as duas perguntas diretas

Os 9 turnos de fabricação que a D1 perde não são casos exóticos. São **uma
redação só**: a recitação do carrinho, sem verbo de escrita.

| redação | ocorrências | a D1 pega? |
|---|---:|---|
| *"Seu pedido está assim: … Total: R$ X"* | 4 | **não** |
| *"seu pedido ficou: … Total: R$ X"* | 2 | **não** |
| *"O total do seu pedido ficou R$ X"* | 1 | **não** |
| *"Separei para você …"*, *"Coloquei N \<produto\> no seu pedido"* | 2 | **não** |
| *"pedido está confirmado"* | — | **sim** |
| *"Anotei"*, *"Adicionei"*, *"Incluí"*, *"Pedido fechado"* | — | **sim** |

Respondendo direto:

- **"seu pedido ficou:" NÃO é pega.** A alternativa `pedido … ficou` da D1 exige
  que venha seguida de `fechado|finalizado|confirmado`. Ali vem dois-pontos.
- **"confirmado" É pega**, por essa mesma alternativa.

É por isso que, no caso do `emporio` de 08/09, a D1 pega o primeiro turno
("Anotei") e o terceiro ("pedido está confirmado") e **perde o do meio** — que é
justamente o que recita o pedido item a item com total.

Nota de redação, porque é uma armadilha repetida: `coloquei no seu pedido` é
literal e **adjacente** na D1 e na D3. *"Coloquei 1 queijo Nozinho **no seu
pedido**"* não casa, porque tem o produto no meio.

### 1.4 Alargar a regex custa caro, e o preço foi medido

Trocando a D1 pela rede frouxa, ainda com `chamadas = 1`: o recall vai de 8/15
para 13/15 e os bloqueios indevidos vão de **2 para 11**. Os 9 novos são todos
benignos e todos da mesma natureza:

```
"Seu pedido está reservado para retirada."                          (banco: rascunho existe)
"confirmando: 12 pães de queijo tradicional, total R$ 18,00."        (banco: R$ 18,00)
"Seu pedido de 8 unidades está separado no seu nome."                (banco: 8 unidades)
"Só para confirmar, seu pedido ficou assim: … Total: R$ 38,50"       (banco: R$ 38,50)
```

Compare a última com a fabricação do `emporio` de 08/09:

```
"Só para confirmar, seu pedido ficou: … Total: R$ 15,00"             (banco: nada)
```

**São a mesma frase.** Nenhuma regex separa as duas, porque a diferença não está
no texto — está em o banco concordar ou não. É este achado, e não uma preferência
de estilo, que empurra o desenho para a comparação factual da §4.

### 1.5 O que a D3 e a D4 não pegam

**A D3 tem dois furos que a §6 da pendência não viu.**

1. **A regex perde episódio inteiro em tenant pagante.** `emporio`, conversa
   1864, 17/08: *"Coloquei 1 queijo Nozinho no seu pedido, totalizando R$ 23,00"*
   e *"Seu pedido está assim: 1x Queijo Nozinho — R$ 23,00"*. Aquela conversa
   **nunca teve pedido nenhum** — o `not exists` está satisfeito — e a D3 devolve
   zero linhas dela, só pela redação.
2. **O `not exists` é atemporal, e este é o furo estrutural.** Ele pergunta se a
   conversa tem pedido *hoje*, não se tinha *no instante da afirmação*.
   `emporio`/1636 fabricou R$ 38,50 em 17/08 e ganhou um rascunho legítimo em
   20/08 — a partir dali a fabricação ficou invisível para sempre. E é
   exatamente o que apaga o caso de 08/09: a conversa 18 tem o pedido nº 3 desde
   22/08, então **a D3 é cega para tudo o que acontecer nela daqui em diante.**
   Quanto mais o cliente compra, menos a D3 enxerga.

**A D4 continua com zero falso positivo e continua vendo pouco:** 3 dos 22. O
caso de 08/09 não tem bloco nenhum — a fabricação foi em prosa limpa, nos três
turnos. Como detector de portão a D4 não serve sozinha; como sinal de que a coisa
está pior naquele turno, serve.

### 1.6 O limite honesto desta medição

- **O banco de hoje não é o banco daquele instante.** A reconstrução usa
  `total_centavos` atual. Duas das 54 linhas têm valor que mudou depois: o
  `emporio`/3 (correção manual de 21/08, R$ 75,00 → R$ 45,00) e o
  `sendbox`/1864 (itens recriados às 17:16 de 08/09). Nas duas, a comparação
  **ao vivo** teria bloqueado onde a retrospectiva passa — ou seja, o número real
  da D5 é conservador, não otimista.
- **Amostra pequena.** 22 fabricações em duas conversas de venda, uma delas
  interna. As taxas são sinal de onde olhar, não número para projetar. O que é
  robusto é o contraste entre as colunas, não o valor absoluto de nenhuma.
- **A medição foi sabotada e reprovou.** Trocando a comparação com o banco por
  uma comparação com uma constante, a precisão da D5 desaba de 100 % para 41 % e
  **13 vendas boas passam a ser bloqueadas**. Os 100 % vêm da comparação com o
  banco, não da população nem da tabela de veredito.

---

## 2. O que fazer quando detectar — as quatro saídas

A escolha é do Felipe. O que segue é o argumento de cada uma, com o que ela custa
quando **acerta** e o que custa quando **erra**.

### A — bloquear e substituir por frase honesta

> *"Deixa eu confirmar seu pedido no sistema antes de fechar — só um instante."*

**A favor:** é a única que garante que a afirmação falsa **não chega ao cliente**,
que é o dano em questão. O cliente recebe alguma coisa, então não fica no vácuo.
Não custa token nenhum e não depende do modelo cooperar.

**Contra, e é sério:** o agente perde o fio. A memória do Redis é escrita pelo nó
do agent, **antes** do `Estima Tokens` — então ela guarda a saída **bruta**, com a
fabricação dentro (§12 da pendência). O cliente vê a frase honesta e o modelo
"lembra" de ter dito que fechou o pedido. No turno seguinte ele parte da
fabricação como premissa, que é exatamente a modalidade de agravamento medida na
§2.4. **Substituir sem mexer na memória troca uma mentira visível por uma
divergência invisível entre o que o cliente leu e o que o modelo acha que disse.**

Quem escolher A precisa decidir junto o que fazer com a chave do Redis daquele
turno. Isso não está desenhado.

### B — transferir para humano

**A favor:** é a rede que já existe, já está implementada e já tem horário,
notificação e pausa do agente. Um humano é a única entidade no fluxo capaz de
olhar o pedido e a conversa e decidir.

**Contra:** o handoff está contaminado. A `Tool - Transferir para Humano` manda
**só o `resumo` escrito pelo modelo** — nota privada no Chatwoot e notificação
WAHA, as duas com a mesma fonte, e nenhuma leitura de `pedidos` em ponto nenhum
do sub-workflow (§8 da pendência). Transferir por causa de uma fabricação faria
o humano receber **o resumo do modelo que acabou de fabricar**. É mandar o
incêndio junto com o bombeiro.

E há o custo de relação: o Empório passa a receber chamado por falha nossa, num
volume que não controla. Com 10 a 35 saídas por dia e 5 fabricações em 23 turnos
de confirmação, não é raro o suficiente para ser desprezível nem frequente o
suficiente para ser previsível.

**B só faz sentido depois do conserto da §8** — a nota privada trazendo o pedido
real do banco **ao lado** do resumo, não no lugar dele. Esse conserto é pequeno
(`api_n8n_ver_pedido` já devolve o texto pronto e a conversa já é conhecida ali)
e não foi feito.

### C — forçar nova rodada do agente com o retorno real da tool

**A favor:** é a única que **conserta** em vez de esconder, e a única que pode dar
certo sozinha, sem humano. O material para a segunda rodada existe e é bom: o
retorno de `api_n8n_ver_pedido` é texto pronto, com itens e total, no formato que
o modelo já sabe ler.

**Contra:** custa uma rodada inteira de tokens por ocorrência — e, pela §7.2, a
ocorrência se concentra no turno de confirmação, que é o fim da venda, quando o
contexto está no máximo. Pode entrar em laço: nada garante que a segunda rodada
não fabrique de novo. Precisa de um teto duro (uma rodada, e se falhar cai em A
ou B), e o teto precisa de teste próprio.

E há um risco de desenho que não aparece de imediato: reinjetar o estado real do
pedido no contexto é **exatamente o que a §2.4 mostrou envenenar a memória**, com
o sinal invertido. Pode funcionar muito bem — o experimento de memória limpa deu
zero fabricação em 9 turnos — e pode consolidar a fabricação anterior, que já
está na chave do Redis. **É a saída com maior teto e maior variância**, e é a
única que eu não recomendaria ligar sem uma rodada de teste no `sendbox` antes.

### D — deixar passar e só registrar

**A favor:** custo zero, risco zero, e resolve o buraco que a §12 da pendência
nomeia — *"o detector não tem quem o rode"*. Hoje D1/D2/D3/D4 são queries num
doc, que é o mesmo estado em que a query de frequência do `VAZAMENTO-USED-TOOLS`
passou oito dias. Transforma o defeito em métrica, que é o que falta para saber
se qualquer conserto funcionou.

**Contra:** não impede nada. O cliente de 08/09 receberia as três mensagens
exatamente como recebeu.

**Mas D não é alternativa às outras três — é pré-requisito delas.** Nenhuma das
outras pode ser avaliada sem a métrica que D produz: sem contar quantas vezes o
portão disparou e quantas eram justas, ligar A, B ou C é trocar um defeito que
se conhece por um comportamento que não se mede. A coluna já existe
(`componentes jsonb`, migração 42) e o canal já é usado pelo `saida_cortes`;
registrar o veredito do portão ali é o mesmo movimento, sem tocar em assinatura
de função.

### A leitura que eu daria

**D primeiro, sempre e desde já** — é barato, é reversível e é o que permite
julgar o resto. Duas a quatro semanas de dado com a tool religada no `sendbox`
dizem qual é a taxa real com o portão medindo em vez de estimando.

**Depois A, com o modo factual da §4 como gatilho** — porque o falso positivo do
modo factual medido é zero, e porque A é a única que garante que a frase falsa
não sai. O problema da memória envenenada é real e é dela, mas é um problema
menor que o de hoje: hoje o cliente **e** a memória ficam com a mentira; com A,
só a memória.

**B depois do conserto da §8**, nunca antes. **C só com teste próprio no
`sendbox`** e teto de uma rodada.

---

## 3. O custo de errar, e para que lado eu erraria

As duas pontas não são simétricas, e o desenho depende de qual delas se prefere.

**Falso positivo — bloquear venda boa.** O cliente recebe uma frase de espera no
lugar da confirmação legítima. Ele reclama na hora, o Empório vê, alguém conserta.
É ruído visível e reversível. **Mas com um agravante que a medição mostra:** os
falsos positivos da rede textual frouxa não são aleatórios — são **10 recitações
de pedido correto**, ou seja, ela erra exatamente no momento em que a venda está
dando certo, e trava justamente o final feliz.

**Falso negativo — deixar passar fabricação.** O cliente sai com uma retirada
combinada que não existe. Ninguém sabe: não há linha no banco para auditar, não há
log que acuse, e o comerciante só descobre se a pessoa aparecer na loja. Foi o que
aconteceu em 08/09 e é o que aconteceu em 21/08 com o mesmo cliente. **É invisível
e é irreversível.**

**Eu erraria para o falso positivo** — mas essa frase só é honesta com a segunda
metade: **erraria para o falso positivo apenas na medida em que ele não bloqueia
venda boa.** E é por isso que a resposta não é "regex mais frouxa": a rede frouxa
compra 5 fabricações a mais ao preço de 9 vendas boas travadas, e essas 9 são o
pior falso positivo possível.

O filtro por `chamadas = 1` é o que torna a preferência barata: ele não pode
bloquear venda boa, por construção (§1.2). E a comparação factual da §4 é o que a
torna quase gratuita: **zero bloqueio indevido em todo o histórico.** Nessa
combinação, "errar para o falso positivo" deixa de ser uma concessão e vira só a
ordem em que se liga as coisas.

---

## 4. A pergunta que encurta tudo — dá para comparar com o banco antes de enviar?

**Dá, e é estritamente melhor que a detecção textual. Mas não cabe dentro do
`Estima Tokens` — precisa de um nó novo e de uma migração.**

### 4.1 O ganho, medido

| | recall | bloqueio indevido |
|---|---:|---:|
| textual: D1 + `chamadas = 1` | 8/15 | 2 |
| textual frouxa + `chamadas = 1` | 13/15 | 11 |
| **factual: total afirmado × total do banco** | **12/15** | **0** |
| **factual + textual (`ch=1` ∪ factual)** | **14/15** | 2 |

E o ganho não é só de número — é de **classe de defeito**. O `chamadas = 1` só
enxerga a modalidade C (o modelo não chamou nada). A comparação factual enxerga
também a **modalidade B**, em que a tool rodou e o texto mente assim mesmo:

- `emporio`/1636, 20/08 — tool rodou (`chamadas = 2`), gravou só o Queijo
  Defumado, texto disse Café + Queijo, R$ 60,00 contra R$ 25,00;
- `emporio`/18, 21/08 — `chamadas = 4`, `fechar_pedido` rodou e devolveu
  R$ 30,00, texto publicou R$ 42,50.

**Nenhum portão baseado em `chamadas` pode pegar essas duas.** A comparação
factual pega as duas.

### 4.2 Os três furos da comparação factual, medidos

Das 22 fabricações, a comparação por total perde 3:

1. **A frase sem número.** *"Perfeito! Seu pedido está confirmado com 10 pães de
   queijo tradicionais para retirada."* — não há R$ nenhum para comparar. É o
   terceiro turno do caso de 08/09. **A D1 pega esse**, pelo `confirmado`.
2. **O total certo com o estado errado.** `sendbox`, 08/09 16:06:58 — *"Pedido
   fechado com sucesso… R$ 209,70"*, e o banco tinha R$ 209,70. O total bate; o
   pedido estava em `rascunho` e só virou `aguardando_pagamento` às 17:17:25. A
   comparação **por valor** passa; a comparação teria de olhar `status` também.
3. **O item errado com o total sem número.** `emporio`/1636, 20/08 — *"seu pedido
   está com: 1 Café Cujubi Coffe, 1 Queijo Defumado"*, sem total. Escapa de
   tudo: da D1 pelo `chamadas = 2`, da factual por não ter número. **É a única
   das 22 que nenhuma combinação testada pega.** Só uma comparação item a item
   pegaria, e isso é bem mais caro que comparar um total.

Os furos 1 e 2 são cobertos pela D1 (que casa `confirmado` e `fechado`). Por isso
o desenho é **união**, não substituição: factual para valor, textual para estado.

### 4.3 A canalização — e é aqui que "cabe ali" vira "não cabe ali"

Quatro fatos medidos contra produção, em ordem de quanto atrapalham:

**(a) O `Estima Tokens` é um nó Code e não alcança o Postgres.** No workflow
inteiro, toda leitura de banco é um nó `n8n-nodes-base.postgres` — não há uma
única exceção. O Code node não tem cliente de banco. Então a leitura é um **nó
novo**, e o lugar dele é entre o agent e o `Estima Tokens`, para o Code continuar
sendo o único ponto de decisão e ler o resultado por `$('<nó>')`, como já faz com
`Tools Ativas`.

**(b) O `n8n_agent` não tem SELECT em `pedidos` nem em `pedido_itens`.** Medido:

```
has_table_privilege('n8n_agent','public.pedidos','select')      -> false
has_table_privilege('n8n_agent','public.pedido_itens','select') -> false
rolbypassrls do n8n_agent                                       -> false
```

Todo acesso do agente passa por `SECURITY DEFINER` com grant explícito. Então
"um SELECT simples no nó Postgres" **não é opção** — é uma migração criando
função nova, com toda a família 28/32/37/40/41 junto: `revoke` antes do `grant`,
grant nos **dois** roles (`service_role` **e** `n8n_agent` — foi a linha que
faltou na 40 e na 41), e `npm run teste:grants-n8n` para provar.

**(c) `api_n8n_ver_pedido` existe, já tem grant, e ESCREVE.** Parece a resposta
pronta e não é. Ela chama `pedido_rascunho_da_conversa` e
`pedido_fechado_da_conversa`, e **as duas chamam `expirar_pedidos_vencidos`**,
que muda `status` e carimba `atualizado_em`. Usá-la no caminho de envio moveria a
expiração de "quando a conversa usa uma ferramenta" para "a cada mensagem que
sai". Dois efeitos:

- um pedido pode expirar **entre** a tool rodar e a mensagem ser enviada, o que
  cria uma divergência nova em vez de fechar uma;
- `atualizado_em` passa a se mover muito mais, e a D2 já erra por causa disso —
  a janela dela é `criado_em − 5 min .. atualizado_em + 15 min`, e foi a
  expiração movendo `atualizado_em` que fez o pedido nº 1 do sendbox "engolir"
  a conversa de onze dias depois (§6 da pendência).

A função do portão tem de ser **`stable`, sem expiração**: lê `status`,
`total_centavos` e a contagem de itens do pedido vivo da conversa, e nada mais.

**(d) Custo é irrelevante e a ordem dos nós, não.** O volume é de 10 a 35 saídas
por dia; uma consulta por mensagem não aparece em lugar nenhum. O que importa é
que o nó novo entre **antes** do `Estima Tokens`, e que o `Envia Mensagem
Chatwoot` e o `Registra Mensagem` continuem lendo o mesmo campo — hoje os dois
leem `$('Estima Tokens').first().json.output`, e é essa coincidência que faz o
portão valer para o cliente e para o log de uma vez só. Com o cuidado da §0(a):
o texto original vai no `componentes_json`, senão o portão apaga a evidência.

### 4.4 O que este desenho NÃO resolve

- **fabricação de leitura.** `Busca_Conhecimento`, `Buscar_Produto` e `Ver_Pedido`
  não escrevem linha nenhuma. Não há banco contra o que comparar, e há uma
  fabricação de leitura no censo (`emporio`/1864, 20/08). Continua dependendo do
  n8n persistir os `intermediateSteps` (§12 da pendência);
- **item certo, total certo, produto errado.** Trocar cenoura por chocolate
  mantendo o valor sai verde em tudo;
- **a memória envenenada.** O portão fica **depois** da escrita no Redis. Ele
  impede a saída e não impede o modelo de acreditar nela no turno seguinte;
- **a propensão em si.** O portão é contenção estrutural, não conserto de causa.
  A pendência é explícita: nada garante que o modelo chame a ferramenta.

---

## 5. O que fica para o Felipe decidir

1. **Qual saída** — A, B, C ou D (§2). A recomendação é D já, A depois, B só
   depois do conserto da §8, C só com teste próprio.
2. **Se a comparação factual entra** (§4). Ela custa uma migração com função nova
   e um nó novo no workflow; entrega recall maior, falso positivo zero na medição
   e a única cobertura existente para a modalidade B.
3. **O que fazer com a chave do Redis** quando o portão substituir um texto — sem
   isso a saída A troca mentira visível por divergência invisível (§2 A).
4. **Se o portão vale para todos os tenants de venda ou só para o `sendbox`
   primeiro.** O `emporio` está com a tool desligada; religá-la com o portão
   medindo (saída D) é a forma mais barata de conseguir dado real.

---

## 6. Como reproduzir a medição

Tudo veio de `mensagens_log`, `pedidos` e `pedido_itens` em produção, por leitura
direta (`SUPABASE_DB_URL` + `pg`), em 2026-09-09. Nenhuma escrita.

A conta é reproduzível em três passos:

1. **A população** — as saídas que afirmam pedido: `direcao = 'saida'`,
   `conversation_id <> 20` (o loop), casando a D1 **ou** o padrão de recitação
   `(seu pedido (esta|está|ficou)|pedido (esta|está|ficou) (assim|com|reservado|separado)|reservei|separei|coloquei|confirmando:|pedido de [0-9])`.
   Devolve 54 linhas.
2. **O veredito** — cada uma conferida contra `pedidos`/`pedido_itens` da mesma
   conversa: `fab`, `ok`, `ben`, `np`, `out`. Sem essa tabela não há como falar
   em falso negativo, porque o detector não define a própria população.
3. **A matriz** — cada predicado aplicado às 54, contando TP/FP/FN contra o
   veredito.

**A sabotagem que valida o passo 3:** trocar `total do banco` por uma constante na
comparação factual. A precisão cai de **100 % para 41 %** e **13 vendas boas**
passam a ser bloqueadas. Se essa troca não movesse os números, a medição não
estaria medindo o banco.

Duas armadilhas encontradas no caminho, para quem repetir:

- **`\[` em regex dentro de string SQL não sobrevive** à camada de shell usada
  aqui, e o erro é `invalid regular expression: brackets [] not balanced`. A
  forma `[[]` (classe com o colchete dentro) casa o literal sem backslash nenhum
  e atravessa tudo;
- **`at time zone 'America/Sao_Paulo'` devolve `timestamp` sem fuso, e o driver
  o interpreta como hora local da máquina.** Chamar `.toISOString()` depois soma
  o offset de novo e produz um horário que não existe em lugar nenhum. Use
  `to_char(...)` no SQL e trate como texto — foi o que separou "21:09 UTC" de
  "18:09 SP" no caso de 08/09.
