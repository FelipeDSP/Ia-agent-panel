# Pendência — `Limpar Memoria` está ativo, apaga Redis e não está versionado

**Estado:** achado em 2026-08-31, na varredura da instância do n8n. **Nada foi
feito** — a decisão é uma das três abaixo e é sua. **CORRIGIDO em 2026-09-08:
dois dos três fatos que sustentavam esta pendência estavam ERRADOS** (§"As duas
correções"). O painel **chama** este webhook, e ele **tem** autenticação. Isso
tira "desativar" da mesa e deixa "versionar" como resposta.

**Gatilho: agora, e agora com uso comprovado.** É um webhook ativo apagando
chave de Redis, sem cópia nenhuma fora da instância — se a instância perder o
workflow, ninguém reconstrói a partir do repo. E em 08/09 ele foi **usado para
valer**: limpar a memória da conversa 1864 do `estudyou-sendbox` pelo painel é o
que produziu a evidência da §2.4 da
[`PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md`](PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md).
Não é mais "workflow órfão que talvez ninguém chame": é ferramenta em uso, fora
do versionamento.

## O que é

```
Limpar Memoria (Webhook do Painel)     ATIVO     8 nós     atualizado 30/07
  Webhook /limpar-memoria
    -> Valida e Prepara (code)
    -> Busca Chaves (KEYS) (redis)
    -> Expande Chaves (code)
    -> Tem Chave? (if)
    -> Apaga Chave (redis)
    -> Responde OK / Responde Vazio
```

Está na mesma pasta dos nove workflows do agente (`Agente de ia`, projeto
`wb60X1hzUujDicl7`), e é o **décimo** — os nove do repo mais este.

## Os três fatos que o tornam pendência

1. **Não está em `n8n/workflows/`.** Os outros nove estão. Este nunca foi
   versionado, então `npm run n8n:diff` o reporta como "só na instância" e não
   tem com o que comparar. É a mesma classe da Edge Function que ficou dez dias
   fora do commit e do nome de migração fora do ledger — deriva por ausência,
   não por divergência.

2. ~~**`src/` não tem nenhuma referência a ele.**~~ **ERRADO — ver §"As duas
   correções".** O painel chama: `src/lib/n8n.ts` exporta `invocarLimparMemoria`,
   `src/app/(app)/painel/conversas/acoes.ts` a chama em `limparMemoriaConversas`,
   e a interface está em `conversas/lista.tsx` e em
   `conversas/[conversationId]/controles.tsx` (componente `LimparMemoria`).

3. **Está ativo e escreve.** Os oito nós terminam num `Apaga Chave` do Redis.
   Workflow ativo com webhook é superfície exposta; workflow ativo que apaga é
   superfície exposta que destrói estado. ~~Não medi quem pode chamar o webhook~~
   — **medido em 08/09: há segredo compartilhado.** `invocarLimparMemoria` manda
   `x-limpeza-secret` a partir de `N8N_LIMPEZA_SECRET` e **recusa antes de chamar**
   se a env faltar; o escopo vai por `tenant_id`, então um cliente não alcança a
   chave de outro. O que continua não medido é se o nó `Valida e Prepara` do lado
   do n8n **confere** o segredo de verdade — o painel mandar não prova que o
   outro lado confira.

## As duas correções, e COMO elas entraram

Registrado com detalhe porque a causa é uma classe que este projeto já pegou
antes, e desta vez ela estava **dentro de um doc que seria usado para decidir
desativar um webhook ativo em produção**.

### O que estava escrito, e o que é verdade

| | escrito em 31/08 | medido em 08/09 |
|---|---|---|
| quem chama | *"`src/` não tem nenhuma referência… **O painel não chama**"* | **o painel chama**, por `invocarLimparMemoria` em `src/lib/n8n.ts` |
| autenticação | *"sem autenticação declarada no que se inspecionou"* | **header `x-limpeza-secret`**, de `N8N_LIMPEZA_SECRET`, e o painel recusa se a env faltar |

### A causa: a varredura buscou o nome errado

A varredura de 31/08 foi, literalmente:

```
grep -rn "limpar-memoria" src/ supabase/ docs/ n8n/ scripts/
```

`limpar-memoria` **com hífen e minúsculo** só existe na URL do webhook, que
aparece na documentação. O código do painel não escreve isso em lugar nenhum: ele
usa `invocarLimparMemoria`, `limparMemoriaConversas`, `LimparMemoria` — camelCase,
sem hífen. A varredura alcançou onde a referência **não** mora e concluiu ausência.

**É a mesma classe do `grep -rn "<coluna>" tests/` do CLAUDE.md**, e a mesma da
`pg_depend` vazia das funções plpgsql: a conferência tem de alcançar onde a
referência de fato mora, e o nome pelo qual você a procura é uma suposição como
qualquer outra. A diferença é a consequência: lá o resultado era um teste cego;
aqui era **um doc recomendando desativar um webhook que o painel usa**. Se a
opção "desativar" tivesse sido escolhida, o botão "Limpar memória" do painel
teria parado — e teria parado calado, porque `invocarLimparMemoria` devolve
`{ ok: false, motivo }` e a falha vira mensagem de tela, não erro de log.

**A busca que teria pego:** o nome do recurso, não o da URL —
`grep -rniE "limpar.?mem" src/`, que casa hífen, camelCase e espaço. Ou, mais
barato ainda, procurar pela env em vez do caminho: `N8N_LIMPEZA` já apareceria em
`docs/VARIAVEIS-DE-AMBIENTE.md`, que **aponta para `lib/n8n.ts:29`** — a resposta
estava indexada num doc do próprio repo o tempo todo.

### O que muda na decisão

**"Desativar" sai da mesa.** Das três saídas listadas abaixo, a que resta é
**versionar**: o workflow tem uso comprovado, tem quem o chame e tem segredo. E o
item 3 do "o que medir" muda de pergunta: não é mais *"tem autenticação?"* — é
*"o `Valida e Prepara` confere o segredo que o painel manda?"*, que só se responde
lendo o nó, na próxima janela de import.

## As três saídas, e o que cada uma custa

- **Versionar.** Exportar, gravar em `n8n/workflows/`, passar pelo
  `npm run n8n:validar` e pelo diff. Custa pouco e faz o `--completo` voltar a
  ser verdade (hoje ele afirma nove e a pasta tem dez ativos). É o caminho se o
  workflow tem uso.
- ~~**Desativar.**~~ **FORA DA MESA desde 08/09.** A premissa era "se ninguém
  chama — e `src/` sugere que ninguém"; `src/` chama, e o botão do painel
  pararia calado (`invocarLimparMemoria` devolve `{ ok: false, motivo }`, que
  vira mensagem de tela e não erro de log).
- **Documentar por que existe.** O uso **não** é manual: é o botão "Limpar
  memória" do painel, em `conversas/lista.tsx` e em
  `conversas/[conversationId]/controles.tsx`. ~~falta saber se o endpoint tem
  autenticação~~ — o painel manda `x-limpeza-secret`; falta saber se o n8n o
  confere. `docs/n8n/n8n-limpar-memoria.md` descreve o mecanismo, não a decisão.

**A que não vale é deixar como está.** A frase original aqui dizia que as três
dependem de saber quem chama; agora se sabe, e a resposta escolheu por elas:
**versionar**.

## O que medir antes de decidir

1. ~~O `Webhook Limpar` tem autenticação?~~ **Meio respondido em 08/09:** o
   painel manda `x-limpeza-secret`. A pergunta que sobra é do outro lado — o nó
   `Valida e Prepara` **confere** o header, ou aceita qualquer requisição?
2. Há execução recente dele no histórico da instância? Um mês sem execução
   responde a pergunta do uso.
3. ~~`N8N_LIMPEZA_URL` … se `src/` não a lê, é variável órfã~~ — **`src/` lê**
   (`docs/VARIAVEIS-DE-AMBIENTE.md` já apontava para `lib/n8n.ts:29`), e a
   limpeza de 08/09 funcionou, então ela **está** definida no ambiente do painel.
   Nada órfão aqui.
