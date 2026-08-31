# Pendência — o teste que caça "regex casando com comentário" foi pego por isso, via CRLF

**Estado:** achada em 2026-08-24 pela primeira execução de `npm run teste`.
**RESOLVIDA** no mesmo dia (commit `fdf700f`); doc fechado em 2026-08-31.
`teste:comparacoes-tipo` 10/0. Ver "Fechada", no fim.

**O texto abaixo é o do dia do achado, preservado**: o que ele mede — a
armadilha e por que ela passou — continua valendo, e é por isso que o arquivo
fica em vez de ser apagado.

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

---

## Fechada

**Resolvida em 2026-08-24, 10:34, pelo commit `fdf700f`** ("CRLF nos varredores e
estado arranjado no teste de foto: suite em 49/49"). Conferido em 2026-08-31: o
conserto e o que este arquivo prescreve, nao um contorno, e o teste esta verde na
suite inteira (`teste:comparacoes-tipo` 10/0).

**E o motivo de este fecho existir e ele proprio um caso.** O conserto entrou em
24/08 e este arquivo continuou dizendo **"Nao consertado"** por SETE DIAS. O
defeito nao estava no codigo — estava aqui, no documento que diz o que esta em
aberto. E a mesma serie do CLAUDE.md ("afirme PROPRIEDADE, nao estado do mundo"),
agora um andar acima: o doc de pendencia afirma um estado do mundo (o teste esta
vermelho) que o proprio trabalho torna falso, e nada reprova quando ele envelhece.

A suite tem runner que roda tudo e acusa vermelho; o indice de pendencias nao tem
equivalente. Enquanto nao tiver, **fechar o doc e passo do conserto**, no mesmo
commit — nao tarefa separada para depois.
