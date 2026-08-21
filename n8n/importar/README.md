# `n8n/importar/` — VAZIA de propósito. Importe de `n8n/workflows/`.

> **Se você veio aqui procurando o que importar: não é aqui.** O arquivo é
> **`n8n/workflows/agente-principal.json`** — e leia a seção "Como importar" no
> fim, porque `Import from File...` SOMA nós em vez de substituir.

A fonte versionada dos workflows é `n8n/workflows/`. **Esta pasta era outra coisa:**
cada arquivo aqui era o resultado de aplicar UMA mudança estrutural sobre um EXPORT
recente da instância, para ser importado e depois descartado.

## Por que ficou vazia (2026-08-21)

**A premissa que justificava a pasta deixou de valer, e o arquivo velho virou
armadilha.**

Em 21/08 o `agente-principal-pausa.json` daqui estava com **57 nós e sem o
`Consulta Pausa`** — era o arquivo do conserto de 20/08, já importado, ciclo
fechado. Quem fosse importar o portão de pausa e pegasse este por estar numa pasta
chamada "importar" **desfaria o portão e ressuscitaria o `Conversa Ativa?` e o
`Nao Pausado?`**, que a religação matou. Faltou pouco para acontecer.

E a razão de a pasta existir era esta: *"o repositório e a instância divergem em
coisas que não são a mudança que se quer entregar"* — concretamente, o
`Estima Tokens` do repo estava 30 linhas à frente da instância. **Isso acabou.** O
export de 21/08 foi conferido contra o repo:

| | instância | repo |
|---|---|---|
| nós | 57 | 57 |
| arestas | 65 | 65 |
| `Estima Tokens` | 597 linhas, 32.417 bytes | **idêntico byte a byte** |

Zero divergência de nó ou de aresta. As 10 que o `npm run n8n:diff` acusa são
campos que a UI **omite** por baterem com o default — e ali o repo é a fonte mais
rica, não a mais pobre.

Com repo e instância iguais, gerar um intermediário aqui não isola mudança
nenhuma: ele seria uma cópia do `n8n/workflows/agente-principal.json` com um nome
diferente e uma data de validade que ninguém lembra de checar. Duas fontes para o
mesmo fato, que é o defeito que este projeto vem removendo em todo lugar.

**Quando voltar a fazer sentido:** se um dia o `n8n:diff` acusar divergência REAL
(não campo de default) entre repo e instância, e for preciso entregar uma mudança
sem carregar a divergência junto. Aí o ciclo abaixo volta a valer — e o arquivo
gerado sai daqui **assim que o passo 6 fechar**, em vez de ficar de lembrança.

## O ciclo (para quando a pasta voltar a ser usada)

```
1. exportar o workflow pela UI do n8n            (... -> Download)
2. node scripts/aplicar-conserto-pausa.mjs --export <arquivo baixado> --saida <nome novo>
   ^ PASSE `--saida`. O padrao dele e `n8n/importar/agente-principal-pausa.json`,
     que e o nome do conserto de 20/08 — ja aplicado. Sem `--saida`, o script
     RECRIA o arquivo que foi apagado por ser armadilha, com o nome de uma
     mudanca que ja aconteceu.
3. node scripts/n8n-validar.mjs n8n/importar/<saida>.json
4. npm run teste:pausa
5. importar o JSON no n8n, conferir RECARREGANDO a pagina
6. exportar de novo e atualizar n8n/workflows/agente-principal.json
   (é este passo que devolve a mudança para a fonte versionada)
```

O passo 6 não é opcional: enquanto ele não acontece, `npm run n8n:diff` acusa a
diferença — que é o comportamento certo, porque a instância REALMENTE está diferente
do repo.

## Por que o export precisa dos parâmetros repostos

O n8n **omite no export todo parâmetro cujo valor bate com o default do node**. Três
deles não podem valer por default (o teto de uma resposta por mensagem, LPOP x RPOP, e
o nome do binário que a transcrição consome) — `scripts/n8n-validar.mjs` barra o
export cru por causa disso, e o script de conserto os repõe. Ver `n8n/README.md`,
seção "O export do n8n OMITE parâmetro em default".

## `Import from File...` SOMA nós, não substitui o workflow (2026-08-20)

Descoberto tentando importar o `agente-principal.json` inteiro sobre o workflow
aberto: em vez de trocar o conteúdo, o n8n **acrescentou** os 57 nós aos 57 que já
estavam lá. O canvas dobrou e apareceu um `Webhook1` — o mesmo sufixo de colisão que o
`n8n/README.md` conta ter rodado meses em produção como nó órfão. A ação foi
descartada sem salvar (o `Save` fica vermelho e nada persiste até alguém clicar).

Consequência prática: **para mudança de UM nó, não importe o workflow inteiro.** Abra
o nó, substitua o corpo e salve. É por isso que existe o `estima-tokens-node.js` aqui.

Para mudança estrutural (nó novo, conexão nova), o import continua sendo o caminho —
mas então é preciso partir de um workflow VAZIO ou limpar o canvas antes, e conferir a
contagem de nós depois de recarregar a página.

## Conteúdo

**Nenhum arquivo além deste README.** Os dois que existiam foram apagados em
21/08, os dois com o ciclo fechado:

| arquivo | por que saiu |
|---|---|
| `agente-principal-pausa.json` | importado em 20/08 e confirmado em execução real; ficou desatualizado no dia seguinte e virou armadilha (57 nós, sem o portão) |
| `estima-tokens-node.js` | dizia "não colado", e **estava colado** — o export de 21/08 mostra o `Estima Tokens` da instância byte a byte igual ao do repo |

O histórico dos dois está no git; o README guarda o que eles ensinaram.

## Como importar o `agente-principal` (o que você provavelmente veio fazer)

Arquivo: **`n8n/workflows/agente-principal.json`**. Confira antes:

```
node scripts/n8n-validar.mjs n8n/workflows/agente-principal.json
npm run n8n:sincronia
```

E **não** use `Import from File...` sobre o workflow aberto — ver a seção acima:
ele SOMA. Para mudança estrutural, o canvas tem de estar vazio antes. Depois de
importar, **recarregue a página** e confira a contagem de nós; se der o dobro,
foi soma e o `Save` ainda não foi clicado.

## Como o passo 6 foi feito desta vez, e por que não foi um "colar o export"

Substituir `n8n/workflows/agente-principal.json` pelo export cru faria **duas**
coisas erradas de uma vez: apagaria do repo os três parâmetros que o export omite
por baterem com o default (e o `n8n-validar.mjs` passaria a reprovar o próprio
arquivo versionado), e reverteria o `Estima Tokens` do repo para a versão mais
velha que roda na instância.

O que foi feito: rodar a MESMA transformação sobre o arquivo do repo —
`node scripts/aplicar-conserto-pausa.mjs --repo --export n8n/workflows/agente-principal.json
--saida n8n/workflows/agente-principal.json`. A flag `--repo` pula a higiene de
export (o `meta.instanceId` do arquivo versionado é escrito pelo
`gerar-principal.mjs`; tirá-lo aqui criaria churn que o gerador desfaz).

Isso deixa repo e instância iguais **a menos do `Estima Tokens`**, que segue
divergente de propósito e é item próprio. `npm run n8n:diff` continua acusando
essa linha — e deve mesmo, porque a instância REALMENTE está atrasada nela.
