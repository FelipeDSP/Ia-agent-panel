# Pendência — categoria de produto, e a ordem de amostragem

> Registrada em **2026-08-17**, logo depois da migração 41. **Próxima fatia de
> vendas.** A 41 consertou o sintoma (o corte silencioso); isto é a causa da
> pergunta aberta continuar sem resposta boa.

## O que a 41 resolveu, e o que ela deixou de pé

A 41 fez `api_n8n_buscar_produtos` informar **quantos existem**, não só a
amostra. O agente que recebe "40 itens, mostrando 5" para de apresentar cinco
como se fossem o catálogo inteiro.

Mas quando a pergunta chega **sem termo** — *"o que vocês têm?"*, que é
justamente a pergunta que abre a conversa — a amostra continua saindo por
`order by nome`. E no `emporio` isso produz:

```
Catálogo: 40 itens disponíveis. Amostra de 5 (sem busca, ordem alfabética):
1 - Queijo Nozinho — R$ 23,00 por un
10 - Queijo Frescal Temperado — R$ 22,00 por un
11 - Pão de queijo tradicional — R$ 1,50 por un
12 - Pão Frances — R$ 1,25 por un
13 - Bolo de Milho com Requeijão Pedaço — R$ 7,50 por un
```

Os nomes começam com número de catálogo, então a ordem alfabética entrega
**1, 10, 11, 12, 13**.

> **Não parece amostra, parece defeito.**

É a frase que resume o problema e o critério de aceitação junto: o cliente final
que lê isso não pensa "escolheram cinco para me mostrar", pensa "esse sistema
está quebrado". E não há instrução de wrapper que conserte — é o dado que sai
errado.

## A regra que sai daqui

**Ordem de amostragem precisa de critério, não de `order by nome`.**

`order by nome` não é uma escolha de amostragem; é a ausência de uma. Ele responde
"quais os cinco primeiros alfabeticamente", que não é pergunta que alguém faça.
Quando for desenhar, o retorno sem termo tem de poder explicar por que aqueles
cinco e não outros — e a explicação tem de fazer sentido para quem lê.

Candidatos a critério, nenhum decidido:

- **por categoria**, um representante de cada — é o que torna a resposta uma
  pergunta útil ("temos queijos, pães e bolos — o que te interessa?");
- **por mais vendido**, que exige histórico de pedido que já existe;
- **por curadoria do tenant**, um booleano `destaque` no catálogo;
- **por faixa de preço**, cobrindo a amplitude em vez do início do alfabeto.

O primeiro é o que a fatia se chama, e provavelmente o certo: com categoria, a
resposta à pergunta aberta deixa de ser uma lista e vira **um menu de dois
níveis**, que é como a conversa acontece de verdade no balcão.

## Por que não foi resolvido junto com a 41

Porque a resposta boa depende da modelagem de categoria, e modelar categoria é
decisão de produto (uma por produto? várias? hierarquia? quem cadastra?) que não
cabia dentro de um conserto de corte silencioso. Misturar as duas teria feito a
41 esperar por uma decisão que ela não precisava.

## Gatilho

**É a próxima fatia de vendas** — não tem gatilho de evento, tem ordem. O sinal
de que ficou tarde demais é o segundo cliente com catálogo grande reclamando da
resposta à pergunta aberta; o `emporio` já é o primeiro.

## O que já está pronto quando começar

- `api_n8n_buscar_produtos` já devolve `houve_busca`, então o ramo "pergunta
  aberta" já está separado do ramo "busca" — é ali que o critério novo entra, sem
  tocar no caminho de busca por termo.
- `total_catalogo` já dá o denominador para dizer "5 de 40" em qualquer critério
  de amostragem.
- `tests/migracao-vendas.mjs` já exercita os cinco ramos do texto; o ramo sem
  termo é o único que muda.
