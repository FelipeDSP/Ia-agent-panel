# Pausa automática — diagnóstico fechado, conserto descrito, NADA aplicado

**Estado em 2026-08-20:** diagnóstico fechado com payload real; medição feita; conserto
**importado e funcionando** — confirmado em execução real na conta 1 — e
`n8n/workflows/agente-principal.json` já sincronizado com a instância (a menos do
`Estima Tokens`, divergência antiga e item próprio). `npm run teste:pausa` roda contra
o arquivo versionado.

**A retomada continua NÃO implementada**, e é o que falta: hoje, toda conversa em que
o dono escrever pelo celular fica pausada até alguém abrir o painel. Falta uma decisão
(pausa manual expira junto ou entra `motivo_pausa`) — ver a seção "Retomada".

Este arquivo é o lugar onde o conserto mora até virar JSON. Cada nota marcada
**[nota do nó]** é texto para colar no campo `notes` do nó correspondente quando o
JSON for desbloqueado — regra escrita só em doc não sobrevive a seis meses.

## O que está quebrado

**Nenhuma mensagem humana pausa o bot, por nenhum caminho, para nenhum tenant.**
Não é regressão do `emporio`; nunca funcionou. São dois caminhos e dois pontos de
morte diferentes.

**1. Mensagem do celular do dono (WAHA → Chatwoot).** Payload real, 10:18:06:

```
event: "message_created", message_type: "outgoing", private: TRUE,
sender: { id: 57, type: "user" },
content: "*📱 Enviado do WhatsApp*\n\nBom dia"
```

Morre no `Roteia Evento`. A saída `humano` exige quatro condições, passa em três e
reprova na **ev7 (`private = false`)**. O WAHA registra mensagem enviada pelo celular
como **nota privada** — a condição exclui exatamente o caso que o ramo existe para
pegar. Execução de 11 ms, sem sair por nenhuma porta.

**2. Mensagem digitada dentro do Chatwoot.** Payload real, 14:37:

```
event: "message_created", message_type: "outgoing", private: FALSE,
sender: { id: 65, name: "Felipe Santos", type: "user" },
content: "teste"
```

Passa nas quatro, chega no `E Humano ou Dispositivo?` e morre ali: o conteúdo não
contém marcador e **a saída falsa não está conectada a nada**.

## A medição que bloqueava o conserto — FEITA em 2026-08-20

O conserto relaxa a ev7. Depois disso, a única coisa que impede a resposta do
**próprio bot** de entrar no ramo de pausa é a **ev6 (`sender.type ≠ agent_bot`)** —
condição que nunca foi exercitada, porque o ramo morria adiante de qualquer jeito.
Se o token do tenant não fosse de Agent Bot, a resposta da Bia voltaria pelo webhook
com `sender.type: "user"`, passaria em tudo, e **o bot se pausaria sozinho depois da
primeira resposta, em toda conversa, de todo tenant.**

Resultado, `GET` puro, sem escrita:

| tenant | conta | `/api/v1/profile` | `/accounts/{id}/teams` | `/accounts/{id}/agents` |
|---|---|---|---|---|
| `emporio` | 59 | 401 `not authorized for bots` | 401 idem | 401 idem |
| `estudyou-sendbox` | 8 | 401 `not authorized for bots` | 401 idem | 401 idem |

**Os dois tokens são de Agent Bot. A ev6 protege. O conserto é seguro nesse eixo.**

Duas ressalvas que a medição não elimina:

- as impressões digitais dos tokens são **diferentes** (`2ce53011`, `2e2516da`):
  medir um não responde pelo outro, e **o próximo cliente conectado recebe um token
  cujo tipo ninguém checa**. É por isso que existe a seção "Sondar na conexão";
- `fortalize` não pôde ser medido: foi desconectado em 2026-08-20 13:03:52Z e a
  linha de credencial dele foi apagada (ver o incidente no fim deste arquivo).

## Sete produtores de `outgoing`, não um

Todos usam **o mesmo** `chatwoot_token` de `tenant_credenciais`. Uma medição por
tenant responde pelos sete — e um token que não fosse de bot quebraria os sete.

| workflow | nó | `private` |
|---|---|---|
| `agente-principal` | `Envia Mensagem Chatwoot` | false |
| `agente-principal` | `Avisa Midia Nao Suportada` | false |
| `agente-principal` | `Envia Resposta Bloqueada` | false |
| `agente-principal` | `Avisa Audio Longo` | false |
| `agente-principal` | `Avisa Audio Falhou` | false |
| `tool-enviar-foto` | `Envia ao Chatwoot` (multipart) | false |
| `Tool - Transferir para Humano` | `Nota Privada no Chatwoot` | **true** |

Se o token não for de Agent Bot, não é só a resposta que se auto-pausa: é cada aviso
de áudio e **cada foto de produto no meio de um pedido** — o caminho mais quente do
`emporio` hoje.

## O conserto — desenho, NÃO aplicado

Com "é Agent Bot" confirmado, a regra passa a ser **"fala com o cliente"**, não "veio
do celular".

1. **`Roteia Evento`, saída `humano`: remover a ev7.** A **ev3** da saída `cliente`
   FICA — nota privada não é mensagem de cliente e não deve acordar o bot.
2. **`E Humano ou Dispositivo?`** vira `private = false` **OU** conteúdo contém
   marcador. O nó precisa de **nome novo** — deixa de perguntar "humano ou
   dispositivo". Sugestão: `Fala com o Cliente?`.
   - digitada no Chatwoot (`private: false`) → pausa
   - celular do dono (`private: true` + marcador) → pausa
   - anotação interna (`private: true`, sem marcador) → NÃO pausa
3. **Ligar a saída falsa** a um NoOp nomeado (`Nota Interna (ignora)`).
4. **Prever `message_created` sem `sender`** no payload — e isso não coube na `ev6`:
   `{{ $json.body.sender.type }}` com `sender` ausente **estoura a expressão** antes de
   qualquer operador rodar (verificado contra o export cru: `Cannot read properties of
   undefined (reading 'type')`). Então a `ev6` passou a ler `sender?.type ?? ''` e
   ganhou uma **`ev8`** que exige `sender.type` preenchido. Payload sem `sender` não
   pausa — sem identidade não dá para distinguir o próprio bot, e o lado seguro é o
   que produz sintoma visível.

### [nota do nó] `Roteia Evento`

> A ev6 (`sender.type ≠ agent_bot`) é o ÚNICO guarda-corpo contra o bot se pausar
> sozinho. Ela não é proteção independente: a `Tool - Transferir para Humano` escreve
> com o MESMO token de `tenant_credenciais` que o `Envia Mensagem Chatwoot`, então ela
> e o bot caem ou passam juntos. Medido em 2026-08-20: os tokens de `emporio` (59) e
> `estudyou-sendbox` (8) são de Agent Bot (401 "not authorized for bots" em
> `/profile`, `/teams` e `/agents`). Token de tenant NOVO não é medido por ninguém —
> se vier um que não seja de bot, os sete produtores de `outgoing` se auto-pausam.
> A ev7 foi REMOVIDA: o WAHA registra mensagem do celular do dono como nota privada,
> e a ev7 excluía exatamente o caso que este ramo existe para pegar.
> `typeValidation: strict` — `message_created` sem `sender` no payload precisa de
> caminho explícito, senão estoura em vez de reprovar.

### [nota do nó] `Fala com o Cliente?` (ex-`E Humano ou Dispositivo?`)

> Dois marcadores, não um: `Enviado do WhatsApp` E `Enviado do Instagram`,
> `caseSensitive: false`. A ponte de Instagram produz a mesma forma.
> A saída FALSA tem destino (`Nota interna — ignora`) de propósito: a versão anterior
> deste nó não tinha, e por isso nenhuma mensagem digitada dentro do Chatwoot pausou
> o bot durante meses. Saída solta aqui é o modo de falha conhecido.
> A `Nota Privada no Chatwoot` da `Transferir para Humano` (`🤖 *Resumo do
> atendimento via bot:*…`) passa a ENTRAR neste ramo depois da remoção da ev7. Ela é
> inofensiva porque não tem marcador e cai no FALSO — a segurança dela depende
> inteiramente deste teste dar falso. Se alguém puser um marcador no texto do resumo,
> quebra aqui.

## Sondar na conexão em vez de assumir — desenho, NÃO aplicado

O problema de fundo: a correção do bot inteiro depende de "o token calhou de ser de
Agent Bot". É a família dos grants das migrações 40/41 — funciona porque a lista de
hoje está certa. A saída é **medir na conexão**, uma vez por cliente.

**Onde grava.** `tenant_credenciais`, não `tenants`: é propriedade **do token**, e
tem de morrer junto com ele. Migração nova, três colunas:

```
token_e_bot     boolean      -- null = nunca sondado
token_sender_id bigint       -- o id que o token escreve; null quando é bot
sondado_em      timestamptz
```

Mais um **trigger** `before update of chatwoot_token` que zera as três. Token trocado
com sondagem velha ao lado é pior que sondagem nenhuma — parece medido e não está.
RLS: a policy de `tenant_credenciais` já é super-admin-only (21a); a migração não
mexe nela.

**Como é consumido.** O `Roteia Evento` roda logo depois do `Webhook` e **não pode
consultar o banco** — o tenant ainda nem foi resolvido. Então a discriminação por
identidade não cabe no switch: ela desce para depois do `Resolve Tenant (pausa)`, que
já existe no ramo `humano` e já faz uma consulta. Com bot: continua
`sender.type ≠ agent_bot`. Sem bot: `sender.id ≠ token_sender_id` — propriedade
verdadeira independentemente do tipo do token.

**Quando a sondagem falha por rede.** Conectar **não** é bloqueado por um GET
read-only, mas o resultado desconhecido tem de escolher um lado. Aqui o lado seguro é
**não pausar**: pausar por engano deixa o bot mudo e o cliente sem resposta (falha
silenciosa); não pausar faz a IA falar por cima do dono (falha que ele relata na
hora). É o mesmo critério do guard de contratação — o que fecha é o que produz
sintoma visível —, e aqui ele aponta para o outro lado. O painel mostra "conexão não
verificada" e oferece **re-sondar**.

**Os já conectados que nunca foram sondados** são exatamente os dois de hoje, e eles
JÁ foram medidos à mão em 2026-08-20 (tabela acima). O backfill grava esse resultado
apenas onde `sondado_em is null`, e a migração não contrata nem conecta nada — a
propriedade a testar é *aplicar a migração não muda contagem de conectados*.
`fortalize` não tem linha: quando reconectar, nasce sondado.

## Retomada — decisão tomada em 2026-08-20, NÃO aplicada

Consertar a pausa sem resolver a retomada troca um bug visível por um silencioso:
hoje **nada** volta a `'ativo'` a não ser o toggle em
`painel/conversas/[conversationId]/controles.tsx`, e o dono trabalha no WhatsApp, não
no painel.

**Retoma por tempo, contada a partir da última mensagem humana.** Sai de graça:
`api_n8n_definir_status_conversa` já faz `pausado_em = now()` a cada chamada com
`'pausado'`, e o ramo de pausa roda a cada evento — então o carimbo já é o da ÚLTIMA
mensagem humana, não o da primeira.

**Sem job agendado, por expiração preguiçosa.** A pausa não é desfeita por ninguém:
ela **deixa de valer** quando lida. Predicado único —
`status = 'pausado' AND pausado_em > now() - janela` — avaliado pelos três leitores
que já existem (`api_n8n_conversa_sync`, `api_n8n_pode_transcrever`, o painel). Nada
de cron, nada de trigger de agendamento, nada de infra nova.

Detalhe que decide o desenho: **`api_n8n_pode_transcrever` é `STABLE`** e portanto
não pode escrever. Uma expiração que faz `UPDATE` obrigaria a torná-la `VOLATILE`;
um predicado puro não obriga nada. É mais uma razão para o predicado — e ele tem de
morar em UM lugar (função ou view), com os três leitores chamando. Predicado
duplicado diverge, e diverge exatamente entre "o painel diz pausada" e "o bot já
respondeu".

**Janela: 30 min, por tenant.** Coluna em `tenants` (`debounce_segundos` é o
precedente), nullable: **null = só retomada manual**. 30 min é o palpite inicial para
um atendimento humano que acabou; a clínica pode querer diferente da demonstração.

**NÃO retomar quando o cliente manda mensagem nova** — é justamente quando o dono
está no meio da conversa. Vale notar que expiração preguiçosa **não** viola isso: a
mensagem do cliente não *causa* a retomada, só *observa* a janela. Cliente que
escreve 2 min depois do dono continua sem resposta do bot; 40 min depois, com janela
de 30, o bot volta.

**O painel avisa quantas estão pausadas.** Mesmo predicado, um único
`contarPausadas()`, dois consumidores: um badge no item `Conversas` do menu e uma
linha na Visão geral. Sem tela nova — o custo é uma consulta e um badge. Efeito
colateral bom: com a expiração preguiçosa a contagem drena sozinha e passa a
significar **"em atendimento humano agora"**, que é a pergunta que o dono realmente
faz.

## Incidente aberto — `fortalize` desconectado em produção

Não é parte do conserto; está aqui porque foi encontrado ao medir.

`fortalize` (Fortalize Centro de Imunização, Ariquemes/RO — clínica de imunização
**em produção**, 104 mensagens e 4 conversas em 18–19/08) está **sem conta e sem
credencial** desde **2026-08-20 13:03:52Z**. O bot está fora do ar desde então.

Caminho: `desconectarChatwoot` com `apagar_credencial = 1` — zera
`chatwoot_account_id` e faz DELETE físico em `tenant_credenciais`. Vinte e cinco
minutos depois (13:28:29Z) o `emporio` foi conectado à conta 59.

**O número da conta antiga não é recuperável do banco.** Não há trilha de auditoria:
a coluna foi zerada, a linha de credencial apagada, e o "conta N liberada" só existe
na mensagem de sucesso da tela. Reconectar exige saber o número por fora e gerar
token novo no Chatwoot.
