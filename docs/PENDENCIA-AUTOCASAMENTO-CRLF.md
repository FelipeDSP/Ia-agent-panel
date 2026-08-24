# Pendência — o teste que caça "regex casando com comentário" foi pego por isso, via CRLF

**Estado:** achado em 2026-08-24 pela primeira execução de `npm run teste`.
**Não consertado.** `teste:comparacoes-tipo` está vermelho, 6/1.

**Gatilho:** agora. É o único vermelho da suíte que é defeito de teste e não de
arranjo, e o conserto é de uma linha — mas o que ele ensina é maior que ele.

## O sintoma

```
tests\comparacoes-de-tipo.mjs:105  [chatwoot_account_id]
   // (que cita `chatwoot_account_id === 912345`) viraria achado — já houve
FALHA nenhuma comparação estrita entre coluna bigint/numeric e número
```

O teste existe para achar comparações estritas entre coluna `bigint` (que o
node-postgres devolve como **string**) e número. Ele está acusando **o próprio
comentário que explica por que aquilo seria um achado** — o comentário que
termina com *"já houve regex casando com comentário neste repositório"*.

## A causa NÃO é a que parece

A leitura óbvia — "alguém editou o comentário e a proteção não cobre mais" — está
errada. A proteção contra auto-casamento está escrita e é correta:

```js
const linhas = src.split('\n');
...
const semComentario = linha.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
if (!semComentario.trim() || semComentario.trim().startsWith('*')) return;
```

**O que a quebrou foi o fim de linha.** O arquivo está em CRLF, `split('\n')`
deixa um `\r` no fim de cada linha, e em JavaScript **`.` não casa `\r`** — `\r`
é terminador de linha para a engine de regex. Então `/\/\/.*$/` não encontra um
fim de string onde ancorar e **não casa nada**:

```
/\/\/.*$/.test("  // x")     ->  true
/\/\/.*$/.test("  // x\r")   ->  false      <- o caso real
```

O comentário sobrevive ao "strip", vira código aos olhos do scanner, e o teste se
acusa.

**Ninguém editou nada.** O arquivo passou de LF para CRLF — o que o git faz
sozinho neste repo, com `core.autocrlf` — e a proteção morreu sem aparecer em
diff nenhum. Medido: **174 arquivos do repo estão em CRLF contra 96 em LF.**

## Por que isto é o achado da entrega

1. **É a armadilha "regex casando com comentário" acontecendo dentro do teste que
   existe para caçá-la.** A mesma família que derrubou o verificador da migração
   49, que está no CLAUDE.md, e que o próprio comentário da linha 105 cita;
2. **É a armadilha do CRLF** que o CLAUDE.md também já registra — *"sabotagem que
   não mutou nada (CRLF, e regex multi-linha com `\n` nunca casa neste repo)"* —
   aparecendo pela primeira vez fora de uma sabotagem, num **guarda de produção
   da suíte**;
3. **E ninguém viu.** Ficou verde tempo suficiente para o fim de linha mudar
   debaixo dele. Não havia comando que rodasse a suíte inteira até hoje; o rodapé
   de cada entrega lista o que quem entrega escolhe rodar, e ninguém escolhe um
   teste que não tem relação com a mudança. **O `npm run teste` achou isto na
   primeira execução.**

## O conserto, quando for feito

Uma linha: `src.split(/\r?\n/)` em vez de `src.split('\n')`. É a mesma forma que
`tests/grants-n8n.mjs:38` e `tests/views-security-invoker.mjs:90` já usam para ler
o `.env.local`.

E **a sabotagem que prova o conserto tem de ser feita nos dois fins de linha**:
converter o arquivo alvo para CRLF, rodar, e exigir que continue verde. Sabotagem
que só roda em LF é exatamente o que deixou este defeito entrar.

**Varredura feita junto** (para o conserto não ser pontual): dos varredores de
arquivo do repo, `tests/comparacoes-de-tipo.mjs:102` é o **único** que usa
`split('\n')` cru sobre fonte do repositório. `conferir-sincronia-wrapper.mjs:133`
também divide por `'\n'`, mas filtra com `l.trim().startsWith('//')`, e `trim()`
come o `\r` — está a salvo por acidente, não por escolha. Vale trocar os dois.

## O que NÃO fazer

Não silenciar a linha 105 nem reescrever o comentário para não conter o padrão.
O comentário é a documentação da armadilha; tirá-lo para o teste passar seria
apagar a única explicação de por que a proteção existe.
