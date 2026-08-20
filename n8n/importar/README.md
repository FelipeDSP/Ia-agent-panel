# `n8n/importar/` — JSON pronto para importar, e NÃO a fonte da verdade

A fonte versionada dos workflows é `n8n/workflows/`. **Esta pasta é outra coisa:**
cada arquivo aqui é o resultado de aplicar UMA mudança estrutural sobre um EXPORT
recente da instância, para ser importado e depois descartado.

## Por que não sai de `n8n/workflows/`

Porque o repositório e a instância divergem em coisas que **não** são a mudança que
se quer entregar. Em 2026-08-20, o `Estima Tokens` do repo estava 30 linhas à frente
da instância (correção de comentário de 18/08 gerada e nunca importada). Gerar o JSON
a partir do repo faria a importação mudar **duas** coisas — o roteamento da pausa e o
comentário do `Estima Tokens` — e um rollback teria de desfazer as duas juntas.

Partindo do export, o import muda exatamente uma coisa e o rollback é reimportar o
export.

## O ciclo

```
1. exportar o workflow pela UI do n8n            (... -> Download)
2. node scripts/aplicar-conserto-pausa.mjs --export <arquivo baixado>
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

| arquivo | o que muda | estado |
|---|---|---|
| `agente-principal-pausa.json` | roteamento da pausa automática: remove a `ev7`, renomeia `E Humano ou Dispositivo?` para `Fala com o Cliente?`, dá destino à saída falsa, protege o payload sem `sender` | **importado em 2026-08-20** e confirmado em execução real (conta 1); ciclo fechado |
| `estima-tokens-node.js` | corpo do nó `Estima Tokens` já com os marcadores substituídos: leva o filtro de saída do `[Used tools: …]` **e** a correção de comentário de 18/08 que a instância nunca recebeu | **não colado** |

Para o `estima-tokens-node.js`: abrir o nó `Estima Tokens`, selecionar tudo no editor
de código, colar o arquivo, **clicar em Save** (o `Ctrl+S` não salva nesta instância) e
**recarregar a página** para conferir. Depois disso, `npm run n8n:diff` fecha — restam
só os nove campos de default omitido, que são ruído do lado do export.

Arquivo com o ciclo fechado pode ser apagado — ele já não é a versão corrente de
nada. Fica aqui só enquanto for útil como referência do que foi importado.

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
