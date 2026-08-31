# Pendência — o `x-foto-secret` precisa de rotação, não de conserto de JSON

**Estado:** achado em 2026-08-31, na primeira varredura completa da instância do
n8n contra o repositório. **Não consertado, e não dá para consertar editando
arquivo** — o segredo em uso já saiu do lugar onde deveria estar.

**Gatilho: agora.** Não é "quando alguém reclamar": o segredo vaza a cada export
do workflow, e um export já aconteceu (o desta varredura).

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

Credencial do n8n não sai em export (o `/rest` devolve só `{id, name}`). Parâmetro
de nó sai inteiro. **É essa a diferença, e é a única que importa aqui.**

## Por que é rotação e não edição

O segredo em uso hoje já esteve em:

- o JSON do workflow na instância, legível por quem tem acesso à UI;
- qualquer export anterior desse workflow, em qualquer máquina;
- `~/Downloads/n8n-instancia-31-08.json` (11,7 MB, apagado em 31/08 — mas
  apagado depois de existir);
- o diretório de scratch da sessão que fez a varredura.

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
