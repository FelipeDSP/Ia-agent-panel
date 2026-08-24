# Pendência — nenhuma guarda percebe se o portão de pausa sumir do workflow

**Estado: RESOLVIDO em 2026-08-24**, no mesmo dia, antes do import.
`npm run teste:portao` (`tests/presenca-do-portao.mjs`) faz a asserção, e as
quatro sabotagens deste documento reprovam nele.

Fica registrado porque o **modo de descoberta** vale mais que o conserto: o
buraco existia desde a migração 48 e três verificações verdes o escondiam.

## O experimento

Removi do `n8n/workflows/agente-principal.json` os cinco nós do portão —
`Consulta Pausa`, `Nao Pausada?`, `Humano Atende (ignora)`, `Anomalia?`,
`Notifica Anomalia WAHA` — e religuei `Tenant Valido?` direto no `Roteia Acao`,
que é o workflow de antes da migração 48. Depois rodei as três guardas que
existem:

```
n8n:sincronia   ->  59 passaram, 0 falharam   "Workflow coerente com o gerador."
teste:pausa     ->  "Tudo certo."
n8n-validar     ->  "OK — 55 nos, nenhum problema conhecido"
```

**As três passam.** Um workflow sem proteção de pausa nenhuma — o estado que a
migração 48 existiu para corrigir, e em que mídia e bloqueado falavam por cima do
atendimento humano — atravessa toda a verificação do repositório sem uma linha
vermelha.

## Por que cada uma deixa passar

- **`n8n:sincronia`** compara o conteúdo dos nós de Code contra os arquivos-fonte
  em `n8n/` e confere o wrapper de token. Ele verifica **o que está lá**, nunca
  **o que deveria estar**. Nó que some não tem conteúdo para divergir;
- **`teste:pausa`** guarda o `Roteia Evento` — as condições ev3/ev6/ev8 que
  decidem se uma mensagem humana pausa. É sobre o *gatilho* da pausa, não sobre o
  *portão* que a respeita. Os dois nomes se parecem e as responsabilidades não;
- **`n8n-validar`** é lista de defeitos conhecidos por nó (parâmetro em default
  omitido pelo export, etc.). Também não sabe quais nós têm de existir.

## Como isto foi descoberto, porque o modo importa

Por acidente, e não por revisão. Ao simular um `jsCode` em CRLF, restaurei o
arquivo com `cp /tmp/ap.bak` — e **`/tmp` resolve para lugares diferentes** entre
o `node` (que escreveu em `C:\tmp\`, caminho Windows) e o `cp` do Git Bash (que
leu de `C:\Users\...\AppData\Local\Temp\`, mapeamento MSYS). O `cp` restaurou um
arquivo antigo e sem relação.

O `npm run teste` acusou — mas por outro motivo: `teste:pausa` estourou nas
condições velhas do `Roteia Evento`. **Se a versão restaurada tivesse o
`Roteia Evento` atual e não tivesse o portão, tudo estaria verde.**

Duas lições, e a segunda é a que fica:

1. **em script que mistura `node` e shell no Windows, nunca use `/tmp`.** Use o
   diretório de scratch da sessão, com caminho absoluto, ou `git checkout --`
   para restaurar — que é o que funcionou aqui;
2. **guarda de conteúdo não substitui guarda de presença.** Todas as três
   verificam o que existe. Nenhuma tem uma lista do que **precisa** existir.

## A saída — feita, e por CAMINHO e não por nó

Um teste que afirme a PRESENÇA e a FIAÇÃO dos nós que carregam invariante de
segurança, e não a lista inteira de 60 — lista completa vira ruído a cada nó novo.
Os candidatos, todos com a mesma justificativa ("se sumir, o cliente não percebe e
o dano é silencioso"):

| nó | invariante |
|---|---|
| `Consulta Pausa` → `Nao Pausada?` | conversa pausada não recebe resposta do bot |
| `Nao Pausada?` saída falsa ligada | saída solta já rodou meses em produção neste workflow |
| `Tenant Valido?` → `Consulta Pausa` | o portão vem ANTES do `Roteia Acao`, senão só protege um ramo |
| `Fala com o Cliente?` saída falsa | mesmo modo de falha, do outro lado |

**A asserção central acabou não sendo presença, e sim uma propriedade de GRAFO:**
removendo `Nao Pausada?` do grafo, `Roteia Acao` tem de ficar INALCANÇÁVEL a
partir do `Webhook`. Isso é dizer que o portão está em TODO caminho, e não num
deles — nó órfão não satisfaz, desvio paralelo não satisfaz, e a propriedade
sobrevive a alguém acrescentar nós no meio.

"O nó existe" seria fraco demais: o portão pode estar presente e DESCONECTADO,
que é exatamente o modo de falha do `E Humano ou Dispositivo?` — nó lá, saída
solta, meses em produção sem pausar ninguém.

As quatro sabotagens que o teste carrega, e o que cada uma prova:

| | o que faz | por que existe |
|---|---|---|
| S1 | remove os 5 nós do portão | o experimento deste documento |
| S2 | mantém os 5 nós e liga `Tenant Valido?` direto no `Roteia Acao` | **presente e desconectado** — e o teste tem de acusar DESVIO, não "ausente" |
| S3 | deixa a saída falsa do `Nao Pausada?` vazia | o corte continua satisfeito; é por isso que as arestas nomeadas existem além dele |
| S4 | mantém tudo e troca a query por `select true` | nó presente, ligado, consultando outra coisa passaria em todo o resto |

## O que NÃO é este item

Não é sobre o workflow estar errado hoje: `npm run teste` está em 49/49 e o
arquivo tem os 60 nós, conferido contra o git. É sobre não haver nada que avise
no dia em que deixar de ter.
