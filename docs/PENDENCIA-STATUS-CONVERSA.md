# Pendência — espelhar o status do Chatwoot em `conversas`

> **Registrada em 19/08/2026. NÃO construída.** Passa pelo workflow
> compartilhado, então fica **para depois da demonstração do `emporio`**.

## O que está errado hoje

`public.conversas.status` aceita `ativo | pausado | resolvido` no CHECK, mas
**ninguém nunca escreve `'resolvido'`**. Verificado em 19/08:

| status | linhas | desde |
|---|---|---|
| `ativo` | 72 | 05/05/2026 |
| `pausado` | 1 | 17/08/2026 |
| `resolvido` | **0** | — |

Os três caminhos de escrita, todos conferidos:

- `api_n8n_definir_status_conversa` é chamada em dois pontos — o sub-workflow de
  transferência e o nó de pausa do agente principal —, e os dois passam
  `'pausado'` **fixo na query**;
- no painel, `ControlesConversa` só alterna `pausado ? 'ativo' : 'pausado'`;
- **não existe** webhook de `conversation_status_changed` do Chatwoot em lugar
  nenhum do repositório.

O CHECK aceitar o valor dá aparência de estado suportado. É estado morto.

## Por que isso importa, e não é pela validação de time

O motivo imediato apareceu no cadastro de times (a verificação procurava uma
conversa `resolvido` e nunca achava), e **isso já foi contornado** — o alvo passou
a ser a conversa menos recentemente tocada, qualquer status.

O motivo que sobra é maior: **o painel mostra como `ativo` conversa encerrada há
meses.** As 66 da Acqua estão assim — a última mensagem é de julho, o atendimento
acabou, e a tela de Conversas as apresenta como abertas. Quem olhar para decidir
alguma coisa decide sobre um retrato falso.

E agora existe uma segunda tela dependendo disso: os Relatórios contam
"conversas" e "quantas o agente resolveu sozinho" sobre a mesma base.

## O que já existe e volta a fazer sentido

Levantado por `grep -rn "resolvid" src/` em 19/08 e conferido item a item — são
**cinco**, e nenhum foi apagado de propósito: no dia em que `'resolvido'` passar
a ser escrito, todos voltam a ter função. Um inventário incompleto é pior que
nenhum, porque quem for fazer confia nele e deixa o resto para trás.

| arquivo:linha | o que é |
|---|---|
| `src/app/(app)/painel/conversas/lista.tsx:22` | badge `resolvido` na lista de conversas |
| `src/app/(app)/painel/conversas/[conversationId]/page.tsx:70` | **segundo badge**, na tela da conversa |
| `src/app/(app)/admin/tenants/[id]/page.tsx:303` | badge equivalente na tela do admin |
| `src/app/(app)/painel/conversas/acoes.ts:11` | `STATUS_VALIDOS` aceita `'resolvido'` |
| `src/app/(app)/painel/conversas/acoes.ts:57` | mensagem "Conversa marcada como resolvida." |

Não entraram na conta, e vale dizer por quê: as três linhas de
`painel/acoes.ts:274-279` são o comentário que **documenta** o estado morto, e
`conversas/acoes.ts:70`, `theme-toggle.tsx:14` e `registro.ts:292` usam
"resolvido" em outro sentido (valor obtido do banco), não o status.

**E a lista de conversas não filtra por status** — uma conversa `resolvido`
apareceria normalmente, com o badge. Nada a esconderia.

### Um caminho de escrita que ninguém sabe que existe

`STATUS_VALIDOS` aceitar `'resolvido'` torna o valor **gravável hoje**:
`definirStatusConversa` valida contra esse conjunto e faz o UPDATE. Não há botão
na tela que mande esse valor — `ControlesConversa` só alterna ativo/pausado —,
mas quem chamar a Server Action diretamente grava.

**Não é furo de isolamento:** o UPDATE filtra por `tenant_id` do JWT e por
`conversation_id`, e devolve erro quando alcança zero linhas. O problema é outro:
é um caminho de escrita sem porta visível, e o efeito colateral não é óbvio —
o mesmo UPDATE zera `pausado_em` quando o status não é `'pausado'`, e
`pausado_em` é o que os Relatórios usam para contar "precisaram de uma pessoa".

**Esta pendência precisa decidir se ele fica.** As saídas são três: manter e
passar a usar (com botão), tirar `'resolvido'` de `STATUS_VALIDOS` até o
espelhamento existir, ou deixar como está e documentar. Não consertado agora de
propósito — mexer nisso antes de decidir o desenho do espelhamento seria refazer
depois.

## O que precisaria ser feito

1. **Webhook de mudança de status** do Chatwoot chegando ao n8n
   (`conversation_status_changed`, ou o evento equivalente da versão em uso —
   confirmar antes, não presumir);
2. o fluxo chama `api_n8n_definir_status_conversa(tenant, conversa, 'resolvido')`
   — a função já aceita o valor, nada de migração;
3. e `reopened` volta para `'ativo'`, senão o espelho só anda para um lado.

## Cuidados

- **Passa pelo workflow compartilhado**, e `tool_ativa` NÃO protege este caminho
  — não é tool. Um erro aqui afeta todos os tenants que recebem webhook, não só
  quem contratou alguma coisa;
- o webhook do Chatwoot chega por conta, e o roteamento para tenant é por
  `chatwoot_account_id` — o mesmo caminho que o agente já usa, e a mesma
  exigência de acertar o tenant antes de escrever;
- conversa que o Chatwoot resolve **enquanto o bot está pausado** não pode
  voltar a `'ativo'` sozinha: pausa e resolução são estados diferentes, e hoje
  moram na mesma coluna. Isso precisa ser decidido antes de escrever código —
  possivelmente é a hora de separar em duas colunas.

## Gatilho

Depois da demonstração do `emporio`. Antes disso, o custo de mexer no workflow
compartilhado é maior que o de uma tela que mostra conversa velha como aberta.
