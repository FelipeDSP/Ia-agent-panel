# Pendência — vários itens numa mensagem: a IA relata falha que não houve, e o conserto dela cobra a mais

**Estado:** levantado em 2026-08-21 contra produção. O dado errado foi corrigido
(§7). O **conserto A** — `adicionar_item` DEFINIR em vez de somar — foi **APLICADO** em
21/08 (migração 49, ledger `20260821191500`), §8. O que continua aberto é o
comportamento do modelo (§2b): ele ignora a resposta da tool quando ela o
contradiz, e a migração 49 não conserta isso — só faz o erro dele parar de custar
dinheiro. Três consertos possíveis e muito
diferentes estão em aberto (prompt, atomicidade no SQL, ou a tool aceitar lista de
itens numa chamada só) — a decisão é do Felipe. E a §2b restringe o campo: **prompt
sozinho não resolve**, porque a instrução que teria evitado o caso já existia.

**Gatilho:** antes de qualquer cliente novo de vendas entrar. O caso é reprodutível
— basta um cliente pedir dois itens numa mensagem.

## O caso

Demonstração do `emporio`, conversa 3, 20/08. O cliente pediu **numa mensagem só**:

> `separe: 3 pedaçoes de milho com requeijoão / 1 pedaço de cenoura / 2 de chocolate`

A Bia respondeu:

> *"Parece que houve um problema ao adicionar os bolos de milho com requeijão e
> cenoura ao pedido, só ficaram os de chocolate."*

**Nada falhou.** As três execuções da `Tool - Gerenciar Pedido` terminaram
`Succeeded` (302 ms, 267 ms, 269 ms), e as três escritas estão no banco.

## 1. As três escritas entraram, e em um pedido só

`pedido_itens` da conversa 3, com microssegundo:

```
2x  Bolo de Chocolate   criado=13:40:33.734501   (+0 ms)
2x  Bolo de Cenoura     criado=13:40:34.043012   (+309 ms)
6x  Bolo de Milho       criado=13:40:34.327129   (+593 ms)
```

`pedidos.criado_em` = **13:40:33.734501**, idêntico ao microssegundo ao do item de
chocolate: o mesmo `now()`, logo a **mesma transação**. A primeira chamada criou o
pedido e inseriu o chocolate juntos. **Um pedido, não três** — o get-or-create
funcionou.

## 2. Foram SEQUENCIAIS, não concorrentes — e é isso que mata a hipótese de corrida

Os intervalos entre as escritas (**+309 ms**, **+284 ms**) batem com a duração de
cada execução (**302, 267, 269 ms**). Concorrentes, as três escritas se agrupariam
dentro de ~300 ms; espalhadas por 593 ms é a assinatura de execução em fila.

Consequência direta: **cada chamada leu o carrinho depois da própria escrita e
depois de todas as anteriores.**

| chamada | escreveu | `pedido_em_texto` devolveu |
|---|---|---|
| 1ª | chocolate | chocolate |
| 2ª | cenoura | chocolate + cenoura |
| 3ª | milho | **os três** |

`pedido_em_texto` é `STABLE` e lê `pedido_itens` no momento da chamada — não
recebe nada pronto. Confirmado no corpo da função. Então a **última** resposta que
o modelo recebeu tinha o carrinho completo e correto.

**O modelo tinha a informação certa e relatou errado.** Não houve resposta
inconsistente: houve três respostas corretas e incrementais.

E não é que ele "descreveu a primeira". É pior, e a §2b mostra.

## 2b. O modelo IGNORA a tool quando ela contradiz o que ele acha que fez

Isto é o achado que muda o conserto, e apareceu na varredura.

Às **13:41:22** o `on conflict` deixou o banco com **6x milho e 2x cenoura**. A
tool que fez isso devolve `pedido_em_texto`, que lê do banco **depois** da própria
escrita — ou seja, ela entregou ao modelo um resumo dizendo 6x e 2x.

Três segundos depois, às **13:41:25**, o modelo escreveu ao cliente:

> *"Agora seu pedido está assim: - 3 pedaços de Bolo de Milho com Requeijão —
> R$ 22,50 - 1 pedaço de Bolo de Cenoura com Cobertura de Chocolate — R$ 7,50"*

Quantidades **e subtotais** do que o cliente pediu, não do que a tool devolveu.
Ele não descreveu uma resposta antiga: **reescreveu por cima da resposta que
acabara de receber**, porque ela contradizia o que ele achava que tinha feito.

E às **13:41:54** misturou as duas fontes:

> *"O total ficou R$ 75,00, com 3 pedaços de bolo de milho com requeijão, 1 …"*

**Total do banco, quantidades da memória.** É por isso que o texto não fecha:
R$ 7,50 × (3+1+2) = R$ 45,00, não R$ 75,00. O cliente teria de fazer a conta para
notar.

### A regra do prompt já existia, e é mais forte do que "não some"

Linha 23 do `systemMessage` do `AI Agent Vendas`, verbatim:

> `A ferramenta SEMPRE devolve o pedido inteiro com o total. Repita esse resumo ao
> cliente e confirme antes de fechar. O total vem calculado — nunca some você mesmo.`

Ela manda **repetir o resumo da ferramenta**, não só não somar. Foi violada nas
duas metades: o modelo não repetiu o resumo (reescreveu as quantidades) e
apresentou um total que não corresponde às linhas que ele mesmo listou.

**Consequência para o conserto: prompt não resolve sozinho.** A instrução que
teria evitado o caso já está escrita, no lugar certo, com as palavras certas — e
não segurou. Qualquer desenho que dependa só de reforçar o texto está apostando
na mesma coisa que já falhou uma vez em uma oportunidade de uma.

## 3. O estrago: o conserto do modelo cobrou a mais

Acreditando na própria falha inventada, no turno seguinte (13:41:22) o modelo
**re-adicionou** milho e cenoura. E o `on conflict` de `api_n8n_adicionar_item` é:

```sql
do update set quantidade = public.pedido_itens.quantidade + excluded.quantidade
```

**Soma, não define.** Re-adicionar 3 sobre 3 dá 6.

```
                  pedido do cliente     no banco
milho                    3                 6
cenoura                  1                 2
chocolate                2                 2      (nunca re-adicionado: intacto)
                    R$ 45,00          R$ 75,00
```

O chocolate tem `criado_em = atualizado_em`, os outros dois têm `atualizado_em`
em 13:41:22 — a marca do re-add.

E a IA fechou dizendo:

> *"O total ficou R$ 75,00, com 3 pedaços de bolo de milho com requeijão, 1 …"*

**As quantidades que ela recitou são as do cliente; o total é o dobrado.** O
pedido está em `aguardando_pagamento` com `total_centavos = 7500`. São **R$ 30,00
a mais** num pedido real, e o texto que o cliente leu não permite perceber.

## 4. O buraco lógico do `v_status` nulo é real — mas não foi ele

A suspeita inicial era corrida no get-or-create: as três lendo `null`, duas caindo
no `on conflict do nothing`, o fallback lendo antes do commit, `v_pedido` ficando
nulo. Medido:

- `null <> 'rascunho'` é **NULL**, e `if NULL then` **não dispara** — a guarda de
  "pedido já fechado" tem mesmo o buraco;
- mas o statement seguinte insere com `pedido_id` nulo, e `pedido_itens.pedido_id`
  é `NOT NULL` com FK. O resultado medido é **`23503`**, exceção.

Ou seja: **o buraco não produz gravação silenciosa, produz execução vermelha.** As
três apareceram `Succeeded`, então não foi por aqui. O buraco continua valendo
como defeito próprio — só não é a causa deste caso.

## 5. `api_n8n_remover_item` tem a mesma forma, com duas diferenças que importam

Mesma leitura do carrinho no momento da chamada (`pedido_em_texto` no fim), então
**a mesma exposição a relatar estado parcial** num pedido de vários itens. Mas:

- ela **guarda `v_pedido is null` explicitamente** e retorna cedo, então não tem o
  buraco do `v_status` nulo;
- ela faz `DELETE`, não acumulação. Re-remover não dobra nada — o segundo
  `DELETE` apaga zero linhas e ela responde "esse item não está no pedido". **O
  risco de dobrar é exclusivo do `adicionar`.**

**Não encontrei caso de remoção múltipla no log.** A única linha do `emporio` com
`chamadas >= 3` casando com remover/tirar/cancelar é o próprio turno de re-add de
13:41:25. Se o problema de remover aconteceu, não deixou rastro em
`mensagens_log`.

## 6. O denominador — e ele é pior que "episódio isolado"

```
saídas do emporio ................. 84
com chamadas >= 3 .................  3
com chamadas >= 4 .................  1
que admitem falha ao mexer no pedido  1
```

Lido de um jeito, é 1 em 84. Lido do jeito certo: **o único turno que já somou
três itens numa mensagem é o que deu errado.** Não é 1 em 84, é 1 em 1. Os outros
dois turnos com `chamadas >= 3` são de duas tool calls, não três.

Não dá para chamar de padrão — não há tráfego suficiente. Dá para dizer que
**nunca funcionou**, porque nunca foi exercitado sem falhar.

## O que NÃO foi investigado

O `resultado` de cada uma das três execuções na tela do n8n. Ele confirmaria
diretamente o que a §2 infere dos carimbos. A inferência é forte (os intervalos
batem com as durações), mas é inferência.

Link da execução do turno: `/workflow/5rMg40Lagy3OaIo7/executions/3994820`.

## 7. O dado foi corrigido em 2026-08-21 — e como reconhecer isso numa varredura

**As duas linhas deste pedido foram corrigidas.** Esta seção foi escrita **antes**
do `UPDATE`, de propósito: sem ela, a próxima varredura reencontra as duas linhas
(ver a armadilha abaixo) e alguém "corrige" de novo, ao contrário.

`cenoura` voltou de 2 para 1
e `milho` de 6 para 3; o trigger `trg_pedido_itens_total` recalculou
`total_centavos` de 7500 para **4500**. O status seguiu `aguardando_pagamento` e o
chocolate não foi tocado.

**A ARMADILHA, e ela é a razão desta seção existir:** o `UPDATE` da correção
dispara `trg_pedido_itens_upd`, que recarimba `atualizado_em`. Então
**`atualizado_em <> criado_em` continua verdadeiro nas duas linhas** — a mesma
assinatura que a varredura da §6 usa para achar o defeito. Uma varredura futura
vai reencontrá-las.

**O discriminador é `pedidos.metadados`**, não o carimbo:

```json
"correcao_manual": {
  "em": "2026-08-21T18:...Z",
  "antes":  {"cenoura": 2, "milho": 6, "total_centavos": 7500},
  "depois": {"cenoura": 1, "milho": 3, "total_centavos": 4500},
  "motivo": "on conflict do update somou quantidade num re-add do modelo; ..."
}
```

Pedido com `metadados -> 'correcao_manual'` preenchido **já foi tratado**. Não
corrija de novo: as quantidades de hoje são as que o cliente pediu, e "desdobrar"
outra vez levaria milho a 1,5 — ou, mais provavelmente, alguém dobraria ao
contrário achando que estava consertando.

A varredura de verdade é:

```sql
i.atualizado_em <> i.criado_em
  and p.metadados -> 'correcao_manual' is null
```

Não há tabela de histórico de pedido (as 20 tabelas foram conferidas), e
`pedidos.metadados` é o único lugar onde o rastro cabia sem migração — o check
`pedidos_metadados_objeto` exige objeto, e o `||` preservou a chave que já estava
lá (`{"entrega": "retirada à tarde"}`), verificado no ensaio antes de comitar.

## 8. Conserto A — migração 49, APLICADA em 2026-08-21

```sql
do update set quantidade = public.pedido_itens.quantidade + excluded.quantidade   -- antes
do update set quantidade = excluded.quantidade                                    -- agora
```

**O motivo é idempotência, não "somar estava errado".** Somar era decisão de
desenho e estava **testada**. O que mudou foi a descoberta de que o re-envio
acontece: somar faz re-envio **dobrar**, definir faz re-envio virar **no-op**.

**Vai sozinho.** Sem tocar em workflow, prompt ou painel — o único consumidor em
runtime é o nó `Adiciona Item` do `tool-gerenciar-pedido`, e ele não muda: a
mesma chamada passa a ter outro significado. Não há janela de quebra em nenhuma
ordem.

E o conserto de lista **não teria evitado** este caso: a dobra não aconteceu
dentro do lote de três chamadas, aconteceu no turno seguinte (13:41:22), quando o
modelo re-adicionou.

**O custo aceito, com um agravante que só apareceu ao conferir o nó:** se o
cliente diz "mais um" e o modelo manda `1` em vez de `4`, o carrinho **cai** para
1 — erro visível, o cliente vê. O agravante é que o nó passa
`coalesce(nullif(btrim($4::text), '')::int, 1)`: **modelo que OMITE a quantidade
manda 1**, e sob `definir` isso derruba a linha inteira. Omitir parâmetro é mais
fácil que errar número, então a falha aceita é mais provável do que parecia — e
continua sendo a barulhenta, que é o lado certo do balanço.

**A `observacao` NÃO muda**, e é assimetria deliberada:
`coalesce(excluded.observacao, pedido_itens.observacao)` fica. Sob `definir`,
toda correção de quantidade re-envia a linha, e o modelo não repete a observação
a cada ajuste — trocar por `excluded.observacao` apagaria o "sem cebola" do
cliente **a cada mudança de quantidade**, uma falha nova e de alta frequência. A
que sobra é a inversa (observação velha sobrevive quando o cliente quer tirá-la),
mais rara e com saída: `remover` e `adicionar` de novo. Há teste para a
assimetria, para ninguém "consertar" a inconsistência.

### O teste que isso inverteu, e a cadeia que ele pulava

`tests/migracao-vendas.mjs` afirmava *"dois adicionar_item do mesmo produto
SOMAM"* (`q === 5`). A asserção foi invertida **com o motivo escrito ao lado** e
com a propriedade nova junto: *chamar duas vezes com a mesma quantidade não muda
nada*.

E ao mexer nele apareceu um defeito próprio: **o teste aplicava 25 → 26 → 41 e
pulava a 38**, que redefiniu `adicionar_item` uma semana antes. Ele exercitava um
corpo que a produção já não rodava — a armadilha do `migracao-audio.mjs`, só que
custando **verde** em vez de vermelho. A cadeia agora é 25 → 26 → 38 → 41 → 49,
na ordem em que produção a viu, e a busca por quem redefine ficou escrita como
comando (`grep -l "function public.api_n8n_adicionar_item" supabase/migrations/*.sql`)
em vez de memória.

**Conferido no apply** (ledger `20260821191500`, nome dos arquivos batendo):

| | resultado |
|---|---|
| corpo em produção | `set quantidade = excluded.quantidade`; soma ausente; `observacao` ainda preservada |
| ACL | **idêntico** ao retrato de antes; 1 assinatura viva de 5 args |
| teste real no `emporio`, como `n8n_agent` | 2 chamadas de qtd 3 → **3, não 6**, uma linha, total coerente |
| contraprova | 3ª chamada com qtd 5 → **5** (sob a soma seria 8) |

O teste real rodou em **transação revertida**, de propósito: um pedido de sonda
comitado apareceria na lista do cliente e nos Relatórios, e o índice de "um pedido
aberto por conversa" o deixaria pendurado. `pedido_itens` seguiu com 7 linhas e
soma 45, igual a antes.

**Uma tentativa de apply abortou sozinha, e o defeito era do verificador.** O
regex `/quantidade \+ excluded/` casou com a linha de **comentário** que a própria
migração escreve para explicar a mudança (*"Era `pedido_itens.quantidade +
excluded.quantidade`"*). É a armadilha que o CLAUDE.md registra — regex casando
com comentário em vez de código —, desta vez do lado de quem confere. Nada foi
comitado; o verificador passou a remover as linhas `--` antes de testar.

## 9. Uma observacao de campo sobre a 50, com o peso de UMA observacao

Teste pelo WhatsApp em 21/08, depois da migracao 50: "queijo nózinho" achou o
item, e "quejo" veio pelo ramo de sugestao. A Bia respondeu *"Você quis dizer
queijo nózinho? Se for, posso adicionar"* — **sem adicionar nada, perguntando
antes**. O formato do texto segurou: o rotulo "SUGESTÃO, não resultado" produziu
uma pergunta em vez de uma oferta.

**E uma observacao, nao prova.** Uma conversa nao diz que sempre segura, e o
limiar 0.4 continua sem validacao contra trafego — a janela `(0.25, 0.50]` saiu
de 16 termos inventados contra os 41 itens do `emporio`. O gatilho para
recalibrar esta no cabecalho da 50.

Vale registrar porque e o primeiro sinal de que a §2b (o modelo ignorando a tool
quando ela o contradiz) **nao e universal**: aqui a tool disse "0 encontrados, mas
talvez isto" e o modelo repassou a duvida em vez de resolve-la sozinho. A
diferenca pode estar em o texto ter dito explicitamente o que fazer ("confirme
com o cliente antes de usar") — hipotese, nao conclusao.
