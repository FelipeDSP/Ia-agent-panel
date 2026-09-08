# Pendência — campo órfão no `agente-principal.json` é imortal e invisível

**Estado:** achado em 2026-09-08, ao sabotar a regra nova do `sessionTTL`
(`PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md` §2.4). **Nada escrito** — as duas saídas
estão descritas abaixo e a escolha é sua.

**Gatilho: não é urgência, é dívida que só cresce.** Não há incidente conhecido.
O que há é uma classe de deriva **sem detector**, dentro do próprio repositório,
num arquivo de 140 KB que ninguém lê inteiro. Cada campo ajustado à mão na UI do
n8n e colado no JSON entra nessa categoria, e o custo de descobrir depois cresce
com o tamanho do arquivo.

## O fato

`scripts/gerar-principal.mjs` começa com:

```js
const ARQ = path.join(RAIZ, 'n8n', 'workflows', 'agente-principal.json');
const w = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
```

Ele **lê o próprio arquivo de saída e o muta em cima**, e reescreve no fim. Não
constrói o workflow do zero. A frase que o projeto vinha repetindo — *"o gerador
reescreve o JSON, então conserto só no arquivo dura até a próxima geração"* —
vale para **sobrescrita** e não para **remoção**:

| | campo que o gerador SETA | campo que o gerador NÃO seta |
|---|---|---|
| editar à mão no JSON | some na próxima geração | **fica para sempre** |
| tirar a linha do gerador | **não tira o campo do JSON** | n/a |

A segunda coluna é o buraco: um campo posto à mão nunca aparece no gerador, nunca
some numa regeração, e nada o compara com nada.

**E o `n8n:sincronia` não pega.** Ele compara o **wrapper** (o código dos nós
Code, que mora em `n8n/*.js`) com o que está no JSON. Não compara o conjunto de
campos do workflow com o que o gerador produziria. São verificações diferentes, e
a que falta é a segunda.

**O `n8n:diff` também não pega**, e por um motivo pior: ele compara o repo com a
**instância**. Um campo órfão que existe nos dois lados — porque veio da UI e foi
colado no repo — sai **verde** nas duas ferramentas. É deriva que passa por
concordância.

## Como isto foi descoberto, e a parte que ensina

A sabotagem óbvia da regra nova do `sessionTTL` era: comentar
`no('Redis Chat Memory').parameters.sessionTTL = 2400` no gerador, regerar, e
exigir que o validador ficasse vermelho.

**Ela não funcionou — e não funcionou em silêncio.** O gerador rodou, imprimiu
`60 nós`, `layout preservado`, e o campo continuou no JSON. A leitura natural
desse resultado é *"a regra não pega"*, que teria mandado reescrever uma regra
que estava certa. O que salvou foi a exigência do CLAUDE.md de **confirmar que a
mutação entrou** antes de acreditar no resultado: `grep -c sessionTTL` devolveu
`1` quando deveria devolver `0`.

A sabotagem válida é **tirar o campo do JSON**, não a linha do gerador — e essa
inversão é o achado, porque vale para qualquer regra futura sobre este arquivo:

```
validador com o campo fora do JSON  -> exit 1, mensagem certa
validador com o campo de volta      -> exit 0
md5 do arquivo restaurado           -> igual ao de antes
```

**A lição transferível:** quando a ferramenta que produz o artefato também o lê,
a sabotagem tem de mirar o **artefato**, não a receita. Mirar a receita mede a
receita, e o que está sob teste é o artefato.

## As duas saídas, e o que cada uma custa

### A. O gerador passa a construir do zero

Montar `w` a partir de um literal no próprio script — ou de um `base.json`
mínimo versionado — em vez de ler a saída anterior. Campo que ninguém escreveu
deixa de existir, e "tirar a linha e regerar" volta a ser sabotagem válida.

- **a favor:** elimina a classe inteira, não a detecta. Torna o gerador
  declarativo, que é o que todo mundo já supunha que ele fosse;
- **contra, e não é pouco:** o arquivo tem **60 nós** e o gerador hoje preserva
  coisas que ninguém enumerou — posições do canvas (ele imprime *"layout do
  canvas preservado, nenhum nó reposicionado"*), `id`s de nó, `webhookId`s,
  `typeVersion`s, credenciais. Construir do zero obriga a enumerar **tudo** isso,
  e o primeiro esquecimento vira um import que reposiciona o canvas inteiro ou
  perde uma credencial — que é exatamente o estrago da
  `PENDENCIA-REGRA-CREDENCIAL-INCOMPLETA.md`;
- **risco de transição:** a primeira geração depois da mudança tem de sair
  **byte a byte igual** à atual, ou não dá para saber o que foi intenção e o que
  foi perda. Esse é o teste que a opção A precisa, e ele é caro de escrever.

### B. Um detector de campo órfão

Um `teste:campo-orfao` que gera o workflow para um arquivo temporário **a partir
de um base mínimo** e compara o conjunto de caminhos de campo com o do
`agente-principal.json` versionado. Todo caminho presente no versionado e ausente
no gerado é órfão, e a lista sai com nome de nó e caminho.

- **a favor:** não mexe no gerador, não arrisca o canvas, e produz uma **lista**
  em vez de um comportamento novo. Dá para rodar hoje e ver o tamanho do
  problema antes de decidir;
- **contra:** precisa do mesmo "base mínimo" da opção A para ter com o que
  comparar — ou seja, paga metade do custo dela;
- **e vai ter falso positivo legítimo:** campo que o n8n grava sozinho no
  export (`webhookId`, `id`) é órfão por definição e não é defeito. A lista de
  exceção é obrigatória, e vale a advertência da §6 do doc irmão: detector com
  falso positivo que ninguém tratou é detector que todo mundo aprende a ignorar.

**Recomendação, para quando for decidir:** **B primeiro, A depois se a lista
justificar.** B responde a pergunta que hoje não tem resposta — *quantos campos
órfãos existem?* — e é reversível. Escolher A sem essa lista é reescrever o
gerador no escuro, e o custo dele é proporcional ao que ele hoje preserva sem
ninguém saber.

## O que NÃO fazer

Não "consertar" acrescentando ao gerador as linhas dos campos que hoje são
órfãos, um a um, sem a lista. Sem saber quais são, isso é adivinhação, e cada
linha acrescentada por engano passa a sobrescrever um valor que a instância
podia ter ajustado de propósito — que é como o `responsesApiEnabled` virou o
motivo de existir o `diff-n8n-instancia.mjs`.
