# Desenho — segmentação por sub-agentes (`agentTool`)

**Estado: DESENHO. Nada construído.** Nenhum JSON, nenhum gerador, nenhum nó.
Medição contra produção em 2026-09-09 e argumento.

**Veredito, à frente de tudo: o recorte do rascunho está certo e a topologia está
errada.** Ler/escrever é o eixo certo — é o que os dados mostram. Mas sub-agente é
um jeito caro de comprar uma propriedade barata, e ele **cega o único instrumento
de detecção que existe hoje**. As duas seções que sustentam isso são a §2 (a
correlação que motiva não sobrevive ao denominador) e a §3 (o que acontece com
`chamadas`).

---

## 1. Antes: o estado do repo neste minuto

A redação da §7 da [`INVESTIGACAO-POR-QUE-FABRICA.md`](INVESTIGACAO-POR-QUE-FABRICA.md)
foi aplicada **pela metade** e o repo está com `n8n:sincronia` vermelho:

| feito | falta |
|---|---|
| 3 `description` órfãs trocadas no JSON | `description` da foto (é do gerador) |
| 2 seções do system message do `AI Agent Vendas` | rodar `gerar-principal.mjs` para re-derivar o wrapper |

```
57 passaram, 2 falharam
  - systemMessage de AI Agent Vendas == wrapper "vendas" — 3964 vs 3767 chars
  - a cauda do systemMessage e identica nos dois agents
```

É esperado e é exatamente o que o mapa de donos da §7.1 previa: o wrapper dentro
do `Estima Tokens` é **do gerador**, e eu não o toquei de propósito — ele guarda o
mesmo texto dentro de um template literal, com as crases escapadas (`` \`ver\` ``),
e uma troca crua ali quebraria o nó Code. Uma execução do gerador fecha os dois
itens. **Não rodei porque você disse "nada de gerador"** — diga e eu fecho em um
comando.

---

## 2. A correlação que motiva não sobrevive ao denominador

O argumento é *"`Basico` tem 3 tools e zero fabricações; `Vendas` tem 8 e oito
fabricações; é a única variável estrutural que separa os dois"*. Medido, a
variável não é a única e provavelmente não é a certa.

**Quem roda cada perfil, e com quanto tráfego:**

| perfil | tenants | saídas humanas |
|---|---|---:|
| `basico` | `ceejaar` (+ `acqua`, `clinica-teste`, `sandbox-de-testes`, sem tráfego) | **35** |
| `vendas` | `emporio` 150, `fortalize` 59, `sendbox` 45, `restaurante-teste` 39 | **293** |

**35 contra 293.** "Zero em 35" e "oito em 293" são compatíveis com taxas iguais;
não separam nada.

E há três confundidores, em ordem de força:

**(a) O `basico` não tem o que fabricar.** Ele não tem ferramenta de escrita, então
"afirmou escrita sem chamar" sobre um pedido não é um evento que possa ocorrer
ali. Comparar contagem de fabricação de venda entre um perfil que vende e um que
não vende mede *ter vendas*, não *ter 8 ferramentas*.

**(b) Dentro do perfil de 8 ferramentas há um contraexemplo com denominador
maior que o do `basico`.** `fortalize` carrega as mesmas 8 e tem **59 turnos
medíveis e zero fabricações de venda** — o único casamento da D1 lá é o falso
positivo da lista de vacinas. Se 8 ferramentas causassem fabricação, o `fortalize`
seria o lugar mais provável de vê-la depois do `emporio`, e ele está limpo. O que
o `fortalize` não tem é **conversa de carrinho de vários passos**, que é onde a
§7.2 da pendência localizou o defeito.

**(c) O `basico` JÁ cometeu a falha análoga, e foi preciso prompt para contê-lo.**
Está escrito no próprio gerador, com data:

> DOIS MOMENTOS, nao um. Na conversa de 12/08 o agente basico primeiro OFERECEU
> ("Quer fazer um pedido para entrega?") e so depois PROMETEU ("e so me informar
> os itens que eu registro para voce").

Foi por isso que `REGRAS_BASICO` existe. O "zero fabricações do `basico`" é, em
parte, o resultado de duas regras escritas para impedir que ele prometesse
registrar pedido — não a evidência de que 3 ferramentas são seguras.

**O que sobrevive da intuição:** o eixo **leitura × escrita** continua sendo o
recorte certo, porque é o que os dados mostram (consulta funciona, escrita
fabrica). O que não se sustenta é a inferência *"foi a quantidade de ferramentas"*
e, com ela, a conclusão de que a cura é distribuí-las entre agentes.

---

## 3. Pergunta A — o que acontece com `chamadas`

**A resposta curta é pior que "ele passa a mentir": ele continua verdadeiro e
para de dizer alguma coisa.**

### O mecanismo

`n8n/estima-tokens.js`, no caminho quente:

```js
const agent = $input.first().json;
const passos = Array.isArray(agent?.intermediateSteps) ? agent.intermediateSteps.length : 0;
const chamadas = 1 + passos;
```

Ele lê os passos **do agente que alimentou o nó**, que é o principal. Com
`agentTool`, uma invocação do sub-agente é **um** passo do principal. As chamadas
que o sub-agente faz às ferramentas de verdade acontecem no executor dele e não
aparecem ali.

### O que quebra, exatamente

A §6.1 da pendência validou uma implicação, e é só esta:

> **`chamadas = 1` ⟹ nenhuma escrita aconteceu.** (37 de 37 escritas sob
> `chamadas ≥ 2`; nenhuma sob `chamadas = 1`.)

A volta nunca foi verdadeira e nunca foi usada — `consultar_catalogo` é leitura e
já dá `chamadas ≥ 2` sem escrever nada.

Com sub-agentes, **a implicação continua válida**: se o principal não deu nenhum
passo, ele não chamou o sub-agente, então nada escreveu. O problema é outro:

> O turno que fabrica passa a ter **`chamadas = 2`**, porque o principal
> chamou o sub-agente — e o sub-agente é que não chamou ferramenta nenhuma.

O detector de hoje é *"afirma escrita **e** `chamadas = 1`"*. Sob sub-agentes,
quase toda fabricação apresenta `chamadas = 2` e **some do detector**. Não por
erro de medida: por perda de resolução.

**E o mais perigoso é o que acontece com a verificação.** Re-rodar a checagem da
§6.1 na topologia nova — cruzar as escritas de `pedidos` com os turnos e conferir
que nenhuma ocorreu sob `chamadas = 1` — **passaria verde**, porque a implicação
sobrevive. O instrumento seria declarado íntegro no exato momento em que deixou de
enxergar o defeito. É o falso verde da pior espécie, e ele traz um item ao qual
este projeto já deu nome: *a verificação contra a lista que você espera é
auto-confirmação*.

### O que fica de pé

A **segunda fonte** — o banco — não depende de `chamadas` e não é afetada. Toda
escrita continua aparecendo em `pedidos`/`pedido_itens` 1,3 a 3,4 s antes do turno.
Ou seja: sob sub-agentes, **o detector factual do
[`DESENHO-PORTAO-VENDA-AFIRMADA.md`](DESENHO-PORTAO-VENDA-AFIRMADA.md) deixa de ser
a opção melhor e passa a ser a única.** A topologia que se propõe para reduzir a
fabricação torna obrigatório o mecanismo caro que ela deveria tornar desnecessário.

### O que rodar para confirmar, porque isto é previsão e não medição

Não dá para medir daqui: depende de o `agentTool` do n8n expor, ou não, os passos
internos do sub-agente no `output` do principal. O repo só me diz o que o
`Estima Tokens` lê. **Uma execução resolve**, no `estudyou-sendbox`, com o rascunho
importado:

1. mande *"quero 3 treinamentos de NR 01"* numa conversa com carrinho vazio;
2. confirme no banco que `pedido_itens` ganhou linha (é a verdade de campo);
3. leia `mensagens_log.chamadas` daquele turno e abra a execução no n8n.

| resultado | leitura |
|---|---|
| `chamadas = 2` e o `intermediateSteps` do principal tem **1** passo | confirmado: os passos do sub-agente não sobem. O detector perde resolução |
| `chamadas ≥ 3` e o `intermediateSteps` traz os passos internos | o `agentTool` propaga; `chamadas` sobrevive e a §3 inteira cai |

Um turno basta para decidir, e é o primeiro a rodar — antes de qualquer trabalho
de topologia.

---

## 4. Os três problemas do rascunho

### 4.1 O recorte — nem o seu nem o meu: o eixo é efeito colateral, não fase

Partir `IA - 2` em *pedido* e *encerramento* separa por **fase da conversa**, e as
fases se interpõem: o cliente pergunta preço no meio de fechar, desiste no meio de
adicionar, agradece e volta. Recorte por fase produz o ping-pong da §6 abaixo.

O eixo que os dados sustentam é **efeito colateral**:

| | ferramentas | onde |
|---|---|---|
| **leem** | `busca_conhecimento`, `consultar_catalogo`, `gerenciar_pedido acao=ver` | diretas no principal |
| **escrevem no pedido** | `adicionar`, `remover`, `fechar`, `cancelar` | atrás de uma porta só |
| **agem fora do pedido** | `enviar_foto`, `transferir_humano`, `resolver_conversa` | diretas no principal |

Leitura fica direta porque **leitura funciona hoje** e é o que o principal precisa
para responder. Só a escrita fica atrás de uma porta.

**E aí aparece o problema do desenho inteiro:** a única propriedade que essa porta
compra é *"uma decisão de escrita em vez de quatro"*. Isso é exatamente o que se
obtém **fundindo as quatro ferramentas de escrita em uma**, com `acao=adicionar|
remover|fechar|cancelar` — que é a hipótese 2 da investigação, custa **−2
ferramentas de schema**, não acrescenta chamada de modelo nenhuma, não duplica
prompt e não mexe em `chamadas`.

**Sub-agente entrega a mesma porta única cobrando uma chamada de modelo, uma cópia
do prompt do tenant, uma camada que pode reescrever o resultado, e a cegueira do
§3.** É por isso que o veredito do topo é "topologia errada": não é que o objetivo
esteja errado, é que existe um caminho barato para o mesmo objetivo.

### 4.2 A memória — os sub-agentes NÃO devem ter, e por um motivo melhor que o seu

Você pergunta se é bom (não têm de onde inventar) ou ruim (não sabem o que foi
conversado). É bom, e a razão certa não é nenhuma das duas:

**O sub-agente de escrita não conversa com ninguém.** Ele recebe uma instrução
estruturada, chama uma ferramenta e devolve o texto dela. Histórico de conversa
não é insumo dele — é ruído, e é ruído **contaminado**: a memória do Redis guarda a
saída BRUTA do agente, com a fabricação anterior dentro (§2.4 da pendência,
medido). Dar memória ao sub-agente de escrita seria injetar a fabricação passada
exatamente no componente que decide escrever.

O corolário vai além da memória e é o que corta custo na §5: **o sub-agente de
escrita também não deveria receber o `system_prompt` do tenant** — personalidade,
tom, endereço, horário. Ele não fala com o cliente. Ele precisa de: as descrições
das suas ferramentas e a regra de nunca inventar retorno. Isso é o oposto de "cada
agente carrega seu wrapper e seu schema": bem desenhado, o sub-agente é **barato**.

O que ele precisa e não tem no rascunho é o **estado**, não o histórico — e é
exatamente a função de leitura da §6 da investigação, a mesma que a injeção e o
portão já pediam.

### 4.3 O modelo cravado — errado, e a correção não é a óbvia

`gpt-4.1-mini` cravado está errado pela razão que você deu, e ela é de contrato: o
cliente que pagar modelo melhor teria o principal bom e a escrita fraca.

Mas trocar por `{{ $('Resolve Tenant').first().json.modelo }}` em todos os agentes
é a correção **fraca**, e vale notar por quê: ela desperdiça a única vantagem real
que a topologia oferece. Se os agentes são separados, eles podem usar **modelos
diferentes**, e a decisão de escrita — que é onde o defeito mora — é justamente a
que justificaria um modelo caro num turno raro.

Isso é uma coluna nova (`modelo_escrita`, com fallback em `modelo`), não uma
expressão copiada. **E é a única justificativa que eu encontrei para a topologia de
sub-agentes sobreviver a esta análise** — não "separar para simplificar", mas
"separar para poder pagar caro só onde importa". Se o experimento da hipótese 1
mostrar que o tier resolve, isso vira a forma barata de aplicá-lo: `gpt-4.1` só no
sub-agente de escrita, que roda em poucos turnos, em vez de no principal, que roda
em todos.

---

## 5. O custo por turno, medido

Componentes reais, por **turno**, do `Estima Tokens` (média de 128 turnos do
`emporio`; `chamadas` média 1,56):

| componente | por turno | por **chamada** |
|---|---:|---:|
| wrapper (o system message fixo) | 1 894 | 1 214 |
| `system_prompt` do tenant | 2 948 | **1 890** |
| schema das 8 ferramentas | 972 | 622 |
| memória | 355 | 228 |
| mensagens + round-trip | 62 | — |
| **entrada total** | **6 230** | |

**O termo dominante é o `system_prompt` do tenant, e ele é copiado em toda chamada
de todo agente.** Não é uniforme: `emporio` tem 5 807 caracteres de prompt,
`ceejaar` 11 092, `estudyou-sendbox` 12 842 — ou seja **1 890, 3 578 e ~4 129
tokens por chamada**, respectivamente.

Turno mínimo na topologia de sub-agentes: o principal decide (1), o sub-agente
decide (2), a ferramenta volta e o sub-agente formula (3), o principal narra (4).
**Quatro chamadas onde hoje há 1,56.**

| | hoje | sub-agente ingênuo (prompt do tenant nos dois) | sub-agente enxuto (§4.2) |
|---|---:|---:|---:|
| chamadas de modelo | 1,56 | 4 | 4 |
| entrada estimada/turno | **6 230** | **≈ 11 900** | **≈ 8 300** |
| × hoje | 1,0 | **≈ 1,9×** | **≈ 1,3×** |

O "enxuto" é o desenho da §4.2: sub-agente sem `system_prompt` do tenant, sem
memória, só com o schema das 4 ferramentas de escrita. **A diferença entre 1,9× e
1,3× é inteiramente a duplicação do prompt do tenant** — e para `ceejaar` ou
`sendbox`, cujos prompts são o dobro do `emporio`, a versão ingênua passa de 2×.

São **estimativas**, não medições: dependem de como o wrapper se parte entre os
dois agentes. O que é medido são os componentes de hoje e a razão entre eles.

**E o `S` piora de um jeito que já tem item próprio.** A
[`PENDENCIA-S-DESATUALIZADO.md`](PENDENCIA-S-DESATUALIZADO.md) registra que `S = 622`
foi medido com 7 ferramentas num perfil que tem 8. Com N agentes há **N valores de
`S`** para medir, um por conjunto, e o `Estima Tokens` hoje só conhece um por
perfil. Sem isso, o rateio do perfil de vendas erra mais do que já erra.

---

## 6. O que se perde — e por que o recorte por fase é o que cria o ping-pong

O caso que você descreve — *"cliente pergunta preço no meio de fechar pedido e o
sub-agente de encerramento não tem catálogo"* — é um **erro de roteamento**, uma
classe de falha que hoje não existe. Hoje o agente tem todas as ferramentas e pode
escolher a errada; ali ele pode escolher o **agente** errado, e o agente errado não
tem como se recuperar: ele devolve vazio ou uma desculpa, e o principal precisa de
outra rodada para corrigir — o ping-pong, a dois modelos de custo por salto.

Pior: **um sub-agente que não pode responder tem de dizer que não pode**, e é
exatamente nessa situação que o modelo inventa. A investigação inteira é sobre uma
ferramenta que não devolveu o que o modelo queria.

O recorte da §4.1 evita isso por construção, e é a segunda razão para preferi-lo:
o principal mantém **todas as leituras**, então nenhuma pergunta do cliente
depende de rotear para outro agente. Só a escrita atravessa a porta, e escrita não
é pergunta — não há resposta a devolver, há um efeito a confirmar.

Se ainda assim houver sub-agente, a regra que o mantém não-ping-pong é:
**um sub-agente nunca recebe pergunta do cliente, só instrução de ação.** Ele não
precisa saber o que foi conversado (§4.2) porque não está conversando.

---

## 7. Pergunta B — contratação, e quantos nós

A boa notícia é que aqui **não há explosão**, e o motivo é uma propriedade do n8n
que o projeto já usa: **um nó de ferramenta pode ser ligado a mais de um agente** —
`Busca Conhecimento` hoje está ligada aos dois — e **um nó de Chat Model pode
alimentar vários agentes**, que é como o `OpenAI Chat Model` já serve os dois.

Então os sub-agentes são **compartilhados**, não duplicados por perfil:

```
Vende? ─ basico ─→ IA Principal (basico)  ─ai_tool→ [KB] [transferir] [resolver]
       └ vendas ─→ IA Principal (vendas)  ─ai_tool→ [KB] [transferir] [resolver]
                                                    [catálogo] [foto] [ver pedido]
                                                    [Sub - Escrita de Pedido] ──→ [adicionar]
                                                                                  [remover]
                                                                                  [fechar]
                                                                                  [cancelar]
```

Contagem: **2 agentes principais + 1 sub-agente**, contra 2 agentes hoje. O
`Vende?` continua com duas saídas e o roteamento por contratação não muda em nada
— o sub-agente de escrita pende só do principal de vendas, e o cliente de suporte
nunca o carrega, exatamente como hoje não carrega `Gerenciar Pedido`.

O que **não** escala é combinação *dentro* de um perfil — `foto_produto` opcional
dentro de vendas —, e essa é a mesma questão da §8 da investigação, com a mesma
resposta: a fronteira é a função, que confere `ativo and contratado` e recusa; a
lista de ferramentas é menu. Sub-agentes não pioram nem melhoram isso.

---

## 8. A narração por código — cabe, e é mais forte que o sub-agente

Ela não briga com o desenho: **ela o dispensa em parte.**

O problema que você aponta é real e é o mais sério do rascunho: o `IA - 1` recebe
o retorno do `IA - 2` e narra. Se reescrever o valor, é a modalidade B com uma
camada a mais — e agora com um `chamadas` que não distingue mais nada (§3). O
rascunho **acrescenta** um ponto de reescrita ao caminho.

E a solução "o sub-agente devolve `pedido_em_texto` e o principal repassa" é, de
novo, **prompt**: "repasse sem reformular" é uma instrução, e instrução é o que
falhou oito vezes. Um LLM instruído a copiar texto às vezes copia.

A versão estrutural não precisa de sub-agente nenhum:

> O texto do pedido não passa pelo modelo. A ferramenta de escrita devolve
> `pedido_em_texto`, e **um nó de código** anexa esse bloco à mensagem que vai ao
> Chatwoot, abaixo do que o modelo escreveu. O modelo conversa; o banco recita.

O ponto de anexação é o mesmo `Estima Tokens` da §0 do desenho do portão — ele já
monta o texto final e já é lido pelo `Envia Mensagem Chatwoot` e pelo
`Registra Mensagem`. E convive com o portão: o portão compara o que o modelo
afirmou com o banco; a narração por código faz o banco falar por si.

**Ordem de força, do mais estrutural ao menos:** narração por código > portão
factual > injeção de estado > fusão das ferramentas de escrita > redação das
descrições > sub-agentes. O rascunho está no fim dessa lista e custa mais que
todos os outros.

---

## 9. O que o gerador precisaria mudar — e o que isso esbarra

Se, apesar de tudo, os sub-agentes forem em frente:

1. **`PERFIS` deixa de ser `{basico, vendas}`** e passa a descrever um grafo:
   quais agentes existem, quais ferramentas pendem de cada um, qual `S` cada
   conjunto tem. Hoje é uma constante de duas linhas.
2. **`RE_SECOES_VENDAS` não sobrevive.** O gerador separa os perfis recortando o
   system message por `## Ferramenta: consultar_catalogo … (?=## Regras gerais)`,
   com uma única guarda (`basico.includes('consultar_catalogo')`). Com N agentes,
   cada um precisa do seu wrapper, e derivar N textos de um só por regex é frágil
   de um jeito que já mordeu este projeto. O caminho seria o inverso: montar o
   system message **por composição** de blocos declarados, e o wrapper de cada
   agente sai da composição, não de um recorte.
3. **`S` por agente**, não por perfil (§5).
4. **E aqui está o esbarrão:** sete das oito `description` são **campo órfão** —
   ninguém no gerador as escreve, e nenhum validador olha esse campo
   ([`PENDENCIA-GERADOR-CAMPO-ORFAO.md`](PENDENCIA-GERADOR-CAMPO-ORFAO.md)).
   Acrescentar agentes significa acrescentar `description` de sub-agente, que são
   **o texto que decide o roteamento entre agentes** — e elas nasceriam órfãs
   também, no mesmo arquivo sem detector. Fazer isso antes do detector da opção B
   daquela pendência é aumentar deliberadamente a superfície de um problema
   conhecido.

---

## 10. O que eu faria

1. **Rodar o turno único da §3** antes de qualquer trabalho de topologia. Se
   `chamadas` sobreviver, esta análise muda; se não, o custo de sub-agentes inclui
   perder o detector, e isso precisa estar na conta desde o começo.
2. **Fundir as quatro ferramentas de escrita numa** (`acao=adicionar|remover|
   fechar|cancelar`). Entrega a "porta única" que motiva o rascunho, custa −2
   ferramentas de schema, não acrescenta chamada de modelo, não toca em `chamadas`
   e não cria erro de roteamento. **É o rascunho sem a topologia.**
3. **Narração por código** (§8) — o texto do pedido para de passar pelo modelo.
4. Só então, e só se a fabricação persistir: **sub-agente de escrita, enxuto**
   (sem prompt do tenant, sem memória, §4.2), e aí pelo motivo que sobrou —
   **poder rodar um modelo melhor só nele** (§4.3), o que exige `modelo_escrita`
   como coluna, não a expressão copiada.

**Não construa o rascunho como está.** O que ele tem de certo — leitura de um
lado, escrita do outro — é aproveitável e está nos passos 2 e 4; o que ele tem de
caro não compra nada que os passos 2 e 3 não comprem mais barato.
