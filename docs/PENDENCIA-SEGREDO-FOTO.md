# Pendência — o `x-foto-secret` precisa de rotação, não de conserto de JSON

**Estado:** achado em 2026-08-31, na primeira varredura completa da instância do
n8n contra o repositório. **Não consertado, e não dá para consertar editando
arquivo** — o segredo em uso já saiu do lugar onde deveria estar. **Conferido em
2026-09-08: continua igual na instância**, valor literal no nó `Assina URL`,
credencial `Header Auth account 4`.

**Gatilho: agora, e a previsão já se cumpriu TRÊS vezes.** Não é "quando alguém
reclamar": o segredo vaza a cada export do workflow. Em 31/08 isso era um risco
previsto com um caso; em **08/09 aconteceu a segunda vez** e em **09/09 a
terceira** — três em nove dias, todas em conferências de rotina que precisavam
baixar os workflows. Ver a §"O que se mediu".

**E o que muda a leitura do gatilho é a DIREÇÃO, medida em 09/09.** A tabela
abaixo dizia que "os dois lados estão errados de formas diferentes", o que sugere
simetria e não há: **o repo tem o desenho seguro — segredo em credencial — e a
instância roda o inseguro.** O repo não está errado, está *incompleto* (o id da
credencial é placeholder); a instância está *insegura*. O conserto de desenho já
existe escrito e nunca foi importado.

O corolário prático, e ele é contraintuitivo: **importar o arquivo do repo hoje
não conserta — piora.** O nó trocaria um segredo em texto claro que *funciona*
por uma credencial que não resolve, e a quebra apareceria em runtime, na primeira
foto que um cliente pedir (§"O placeholder, enquanto isso"). A ordem é rotação
primeiro, import depois — nunca o contrário.

## O que se mediu

O nó `Assina URL` do `Tool - Enviar Foto do Produto (Multi-Tenant)` diverge entre
repo e instância, e os dois lados estão errados de formas diferentes:

| | repo | instância (produção) |
|---|---|---|
| header 0 | `Content-Type: application/json` | **`x-foto-secret: <64 hex>`** |
| credencial | `Foto Produto - x-foto-secret` (id `FOTO_SECRET_HEADER`) | `Header Auth account 4` |

**Na instância o segredo é valor literal de parâmetro do nó.** Não está em
credencial: está no JSON do workflow, em texto claro. Isso significa que **todo
export leva o segredo junto** — quem exportar o workflow pela UI, quem puxar pela
API, quem tirar backup. Aconteceu em 31/08: a varredura baixou o segredo para
`~/Downloads` sem que ninguém tivesse essa intenção.

**Aconteceu de novo em 08/09, e é a previsão desta pendência se cumprindo em oito
dias.** A frase acima — "todo export leva o segredo junto" — foi escrita em 31/08
como risco. Em 08/09, uma conferência de rotina da instância contra o repositório
(`diff-n8n-instancia.mjs --completo`, que exige baixar os workflows) levou o
segredo para `~/Downloads` pela **segunda** vez. Ninguém quis exportar o segredo:
quiseram conferir se a instância bate com o repo, que é trabalho normal e vai se
repetir. **É esse o argumento para a rotação sair da fila** — não é um acidente
que se evita com cuidado, é uma consequência de uma tarefa que precisa acontecer.
Enquanto o segredo for parâmetro de nó, toda conferência futura o copia de novo.

Os arquivos de 08/09 foram apagados no mesmo dia (os dois de `~/Downloads` e a
cópia do scratch), e a varredura depois confirmou que só restou o **nome** da
credencial no repo, sem valor. Apagar continua não desfazendo nada: vale o que
está escrito na seção seguinte.

**Terceira vez em 09/09, e o motivo foi de novo trabalho normal.** Um export
completo dos nove workflows foi baixado para
`C:\Users\estud\Desktop\export-09-09\` para rodar
`diff-n8n-instancia.mjs --dir <pasta> --completo` — a conferência que a
[`INVESTIGACAO-POR-QUE-FABRICA.md`](INVESTIGACAO-POR-QUE-FABRICA.md) §1 exige
antes de tocar em descrição de ferramenta, porque sete delas são órfãs. O segredo
veio inteiro dentro de
`Tool - Enviar Foto do Produto (Multi-Tenant).json`, como das outras duas vezes.

**Três ocorrências, três motivos diferentes, nenhum descuido.** 31/08 foi a
primeira varredura da instância; 08/09 foi uma conferência de rotina; 09/09 foi um
pré-requisito declarado de outra investigação. A previsão desta pendência não é
mais previsão — é a taxa observada de uma tarefa que vai continuar acontecendo.
**A pasta do Desktop ainda existe e tem o segredo dentro** enquanto não for
apagada, e apagar continua não desfazendo nada.

### A pergunta que só se responde abrindo a credencial — e ela é passo da rotação

Medido em 09/09, o nó `Assina URL` da instância tem **dois** mecanismos de
autenticação ao mesmo tempo:

```
header literal :  x-foto-secret: <64 hex>
credencial     :  Header Auth account 4   (httpHeaderAuth)
```

O export traz `{id, name}` da credencial e **nunca o valor**, então daqui não dá
para saber o que ela injeta. As duas possibilidades levam a passos diferentes:

- **se a credencial também injeta `x-foto-secret`**, o header está sendo mandado
  **duas vezes** hoje, e qual vence depende de precedência do nó — o que também
  significa que pode existir um **segundo segredo em uso** que ninguém enumerou,
  e a rotação tem de trocar os dois;
- **se ela injeta outro header, ou está vestigial**, o literal é o único portão e
  o passo 4 abaixo é simplesmente removê-lo.

**Não dá para adiar a resposta para depois da troca**: se houver dois segredos e
só um for rotacionado, o antigo continua válido e a rotação não terminou. Por isso
vira passo próprio, **antes** de mexer no nó.

**E a linha de 31/08 abaixo estava errada, o que piora o quadro.** Ela dizia que
o `~/Downloads/n8n-instancia-31-08.json` tinha sido "apagado em 31/08". Em 08/09
ele **ainda estava lá** — 439.701 bytes, carimbo `2026-08-31 11:14`, com o
segredo dentro —, e só foi apagado agora. Oito dias, não zero. O tamanho anotado
lá (11,7 MB) também não é o do arquivo encontrado; não dá para saber se houve
dois arquivos ou se o número foi anotado errado, e por isso a linha foi corrigida
para o que se **mediu**, não para o que se supõe.

Credencial do n8n não sai em export (o `/rest` devolve só `{id, name}`). Parâmetro
de nó sai inteiro. **É essa a diferença, e é a única que importa aqui.**

## Por que é rotação e não edição

O segredo em uso hoje já esteve em:

- o JSON do workflow na instância, legível por quem tem acesso à UI;
- qualquer export anterior desse workflow, em qualquer máquina;
- `~/Downloads/n8n-instancia-31-08.json` — anotado aqui como "apagado em 31/08",
  mas **conferido em 08/09: ainda existia**, 439.701 bytes, carimbo
  `2026-08-31 11:14`. Apagado só em 08/09, depois de oito dias em disco;
- `~/Downloads/n8n-instancia-2026-09-08.json` — o export da conferência de 08/09,
  416.577 bytes, apagado no mesmo dia;
- o diretório de scratch das duas sessões que fizeram varredura.

Trocar o JSON para usar credencial **não desfaz nada disso**. O valor continua
válido enquanto a Edge Function o aceitar. Só a rotação encerra a exposição.

## Onde ele é validado, do lado da aplicação

`supabase/functions/foto-produto/index.ts`:

```ts
const FOTO_SECRET = Deno.env.get('FOTO_SECRET')!;
// ...
if (!FOTO_SECRET || FOTO_SECRET.length < 24) return false;
if (recebido === null || recebido.length !== FOTO_SECRET.length) return false;
// comparação de tempo constante, byte a byte
if (!segredoConfere(req.headers.get('x-foto-secret'))) { /* 401 */ }
```

A função é publicada com `verify_jwt = false` — **o header é o único portão.** O
comentário no próprio arquivo diz isso. Não há segunda camada: um segredo
conhecido é acesso à função.

## O que a rotação precisa, na ordem

0. **Abrir a credencial `Header Auth account 4` no n8n e anotar qual header ela
   injeta e com que valor.** É a pergunta da seção acima e é do lado de dentro da
   UI — nenhum export responde. O resultado decide o resto: **se ela também manda
   `x-foto-secret`, há dois segredos em uso e os passos 1 e 2 têm de trocar os
   dois**; se manda outro header ou está vestigial, segue como escrito. Sem este
   passo, a rotação pode terminar deixando o segredo antigo válido por uma porta
   que ninguém enumerou.
1. **Gerar segredo novo** com 32+ caracteres aleatórios. O comprimento importa:
   a função recusa qualquer coisa com menos de 24, e a comparação é por
   igualdade de comprimento antes do byte a byte.
2. **`supabase secrets set FOTO_SECRET=<novo>`** — passo já descrito no
   `RUNBOOK-VENDAS-N8N.md`, seção F1.
3. **Atualizar a credencial do n8n**, não o parâmetro do nó: Header Auth com
   **Name** `x-foto-secret` e **Value** o segredo novo. O `Name` tem de ser
   exatamente esse — a função lê `req.headers.get('x-foto-secret')` e um nome
   diferente vira `null`, que é 401 no meio de um atendimento.
4. **Tirar o header literal do nó na instância** e deixar a autenticação só pela
   credencial. Enquanto o valor literal existir, o passo 1 não terminou de valer.
5. **Padronizar o nome da credencial nos dois lados.** Hoje a instância usa
   `Header Auth account 4`, que é o nome default que o n8n dá — não diz nada
   sobre o que é. O repo já usa `Foto Produto - x-foto-secret`; a instância passa
   a usar o mesmo, e aí o diff para de acusar.
6. **Trocar o `id` da credencial no repo** pelo id real da credencial nova, e
   **remover `FOTO_SECRET_HEADER` de `PLACEHOLDERS_CONHECIDOS`** em
   `scripts/n8n-validar.mjs`. A partir daí a regra 9 passa a **reprovar** aquele
   arquivo se o placeholder voltar — que é o comportamento que se quer para todo
   placeholder que não tenha decisão escrita.
7. **Re-rodar** `npm run teste:n8n-validar` (o aviso tem de sumir) e
   `node scripts/diff-n8n-instancia.mjs --dir <export> --completo` (as três
   divergências do `Assina URL` têm de sumir).

## O placeholder, enquanto isso

`FOTO_SECRET_HEADER` não tem forma de id do n8n — ids são nanoid de 16
alfanuméricos (`MehTUROZlPmHG8kW`). **E o n8n importa assim mesmo**, sem
reclamar: o nó fica sem credencial resolvida e a quebra só aparece em runtime, na
primeira foto que um cliente pedir.

A regra 9 do validador passou a pegar isso. Ela **reprova** qualquer id fora da
forma, com uma exceção declarada e datada — este placeholder, com o motivo e o
ponteiro para cá. Exceção declarada informa; exceção inferida esconde. E a lista
some no passo 6.

**Por que aviso e não falha, para este:** a decisão de adiar a rotação é sua e
está escrita. Suíte vermelha por item já decidido e adiado é como se ensina todo
mundo a ignorar vermelho — a nota do CLAUDE.md sobre afirmar estado do mundo vale
igual aqui. O que não pode passar em silêncio é placeholder **novo**, e esse
reprova.

## O que NÃO fazer

Não editar o valor literal no JSON do repo para "arrumar" o arquivo. Isso
colocaria o segredo no controle de versão, que é estritamente pior do que estar
só na instância: git não esquece.
