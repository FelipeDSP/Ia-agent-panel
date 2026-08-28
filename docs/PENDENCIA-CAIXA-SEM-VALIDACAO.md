# Pendência — o `inbox_id` entra no painel sem validação

**Gatilho: antes do QUARTO tenant conectado.** Não é data, é contagem — e o
motivo está na última seção.

Aberto em 2026-08-28, junto com a migração 54 (roteamento por conta + caixa).

---

## O que está no ar

`conectarChatwoot` (`src/app/(app)/admin/acoes.ts`) grava dois números:

| campo | validado? | como |
| --- | --- | --- |
| `chatwoot_account_id` | **sim** | `validarCredencialChatwoot` faz chamada real ao Chatwoot antes de gravar. Restrição declarada da Fase 3. |
| `chatwoot_inbox_id` | **não** | número livre. Só se confere que é inteiro ≥ 1. |

## Por que não é validado — medido, não suposto

O token que o painel guarda é de **Agent Bot**, e a API do Chatwoot recusa bot
nos endpoints que serviriam. Medido em 2026-08-28 contra os três tenants
conectados, com os tokens reais de `tenant_credenciais`:

```
GET https://app.chatyou.chat/api/v1/accounts/{1,7,59}/inboxes        -> 401
GET https://app.chatyou.chat/api/v1/accounts/{1,7,59}/conversations/{id} -> 401
{"error":"Access to this endpoint is not authorized for bots"}
```

O próprio `conectarChatwoot` já sabia disso por outro caminho: a flag `ehBot`
existe justamente para a validação **aceitar** o 401 em vez de reprovar.

## O modo de falha, escrito por extenso

Digitar a caixa errada **não produz erro em lugar nenhum**:

1. o painel grava, porque não tem como conferir;
2. a tela diz "Conectado à conta 59, caixa 280";
3. o webhook chega com a caixa 279, `api_n8n_tenant_por_chatwoot(59, 279)`
   devolve **zero linhas** — que é o comportamento certo para caixa
   desconhecida, e é silencioso de propósito;
4. `Tenant Valido?` corta o fluxo;
5. o agente para de responder, e nada no log diz por quê.

Isto é a mesma forma dos dois piores casos já registrados no `CLAUDE.md`: o
`hnsw.iterative_scan = off`, que devolve menos linhas do que o `limit` sem
avisar, e a asserção que apontava para a coluna morta da migração 21. **Funciona
sem reclamar e você descobre pelo cliente.**

## O que segura hoje, e é pouco

Uma frase na tela, em `FormChatwoot` (`componentes.tsx`), que **nomeia a
consequência** em vez de descrever o campo:

> Este campo não é conferido contra o Chatwoot. Se o número estiver errado, nada
> dá erro aqui: o agente simplesmente para de responder nessa caixa, calado.

Escolha consciente: com três tenants e uma pessoa preenchendo, o risco é baixo.
Um rótulo neutro ("id da caixa de entrada") seria pior que nada, porque deixaria
supor que o campo se defende sozinho como o de cima.

## O conserto

Trocar o token de Agent Bot por um **token de usuário** (ou guardar os dois,
separados por papel). Isso reabre `GET /api/v1/accounts/{id}/inboxes`, e aí:

- o campo deixa de ser número digitado e vira **lista das caixas da conta**,
  com nome (`"WA - Emporio"`, `"WA - Testes"`) — o que também elimina a classe
  inteira de erro, em vez de avisar sobre ela;
- `validarCredencialChatwoot` passa a conferir que a caixa **pertence** à conta;
- some a frase de aviso da tela. Aviso que deixou de ser verdade é a forma mais
  rápida de treinar todo mundo a não ler os avisos.

Pontos a decidir junto: o token de usuário tem escopo maior que o de bot, então
guardá-lo em `tenant_credenciais` aumenta o estrago de um vazamento — talvez
seja credencial **da agência**, uma só, e não por tenant.

## Por que o gatilho é "antes do quarto tenant" e não uma data

Porque o argumento que justifica não validar é **"sou eu digitando, três
vezes"**. Ele para de valer exatamente quando deixa de ser verdade: mais
tenants, ou outra pessoa preenchendo. Data não mede isso; contagem mede.

Estado em 2026-08-28 — três contas conectadas, e uma delas some na 54:

| slug | conta | caixa | fonte da caixa |
| --- | --- | --- | --- |
| `emporio` | 59 | 279 | URL do Chatwoot + payload real de webhook |
| `estudyou-sendbox` | 1 | 189 | payload real (`"inbox": {"id":189,"name":"WA - Testes"}`) |
| `ceejaar` | 7 | — | **desconhecida; a 54 solta a conta dele** (ver o comentário da seção 2 de lá) |

Então o próximo a conectar já é o terceiro, e o seguinte é o quarto.
