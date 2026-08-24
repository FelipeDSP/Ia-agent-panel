# Pendência — nenhuma guarda percebe se o portão de pausa sumir do workflow

**Estado:** medido em 2026-08-24. **Nada quebrado hoje** — o portão está lá, com
os 60 nós. O que falta é o alarme.

**Gatilho:** antes do próximo import do `agente-principal.json`. É exatamente o
momento em que o arquivo pode voltar para uma versão velha sem ninguém notar.

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

## A saída provável

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

E a sabotagem que prova o teste é a deste documento: **remover o portão e exigir
vermelho**. Se ela não derrubar, o teste novo está medindo o que as três atuais
já medem.

## O que NÃO é este item

Não é sobre o workflow estar errado hoje: `npm run teste` está em 49/49 e o
arquivo tem os 60 nós, conferido contra o git. É sobre não haver nada que avise
no dia em que deixar de ter.
