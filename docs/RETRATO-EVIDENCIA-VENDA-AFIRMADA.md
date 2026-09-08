# Retrato da evidência — venda afirmada sem tool

**Tirado em 2026-08-28, 12:45 (America/Sao_Paulo).** Leitura pura; nada foi
escrito.

Este arquivo existe porque a evidência de `PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md`
mora em linhas vivas de produção, e **uma delas muda sozinha**. Os dois pedidos
abaixo são "para ficar como estão", mas ficar como estão não é uma decisão que
alguém possa tomar: basta o cliente escrever na conversa.

---

## Conferência de 2026-09-08, 16:20 — a previsão se cumpriu, no outro pedido

Onze dias depois. **Nada aqui foi reescrito: o que mudou vai ao lado do valor
original**, porque o retrato só serve para isso.

| pedido | previsto em 28/08 | o que aconteceu |
|---|---|---|
| `emporio` nº 3 | "vencido há 6 d 15 h; `status` vira `expirado` na próxima mensagem" | **nada mudou.** md5 `b8ec05f7…` **idêntico**, ainda `aguardando_pagamento` |
| `estudyou-sendbox` nº 1 | "parado há 52 min; nada, até completar 24 h" | **virou `expirado`** em 08/09 16:05:49 |

**O mecanismo estava certo e o alvo estava errado, pelo motivo que este arquivo
já dava.** A expiração é preguiçosa: roda quando *aquela conversa* age. A conversa
18 do `emporio` nunca mais agiu — o WAHA daquele cliente está desconectado desde
25/08 — então o pedido mais vencido do banco segue intocado. A conversa 1864 do
sendbox recebeu mensagem em 08/09, e aí o nº 1, a essa altura vencido havia onze
dias, expirou na hora. A frase que previu isso está duas seções abaixo e não
precisou de correção: *"basta o cliente escrever na conversa"*. O que faltou foi
tirar dela a conclusão de que **o pedido em risco não é o mais vencido, é o da
conversa mais provável de receber mensagem.**

**A regra de conferência funcionou exatamente como escrita.** "md5 diferente com
`total_centavos` igual = só o `status` mudou (a expiração prevista)" — foi isso:

```
estudyou-sendbox nº 1, em 2026-09-08:
  status .......... aguardando_pagamento  ->  expirado
  atualizado_em ... 2026-08-28 11:53:09.341323  ->  2026-09-08 16:05:49.871919
  total_centavos .. 17990                       (INALTERADO)
  numero .......... 1                           (INALTERADO)
  metadados ....... {"entrega": "retirada"}     (INALTERADO)
  md5 da linha .... e7884720a37f2a28bb12b83aed5cf8b8
               ->   e952757666eb90e86903ae56b67c2f95

emporio nº 3, em 2026-09-08:
  md5 da linha .... b8ec05f714a04bfdfb33bfa6aa78eb29   (IDÊNTICO ao de 28/08)
```

**A prova do valor sobreviveu, que era o ponto.** `total_centavos` e o item não se
mexeram, e o `pedido_itens` do sendbox segue com `atualizado_em = criado_em`. O
contraste da seção "O contraste, que é a evidência" continua válido linha por
linha; só o `status` de uma das duas envelheceu, e envelheceu do jeito previsto.

**Cuidado ao rodar a query de conferência hoje: ela devolve TRÊS linhas, não
duas.** A mesma conversa 1864 abriu um pedido novo em 08/09, e ele **não é** parte
deste retrato — é evidência de outro episódio, o da §2.3 da pendência:

```
tenant .............. estudyou-sendbox
conversation_id ..... 1864              (mesma conversa do nº 1)
pedido_id ........... 7b15e47b-58b1-4024-9a61-5a8722fccf4c
numero .............. null              (nunca foi fechado, apesar do "pedido fechado com sucesso")
status .............. rascunho
total_centavos ...... 20970                      (R$ 209,70)
criado_em ........... 2026-09-08 16:05:49.871919 (America/Sao_Paulo)
atualizado_em ....... 2026-09-08 16:05:49.871919 (igual ao criado: nunca alterado)
md5 da linha ........ ccc145d5fb36965258e24b122709d39a
```

Ele nasceu no **mesmo run** que expirou o nº 1, às 16:05:49 — que é o desenho da
migração 55 funcionando. **Também não deve ser tocado**, pelo mesmo motivo que os
outros dois: é a única evidência de venda afirmada sem tool **posterior** à 55.

---

## O que muda sozinho, e quando

`expirar_pedidos_vencidos` marca `expirado` todo pedido em `aguardando_pagamento`
mais velho que `pedido_horas_para_expirar(tenant)` — **24 h**, o default, nos dois
tenants. Ela é preguiçosa: roda só de dentro de `pedido_aberto_da_conversa` e de
`api_n8n_adicionar_item`, ou seja, **quando aquela conversa age**.

| pedido | parado há | vencido? | o que acontece na próxima mensagem |
|---|---|---|---|
| `emporio` nº 3 (Evandro) | **6 d 15 h** | **SIM** | `status` vira `expirado` |
| `estudyou-sendbox` nº 1 | 52 min | não | nada, até completar 24 h |

**O `status` do nº 3 do `emporio` é o único campo em risco.** `total_centavos`,
os itens e os carimbos não mudam com a expiração — a prova do valor sobrevive. Se
o `status` importar como prova, é este arquivo que o guarda.

**Desfecho, 08/09:** a linha de baixo é que se cumpriu e a de cima não — o
`emporio` nº 3 segue intocado (conversa parada, WAHA fora desde 25/08) e o
sendbox nº 1 expirou às 16:05:49, onze dias depois. **O campo em risco era o
certo; o pedido, não.** Ver a conferência acima.

Os outros três do `emporio` (nº 1 conversa 3, nº 2 conversa 13, nº 4 conversa 21)
também estão vencidos e não são evidência deste doc; ficam citados na §11.5 da
pendência porque importam para a migração.

## `pedidos`

```
tenant .............. emporio
conversation_id ..... 18            (contato: "Celular Evandro")
pedido_id ........... 983b9dc0-960f-49b5-b8c0-466060e48fde
numero .............. 3
status .............. aguardando_pagamento
total_centavos ...... 3000                       (R$ 30,00)
metadados ........... {"entrega": "retirada", "horario": "manhã"}
deletado_em ......... null
criado_em ........... 2026-08-21 21:40:55.524114 (America/Sao_Paulo)
atualizado_em ....... 2026-08-21 21:42:59.479608 (America/Sao_Paulo)
md5 da linha ........ b8ec05f714a04bfdfb33bfa6aa78eb29
```

```
tenant .............. estudyou-sendbox
conversation_id ..... 1864          (contato: "Felipe")
pedido_id ........... f579df18-8dea-4148-8377-cde42ff47c13
numero .............. 1
status .............. aguardando_pagamento    -> expirado          (08/09)
total_centavos ...... 17990                      (R$ 179,90)   inalterado
metadados ........... {"entrega": "retirada"}                  inalterado
deletado_em ......... null                                     inalterado
criado_em ........... 2026-08-28 11:51:53.637863 (America/Sao_Paulo)
atualizado_em ....... 2026-08-28 11:53:09.341323 -> 2026-09-08 16:05:49.871919
md5 da linha ........ e7884720a37f2a28bb12b83aed5cf8b8
               ->     e952757666eb90e86903ae56b67c2f95        (08/09)
```

As duas colunas são o retrato de 28/08 e a conferência de 08/09. **O valor de
28/08 é o que este arquivo guarda**; o de 08/09 está ao lado para mostrar que só
o `status` e o carimbo andaram.

## `pedido_itens`

**São duas linhas no total — uma por pedido.** Esse é o ponto: a conversa do
`emporio` prometeu duas linhas e a do sendbox prometeu duas linhas, e cada pedido
tem uma.

**Continuam sendo estas duas, em 08/09** — nenhuma das duas foi alterada
(`atualizado_em = criado_em` nas duas). O `rascunho` aberto em 08/09 trouxe uma
terceira linha para `pedido_itens` (`3x 1 - Treinamento de NR 01 on-line`), que é
dele e não destes dois; a query desta seção, se filtrar por conversa, vai trazê-la
junto.

```
tenant .............. emporio          (pedido nº 3)
item_id ............. 4279d727-5846-4854-b801-8eef994388a1
produto_id .......... 07b09237-1cea-4fd8-80a6-19fc3cabb04d
nome_snapshot ....... 11 - Pão de queijo tradicional
quantidade .......... 20
preco_unit_centavos . 150                        (R$ 1,50)
observacao .......... null
criado_em ........... 2026-08-21 21:40:55.524114
atualizado_em ....... 2026-08-21 21:40:55.524114   (igual ao criado: nunca alterado)
md5 da linha ........ c949c261388c509f732a238a243aa169
```

```
tenant .............. estudyou-sendbox (pedido nº 1)
item_id ............. 59017770-c7f6-4226-a8da-5f12612a8920
produto_id .......... f2d70260-f79a-4f67-804e-4ea1779ab178
nome_snapshot ....... 12 - Curso de Direção Defensiva
quantidade .......... 1
preco_unit_centavos . 17990                      (R$ 179,90)
observacao .......... null
criado_em ........... 2026-08-28 11:51:53.637863
atualizado_em ....... 2026-08-28 11:51:53.637863   (igual ao criado: nunca alterado)
md5 da linha ........ c1819cc030a19fb761adbbe0bf151efc
```

## O contraste, que é a evidência

| | banco (acima) | o que o cliente ouviu |
|---|---|---|
| `emporio` nº 3 | 20× pão de queijo — **R$ 30,00** | 20× pão de queijo **+ 10× pão francês** — **R$ 42,50** |
| `estudyou-sendbox` nº 1 | 1× Direção Defensiva — **R$ 179,90** | Direção Defensiva **+ NR 01** — **R$ 249,80**, "pedido fechado" duas vezes |

O item inventado não está em `pedido_itens` nem em lugar nenhum: não é linha
apagada, é linha que nunca foi escrita. `atualizado_em = criado_em` nas duas
linhas reais confirma que **nada foi mexido depois** — nem pelo agente, nem por
correção manual. (É o discriminador que a `PENDENCIA-CARRINHO-MULTI-ITEM.md` §7
usa ao contrário: lá as linhas tinham sido corrigidas e o carimbo mudou.)

Nenhum dos dois tem `metadados -> 'correcao_manual'`, então nenhum foi tratado.

## Como conferir que ainda está intacto

```sql
select p.numero, p.status, p.total_centavos,
       md5(p.id::text || p.status || p.total_centavos::text ||
           coalesce(p.numero::text,'-') || p.metadados::text ||
           p.criado_em::text || p.atualizado_em::text) as md5_linha
  from public.pedidos p join public.tenants t on t.id = p.tenant_id
 where (t.slug = 'emporio' and p.conversation_id = 18)
    or (t.slug = 'estudyou-sendbox' and p.conversation_id = 1864);
```

md5 diferente com `total_centavos` igual = só o `status` mudou (a expiração
prevista). md5 diferente **com `total_centavos` diferente** = alguém mexeu no
pedido, e aí o retrato acima é o que havia antes.

**Desde 08/09 ela devolve três linhas.** A terceira é o `rascunho` novo da mesma
conversa 1864 (`7b15e47b`, R$ 209,70), que não faz parte deste retrato — está
transcrito na conferência acima e pertence à §2.3 da pendência. Filtrar por
`p.numero is not null` devolve as duas originais, se for o que você quer.

## O que este arquivo NÃO guarda

As mensagens. O texto que o cliente leu está em `mensagens_log`, e a fabricação do
turno das 21:41:57 do `emporio` está em `mensagens_log.saida_cortes` — ambos
citados verbatim nas §2.2, §4 e §7.1 da pendência. Se a evidência das mensagens
também precisar de retrato, é outro arquivo: `mensagens_log` não expira sozinho,
então não tem a mesma urgência.
