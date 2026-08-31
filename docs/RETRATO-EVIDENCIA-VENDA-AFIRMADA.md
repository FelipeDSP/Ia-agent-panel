# Retrato da evidência — venda afirmada sem tool

**Tirado em 2026-08-28, 12:45 (America/Sao_Paulo).** Leitura pura; nada foi
escrito.

Este arquivo existe porque a evidência de `PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md`
mora em linhas vivas de produção, e **uma delas muda sozinha**. Os dois pedidos
abaixo são "para ficar como estão", mas ficar como estão não é uma decisão que
alguém possa tomar: basta o cliente escrever na conversa.

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
status .............. aguardando_pagamento
total_centavos ...... 17990                      (R$ 179,90)
metadados ........... {"entrega": "retirada"}
deletado_em ......... null
criado_em ........... 2026-08-28 11:51:53.637863 (America/Sao_Paulo)
atualizado_em ....... 2026-08-28 11:53:09.341323 (America/Sao_Paulo)
md5 da linha ........ e7884720a37f2a28bb12b83aed5cf8b8
```

## `pedido_itens`

**São duas linhas no total — uma por pedido.** Esse é o ponto: a conversa do
`emporio` prometeu duas linhas e a do sendbox prometeu duas linhas, e cada pedido
tem uma.

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

## O que este arquivo NÃO guarda

As mensagens. O texto que o cliente leu está em `mensagens_log`, e a fabricação do
turno das 21:41:57 do `emporio` está em `mensagens_log.saida_cortes` — ambos
citados verbatim nas §2.2, §4 e §7.1 da pendência. Se a evidência das mensagens
também precisar de retrato, é outro arquivo: `mensagens_log` não expira sozinho,
então não tem a mesma urgência.
