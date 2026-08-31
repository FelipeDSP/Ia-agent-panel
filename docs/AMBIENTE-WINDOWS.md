# Ambiente de desenvolvimento — as três armadilhas que já custaram caro

Windows + Git Bash + node no mesmo repositório. As três coisas abaixo não são
preferência de estilo: cada uma já produziu um defeito que passou despercebido.
As duas primeiras não aparecem em diff; a terceira aparece, mas **mente sobre
onde ela está**.

---

## 1. `/tmp` resolve para lugares DIFERENTES entre `node` e o shell

**Nunca use `/tmp` num script que mistura `node` e comandos de shell.**

`node` interpreta `/tmp/x` como caminho **Windows** e escreve em `C:\tmp\x`. O
`cp`/`cat` do Git Bash interpreta o mesmo texto pelo mapeamento **MSYS** e lê de
`C:\Users\<user>\AppData\Local\Temp\x`. Os dois "funcionam", nenhum reclama, e o
arquivo que você lê não é o que você escreveu.

**O que isso já custou (2026-08-24):** um experimento salvou o
`n8n/workflows/agente-principal.json` em `/tmp/ap.bak` pelo `node` e restaurou com
`cp /tmp/ap.bak` pelo shell. O `cp` trouxe um arquivo antigo e sem relação — o
workflow voltou para uma versão de **56 nós, sem o portão de pausa inteiro**, e
`npm run n8n:sincronia` disse *"Workflow coerente com o gerador"* logo em seguida.
O erro só apareceu porque o `npm run teste` acusou **outra coisa**
(`teste:pausa`, pelas condições velhas do `Roteia Evento`). Com um restauro um
pouco menos velho, teria passado batido — e o import seguinte teria levado para
produção um agente sem proteção de pausa.

**O que fazer em vez disso:**

- para restaurar arquivo versionado: **`git checkout -- <arquivo>`**. É o único
  que não depende de caminho temporário nenhum, e foi o que funcionou;
- para arquivo de trabalho: caminho absoluto explícito, o mesmo texto nos dois
  lados, ou o diretório de scratch da sessão.

---

## 2. CRLF: metade da working copy oscila, e isso mata varredor

### O estado, medido

```
.gitattributes           NÃO EXISTE
core.autocrlf            true    (nível SYSTEM — padrão do Git for Windows)
```

`git ls-files --eol`, 371 arquivos versionados:

| índice | working copy | quantos |
|---|---|---|
| LF | **CRLF** | **237** |
| LF | LF | 120 |
| (binário para o git) | | 13 |
| LF | **misto** | 1 — `docs/DECISAO-NAO-ROTACIONAR-TOKEN-CHATWOOT.md` |

**O conteúdo no repositório é LF; o que oscila é a working copy.** Com
`autocrlf=true` e sem `.gitattributes`, todo arquivo que passa por um checkout
vira CRLF, e os escritos localmente ficam LF até o git encostar neles — daí o
aviso *"LF will be replaced by CRLF the next time Git touches it"* em quase todo
commit. **O fim de linha de um arquivo depende do histórico de checkout dele**,
que não é reprodutível e não aparece em diff.

**Dois arquivos estão pior:** `CLAUDE.md` e `docs/PENDENCIAS.md` têm CRLF gravado
**dentro do blob do índice** — foram commitados assim, o git passou a marcá-los
`-text` e parou de normalizá-los. São os dois documentos mais editados do repo.

### Por que isso mata varredor

Em JavaScript, **`.` não casa `\r`** — `\r` é terminador de linha para a engine de
regex. Então, num arquivo CRLF lido com `split('\n')`, sobra um `\r` no fim de
cada linha e qualquer regex ancorado em `$` deixa de casar:

```js
/\/\/.*$/.test('  // x')     // true
/\/\/.*$/.test('  // x\r')   // false   <- o caso real
```

**O que isso já custou:** o `teste:comparacoes-tipo` — que existe justamente para
caçar "regex casando com comentário" — passou a acusar o **próprio comentário**
que explica a armadilha. A proteção estava escrita e correta; morreu quando o
arquivo virou CRLF, sem ninguém editar nada. Ver
`PENDENCIA-AUTOCASAMENTO-CRLF.md`.

### A regra

**Todo varredor de arquivo usa `split(/\r?\n/)`**, nunca `split('\n')`. E a
sabotagem que prova um varredor **roda nos DOIS fins de linha** — sabotagem que só
roda em LF é o que deixou o defeito acima entrar e ficar.

Protegido por acidente não conta: o `conferir-sincronia-wrapper.mjs` escapava
porque o `trim()` do filtro comia o `\r`, e isso some na primeira vez que alguém
trocar o filtro. Os dois sítios dele foram corrigidos.

### O `.gitattributes` — desenho, com o efeito medido

**Gatilho: o primeiro dia sem import pendente.** Não é urgente e não deve ir junto
com nada — um `git status` gigante no meio de uma noite de import é ruído que
esconde o que importa. Commit próprio, sozinho.

O que entra:

```gitattributes
* text=auto eol=lf
*.png binary
*.jpg binary
*.pdf binary
```

Efeito, com os números na mão em vez de estimativa:

- **357 dos 371 arquivos: nenhuma mudança de conteúdo no git.** O índice já é LF;
  o que muda é o checkout parar de converter. Esses blobs não são reescritos;
- **2 arquivos mudam de verdade** — `CLAUDE.md` e `docs/PENDENCIAS.md`, cujos
  blobs têm CRLF gravado. Diff grande e cosmético nos dois, uma vez só;
- **1 arquivo** (o de fim de linha misto) é normalizado junto;
- **13** ficam de fora por serem binários.

O risco prático é um `git status` grande logo depois da normalização e conflito em
qualquer branch aberto naquele momento. Como o índice já é LF na esmagadora
maioria, é bem menor do que "237 contra 120" sugere.

Depois de aplicar, confira pelo `git ls-files --eol` e não pelo que o arquivo diz:
a linha `i/lf w/lf` tem de valer para os 358 de texto.

---

## 3. node-pg: consulta multi-statement devolve ARRAY, e o erro que você lê não é o seu

**`client.query()` com mais de um comando na string devolve uma LISTA de
resultados, não um resultado.** `r.rows` é `undefined`. Ler `r.rows[0]` estoura
`TypeError: Cannot read properties of undefined (reading '0')` — em JavaScript,
não no Postgres.

Isso sozinho seria banal. O que custa caro é o que acontece quando esse
`TypeError` cai num `catch` que faz limpeza de conexão.

### O caso (2026-08-31, `tests/migracao-pedido-novo.mjs`)

O helper era este, e o defeito está na ORDEM:

```js
const r = await c.query(sql, args);
await c.query('release savepoint sp');            // <- savepoint liberado AQUI
return { ok: true, valor: r.rows[0] ? ... };      // <- TypeError DEPOIS
```

O `catch` então tentava `rollback to savepoint sp` — um savepoint que a própria
linha anterior tinha acabado de liberar. O Postgres respondeu:

```
savepoint "sp" does not exist
```

**E foi ESSA a mensagem que apareceu.** O `TypeError`, que é o defeito de
verdade, foi engolido: o erro da limpeza substituiu o erro original antes de
qualquer um dos dois ser impresso. O teste morria no passo 0 apontando para
transação — que estava perfeita.

### Por que isso é caro: a mensagem aponta para o lugar errado

Perseguir a mensagem leva a hipóteses que são todas verificáveis, todas
verdadeiras, e todas irrelevantes. As que foram medidas antes de achar:

- *"sobrou `commit` no arquivo .sql e ele matou o savepoint"* — medido: **0
  `begin`, 0 `commit`** depois do strip, e zero ocorrências da palavra;
- *"savepoint não sobrevive a simple query multi-statement no node-pg"* — sonda
  isolada: **sobrevive**, o mesmo SQL aplicou e o `release` funcionou;
- *"o `do $$ ... $$` da migração faz alguma coisa com a transação"* — não faz.

Três medições certas, nenhuma perto do defeito. O que achou em um passo foi
**imprimir o erro primário dentro do `catch`, antes de tocar na conexão**:

```
[DBG] erro primario: undefined | Cannot read properties of undefined (reading '0')
```

`e.code` `undefined` já entrega o jogo: erro do Postgres tem código, erro de
JavaScript não.

### As regras que saem daí

1. **Limpeza dentro de `catch` vai no `try` dela mesma.** Se o `rollback to
   savepoint` / `reset role` / `end()` falhar, ele não pode substituir o erro que
   você estava tratando:

   ```js
   } catch (e) {
     try { await c.query('rollback to savepoint sp'); } catch { /* e é o que importa */ }
     return { ok: false, erro: e.message };
   }
   ```

2. **Extraia o valor ANTES de liberar o savepoint.** Enquanto houver linha de
   código que pode estourar, o savepoint ainda tem trabalho a fazer.

3. **Com multi-statement, o resultado é `r[r.length - 1]`**, e nunca `r.rows`.

4. **Erro sem `e.code` não é do banco.** É o discriminador mais barato que
   existe, e teria cortado o caminho inteiro.

### A irmã, do mesmo dia e da mesma família

```js
c.query('set local role n8n_agent; select public.f($1,$2)', [a, b])
//   -> cannot insert multiple commands into a prepared statement
```

Com parâmetro, node-pg usa o **protocolo estendido**, que aceita um comando só.
Sem parâmetro, usa o simples, que aceita vários. Então `set local role` vai em
`c.query()` próprio, sempre — e essa mensagem, ao contrário da de cima, diz
exatamente o que é.
