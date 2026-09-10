# A busca separa RESULTADO de MENÇÃO — migração 59

**Estado: ESCRITA E TESTADA, NÃO APLICADA.** Por decisão explícita. O arquivo
está em `supabase/migrations/20260910190000_59_busca_resultado_x_mencao.sql`,
com rollback ao lado, e `npm run teste:busca-resultado-mencao` roda 73 asserções
contra produção em transação abortada — nada foi gravado.

Para aplicar, é o `.sql` inteiro, sem recortar. Depois disso, `npm run teste`
continua servindo: o teste começa pelo rollback da própria migração, então ele
mede a mesma coisa tendo ela sido aplicada ou não.

---

## 1. O defeito, e por que ele é o mais sério que sobrou

Cliente do `estudyou-sendbox` pediu "2 treinamentos de NR 01". A busca devolveu
**três** produtos:

| | preço | produto |
|---|---|---|
| o pedido | R$ 69,90 | Treinamento de NR 01 on-line |
| não pedido | R$ 199,90 | Curso de NR 10 BÁSICO - teórico - on-line |
| não pedido | R$ 149,90 | Curso de Reciclagem - NR 10 BÁSICO on-line |

O agente listou os três e perguntou qual. **Ele fez o que devia** — a função é
que entregou errado.

Se o cliente responde "o segundo", entra no pedido um curso de NR 10 por
R$ 199,90 no lugar de um de NR 01 por R$ 69,90.

**E o portão da 56 não pega.** O pedido existe, o total bate com o banco, nenhum
número está errado. É **venda errada com todos os números certos** — a única
classe de erro que a defesa que subiu na 56 não cobre, porque ela compara o texto
com o banco e aqui o texto e o banco concordam.

## 2. A causa não é a que parece, e `phraseto_tsquery` não resolve

Não é coincidência de tokens. A descrição dos dois cursos de NR 10 menciona a
frase, adjacente e literal:

> "...o exigido pela NR 10. Além disso, segue as determinações da **NR 01**
> quanto aos procedimentos para treinamentos on-line."

Trocar `plainto_tsquery` por `phraseto_tsquery` **continua devolvendo 3**. Foi
medido. Nenhuma sofisticação de tsquery separa isso, porque não há nada de errado
com o casamento: a frase está lá mesmo.

A causa real: a função trata "o produto **é** de NR 01" e "o produto **menciona**
NR 01" como a mesma coisa, porque o ramo FTS indexa `nome || ' ' || descricao`
numa expressão só.

## 3. Por que não é "buscar só no nome"

Medido em 10/09, os dois tenants com catálogo:

| termo | hoje | só nome | menção |
|---|---:|---:|---:|
| NR 01 (sendbox) | 3 | 1 | 2 |
| NR 10 (sendbox) | 4 | 2 | 2 |
| curso (sendbox) | 19 | 13 | 6 |
| primeiros socorros | 4 | 1 | 3 |
| brigada (sendbox) | 2 | 1 | 1 |
| treinamentos (sendbox) | 15 | 5 | 10 |
| queijo (emporio) | 8 | 8 | 0 |

"Só no nome" acerta o caso e paga caro: "primeiros socorros" cairia de 4 para 1,
"curso" de 19 para 13. **Recall real, perdido para consertar a rotulagem.**

## 4. O desenho: dois blocos, e o rótulo é a correção inteira

A função **já tem** a distinção certa, em dois lugares:

- o `row_number` do CTE `ordenados` já põe casamento-no-nome primeiro. Ela
  **sabe** a diferença e não a **diz**;
- quando o termo dá zero, a camada 2 devolve "parecidos" **rotulados** como
  sugestão e instrui o agente a confirmar antes de usar.

A migração aplica o segundo ao caso do primeiro. A lista deixa de ser uma só:

```
Busca "NR 01": 3 encontrados.
RESULTADO — o nome casa com "NR 01" (1):
Treinamento de NR 01 on-line — R$ 69,90 por unidade (id: …)
MENÇÃO (2) — o nome NÃO casa; só a descrição fala deste assunto. NÃO ofereça
como se fosse o item pedido; confirme com o cliente antes de usar:
Curso de NR 10 BÁSICO - teórico - on-line — R$ 199,90 por unidade (id: …)
Curso de Reciclagem - NR 10 BÁSICO on-line — R$ 149,90 por unidade (id: …)
```

**Sem o rótulo os dois blocos são a lista de hoje com uma quebra de linha no
meio.** Se alguma decisão futura obrigar a escolher entre manter os itens e
manter o rótulo, mantenha o rótulo — é ele que muda o comportamento, não a
separação visual.

### O que não pôde sair

- o bloco de menção aparece **sempre** que houver menção na amostra. Nada de
  condicionar a "quando o nome traz poucos": regra condicional é o que fica
  errada em silêncio no dia em que a proporção muda;
- o **teto de 5** vale para os dois blocos **somados**. O texto entra no contexto
  de toda busca de todo tenant com vendas. O limite vive na função e não no
  prompt porque instrução o modelo ignora e limite não;
- **ordem**: resultado primeiro, menção depois. Se o teto cortar, corta a menção,
  que é a informação menos confiável. Isso acontece **de graça**: o `row_number`
  já ordena por `casou_nome desc`. Não há lógica de corte em lugar nenhum;
- `total_encontrado` continua contando **os dois**. Quem lê o número precisa ver
  o mesmo que quem lê o texto;
- a camada 2 (parecidos por `word_similarity`) **não muda**.

### O caso que parece defeito e não é

`v_n_result` e `v_n_mencao` contam sobre a **amostra** (os 5 que cabem), não
sobre o conjunto todo. Um termo com 13 casamentos no nome — "curso" — enche a
amostra de resultado e **não mostra bloco de menção**.

Isso não é a regra condicional proibida: não há `if` nenhum sobre proporção, é o
teto cortando pela ordem. O teste mede os dois sentidos, para ninguém no futuro
ler a ausência como defeito e reintroduzir o problema consertando-a: `curso`
(19/13), `treinamentos` (15/5) e `queijo` (8/8) **não** mostram o bloco; `NR 01`,
`NR 10`, `primeiros socorros` e `brigada` mostram.

## 5. O índice: nenhum índice novo é preciso, e isso foi medido

A pergunta é legítima porque `idx_produtos_busca` indexa a expressão
`to_tsvector('portuguese', nome || ' ' || coalesce(descricao,''))` e o ramo FTS
casa essa expressão exata.

Três fatos medidos, e o terceiro surpreende:

1. **o filtro não muda.** A expressão do ramo FTS continua idêntica, palavra por
   palavra. O índice continua válido — não há o que invalidar;
2. a classificação (`casou_nome`) usa uma expressão nova,
   `to_tsvector('portuguese', p.nome)` sem a descrição, que nenhum índice cobre.
   **Ela não precisa de índice**: é avaliada na projeção, sobre as linhas que o
   filtro já selecionou, e não no filtro. `explain (analyze, buffers)` antes e
   depois: **mesmo plano, mesmos 16 buffers**, custo 17.85 → 18.10;
3. **`idx_produtos_busca` não está sendo usado hoje.** Com 90 produtos e 128 kB
   de tabela contra 2 MB de índice, o planner escolhe
   `idx_produtos_tenant_categoria` para o filtro de tenant e aplica o FTS como
   `Filter`. Não é defeito nem motivo para mexer agora — é o esperado nesse
   tamanho —, mas quem for medir desempenho da busca deve saber que o GIN está
   ocioso, e não concluir da leitura do código que ele está trabalhando.

## 6. ACL: mesma assinatura, `create or replace` sem `drop`

Sem `drop` não há aridade ambígua (28, 32, 37) e nenhum grant é apagado (40, 41).
O teste **confere o ACL antes e depois por diff**, não contra a lista que eu
esperava — que foi exatamente como a 41 passou verde sem `n8n_agent`. Medido:
idêntico nos dois lados, `n8n_agent` presente, `anon`/`authenticated` ausentes.

O bloco de `revoke`/`grant` fica no arquivo mesmo assim, porque `create or
replace` sobre uma função que por acaso **não** existisse (ambiente novo) a
criaria aberta para PUBLIC — que é como todo objeto novo nasce neste projeto.

## 7. O teste: `tests/busca-resultado-mencao.mjs`, 73/73

O risco declarado era este:

> um teste que afirme "NR 01 devolve 1 resultado" **passa** numa implementação
> que quebrou a busca inteira e devolve 1 para tudo.

Três coisas fecham essa porta, e nenhuma sozinha basta:

1. cada termo é afirmado **nos dois lados** — quantos no bloco RESULTADO **e**
   quantos no bloco MENÇÃO. A busca que devolve 1 para tudo falha na segunda
   metade de cada par;
2. o total de cada termo é **medido antes** da migração, no mesmo teste, e
   comparado com o de depois. O número esperado não é escrito à mão: sai do banco
   pré-59. "curso" continua em **19**;
3. o caso do cliente é afirmado **nominalmente**: o de R$ 69,90 no RESULTADO, os
   de R$ 199,90 e R$ 149,90 na MENÇÃO — presentes, não sumidos —, e nenhum NR 10
   vazando para o bloco de cima.

Mais: contraprova pré-migração (o defeito existe mesmo), chamada real como
`n8n_agent`, isolamento entre os dois tenants, rollback e reexecução.

### As quatro sabotagens

| | o que muta | o que fica vermelho |
|---|---|---|
| S1 | tira o rótulo "NÃO ofereça como se fosse o item pedido" | o texto deixa de instruir, e os três produtos voltam a ser indistinguíveis |
| S2 | classifica só por `ilike`, sem o FTS do nome | "treinamentos" perde os 5 resultados — os 5 vêm da flexão, nenhum do `ilike` |
| S3 | condiciona a menção a `v_n_result < 2` | "NR 10" volta a esconder as 2 menções |
| S4 | ordena sem `casou_nome desc` | menção entra na amostra de "curso": o teto deixa de proteger o resultado |

Cada uma imprime o tamanho do arquivo antes e depois — **confirmação de que a
mutação entrou** antes de acreditar no resultado. Cada uma também afirma o lado
bom logo em seguida, para a sabotagem não passar por acerto quando quem quebra é
outra coisa.

## 8. Suíte

`npm run teste`: **58 de 59** verdes, 319 s. O único vermelho é
`teste:n8n-validar`, e ele **não** é herança nem ruído — ver a seção seguinte.

## 9. O vermelho aberto, dito de frente

`n8n/workflows/agente-principal.json` está modificado na árvore de trabalho: é o
export da UI do n8n que veio depois de mexer na posição dos nós. O export do n8n
**omite campo cujo valor é o default**, e quatro campos se perderam nele:

- `tail` em `Remove Lidos do Acumulo` — sem ele o n8n faz `RPOP`, que remove a
  mensagem **errada** do acúmulo;
- `maxItems` em `Volta a Um Item` — o teto de UMA resposta ao cliente;
- `options.response.response.outputPropertyName` em `Baixa Anexo` — o nome do
  binário que a transcrição consome;
- o `name` do workflow no topo — sem ele, quem pareia por nome passa a reportar
  este workflow como ausente da instância.

**Qual dos dois lados está certo: o versionado.** O arquivo em `HEAD` carrega os
quatro; o export não os carrega porque o n8n não os escreve. Não é o repositório
que está desatualizado — é o export que é uma cópia com menos informação.

Destes quatro, o gerador restaura `name` e `outputPropertyName`; **`tail` e
`maxItems` são órfãos** — só o git os tem, e é o caso de
[`PENDENCIA-GERADOR-CAMPO-ORFAO.md`](PENDENCIA-GERADOR-CAMPO-ORFAO.md) em
carne viva.

O conserto preserva as posições novas e não foi feito porque mexer no workflow
precisa de autorização explícita. Enquanto ele não acontece, a suíte tem esse
vermelho, e ele é **verdadeiro**: o arquivo da árvore, importado como está,
degradaria três comportamentos.

## 10. O que esta migração não faz

- **não resolve a fabricação de venda** (modalidade C). É outra classe, e a
  defesa dela é o portão da 56;
- **não expõe o `sku`** ao cliente final na busca — fase 2, e a decisão de não
  antecipar continua valendo;
- **não mexe no prompt nem em tool nenhuma.** O rótulo é do banco. Se ele vivesse
  no wrapper seria instrução, e instrução o modelo pode ignorar;
- **não muda a camada 2** (parecidos por `word_similarity`), nem o limiar
  `c_prox = 0.4` — que continua sem validação contra tráfego, como
  [`PENDENCIA-PISO-SIMILARIDADE.md`](PENDENCIA-PISO-SIMILARIDADE.md) registra.
