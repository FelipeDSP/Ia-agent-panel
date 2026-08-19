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
