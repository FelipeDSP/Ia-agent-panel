# Pausa automática — conserto APLICADO; retomada escrita na migração 47, não aplicada

**Estado em 2026-08-20:** diagnóstico fechado com payload real; medição feita; conserto
**importado e funcionando** — confirmado em execução real na conta 1 — e
`n8n/workflows/agente-principal.json` já sincronizado com a instância (a menos do
`Estima Tokens`, divergência antiga e item próprio). `npm run teste:pausa` roda contra
o arquivo versionado.

**Estado em 2026-08-21:** a retomada está **decidida e escrita** — migração 47 e
rollback pareado em `supabase/migrations/*_47_retomada_pausa*.sql`, com
`npm run teste:retomada-pausa` (80 asserções, 7 sabotagens, transação abortada).
**Não aplicada.** Enquanto não for, toda conversa em que o dono escrever pelo celular
fica pausada até alguém abrir o painel: eram **12** em 21/08, e a contagem subiu de 11
para 12 durante a sessão em que a 47 foi escrita.

A decisão que faltava está tomada: **pausa manual NÃO caduca, pausa por mensagem
humana caduca por janela do tenant** — ver a seção "Retomada".

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

## O conserto — APLICADO em 2026-08-20

O título dizia "desenho, NÃO aplicado" e ficou assim depois de o conserto entrar no ar
— a mesma defasagem que o índice teve. Está aplicado: importado na instância,
confirmado em execução real na conta 1, e versionado em
`n8n/workflows/agente-principal.json`.

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

## Retomada — migração 47 ESCRITA, não aplicada

Consertar a pausa sem resolver a retomada troca um bug visível por um silencioso:
até a 47 entrar, **nada** volta a `'ativo'` a não ser o toggle em
`painel/conversas/[conversationId]/controles.tsx`, e o dono trabalha no WhatsApp,
não no painel. Em 2026-08-21 havia **doze** conversas paradas — dez do `emporio`,
uma do `fortalize`, e a contagem subiu de 11 para 12 durante a própria sessão em
que isto foi escrito, o que é o argumento inteiro em uma linha.

### A regra

- **pausa por mensagem humana** caduca `tenants.pausa_expira_minutos` depois da
  ÚLTIMA fala do humano responsável;
- **pausa manual** (toggle do painel) **NÃO caduca**. Só sai quando alguém
  clicar. Clique de gente é decisão explícita, e o sistema desfazer isso sozinho
  é a pior categoria de surpresa;
- janela **por tenant**. 30 min por enquanto — o ritmo de uma clínica não é o de
  um empório, e o número muda depois de medir.

### Por que a última fala do humano, e não a inatividade da conversa

Contar a partir de `conversas.atualizado_em` (que a mensagem do cliente também
empurra) não interrompe atendimento em curso, e foi descartado assim mesmo.
**As duas falhas não têm o mesmo peso, porque uma se corrige sozinha:**

- por última fala do humano: se o dono demorar mais que a janela, o bot volta e
  fala. O dono vê, escreve de novo, e a mensagem dele **re-pausa na hora** — o
  caminho de pausa dispara em TODA mensagem humana, não só na primeira. Falha
  barulhenta, visível, resolvida no turno seguinte;
- por inatividade: se o dono sumir e o cliente continuar escrevendo,
  `atualizado_em` nunca envelhece e o bot **nunca volta**. Cliente falando
  sozinho, sem bot e sem gente, sem limite e sem sintoma.

É a mesma regra do `Mensagem Pronta` e do `Perfil Não Resolvido`: falha alta
ganha de falha calada. E isso dispensa o teto de horas que o desenho anterior
previa — ele existia só para tapar a brecha do cliente abandonado.

### O que já existia e não precisou ser criado

- `api_n8n_definir_status_conversa` faz `pausado_em = now()` a cada chamada, sem
  checar se já estava pausado. Somado ao caminho disparar em toda mensagem
  humana, **`pausado_em` já é o carimbo da última fala do humano** — não precisou
  de coluna nova para o relógio;
- `Nao Pausado?` lê `{{ $json.status }}` do nó `Sync Conversa`, que é o `SELECT`
  de `api_n8n_conversa_sync`. Fazer essa função devolver o status EFETIVO deixa o
  workflow **intacto**: nenhum nó muda, a resposta é que passa a ser honesta.

### O predicado, em um lugar só

Expiração **preguiçosa**: a pausa não é desfeita por ninguém, ela deixa de valer
quando lida. Sem cron, sem trigger de agendamento, sem infra nova.

```
public.pausa_vigente(status text, pausado_em timestamptz,
                     motivo_pausa text, janela_minutos integer) -> boolean   STABLE
public.conversa_status_efetivo(mesmos 4 argumentos)             -> text      STABLE
```

`conversa_status_efetivo` é invólucro de uma linha sobre `pausa_vigente` — não
replica a regra. **Argumentos escalares**, e não `(tenant_id, conversation_id)`:
os leitores já têm a linha na mão (o `RETURNING` do sync, o join do
`pode_transcrever`, a linha da view), e uma versão que buscasse no banco leria,
no `conversa_sync`, a linha que o próprio statement acabou de escrever. Escalar
também as mantém `STABLE` sem `SECURITY DEFINER` — e `STABLE` é obrigatório,
porque `api_n8n_pode_transcrever` é `STABLE` e precisa continuar sendo. Uma
expiração que fizesse `UPDATE` obrigaria a torná-la `VOLATILE`.

Onde cada desconhecido cai — todo caminho devolve `true` ou `false`, nunca NULL,
e **sem `coalesce` no fim de propósito**: guarda inalcançável é guarda que
ninguém consegue sabotar, e teste que não pode falhar compra confiança sem dar
nada em troca.

| entrada | resultado |
|---|---|
| `status <> 'pausado'` (inclusive nulo) | não pausada |
| motivo `manual` | **pausada, sempre** — não caduca com janela nenhuma |
| motivo NULO | cai na janela, ou seja **caduca** — o lado alto |
| `pausado_em` nulo | não pausada |
| janela nula | não pausada |

Motivo nulo caindo para o lado alto é deliberado. A linha não deveria existir (a
constraint `conversas_pausa_tem_motivo` a impede), mas se existir, tratá-la como
manual deixaria a conversa muda para sempre; tratá-la como vencida faz o bot
voltar a falar, o dono ver e re-pausar.

### Quem chama — quatro pontos, não três

| chamador | o que muda |
|---|---|
| `api_n8n_definir_status_conversa` | **escreve** `motivo_pausa = 'mensagem_humana'` |
| `api_n8n_conversa_sync` | devolve `conversa_status_efetivo(...)` no lugar de `c.status` |
| `api_n8n_pode_transcrever` | `pausa_vigente(...)` no lugar de `coalesce(cv.status,'ativo') = 'pausado'` |
| view `conversas_painel` | **migração 48** |

As três funções mudam de **corpo** e nenhuma de **assinatura** — sem
`drop function`, logo sem aridade ambígua (28, 32, 37) e sem grant apagado para
reconceder (40, 41).

`api_n8n_definir_status_conversa` estar na lista **não é opcional**: sem ele a
constraint derruba a pausa do n8n na primeira mensagem humana depois de aplicada
a migração.

### A janela: `NOT NULL DEFAULT 30`

`tenants.pausa_expira_minutos`, precedente `debounce_segundos` (número de
comportamento do agente mora em `tenants`, não em `tenant_tools` — pausa não é
tool vendida).

O desenho anterior previa `null = só retomada manual`. **Isso deixou de fazer
sentido com a regra nova:** o `null` já não governa a pausa manual, que não
caduca por construção, e passou a governar só a automática — ou seja, virou "o
dono responde pelo celular e a conversa fica muda para sempre". É a falha calada
que este trabalho existe para fechar, agora acessível por configuração. E o que
o `null` compraria já tem entrada própria e explícita: o toggle. Se o modo
humano-só voltar, volta como sentinela, com a tela dizendo o que custa.

**E não pode haver `UPDATE` para popular a coluna.** `tenants` tem
`trg_tenants_guard_colunas`, um `BEFORE UPDATE FOR EACH ROW` que levanta `42501`
para qualquer coluna fora da lista branca (`system_prompt`, `agente_ativo`,
`debounce_segundos`, as duas `msg_`) a menos que `auth_is_super_admin()` seja
verdadeiro. **Coluna nova nasce fora da lista branca**, então a forma óbvia —
`add column` nullable + `update ... where null` + `set not null` — derruba a
migração inteira num apply por psql/MCP, onde não há claim de JWT nenhuma.

`add column ... not null default 30` resolve sem tocar no trigger: no PG 11+ é
mudança só de catálogo (o default fica em `atthasmissing`, sem rewrite) e DDL não
dispara trigger de DML.

Isto foi **encontrado por medição, e o teste estava mascarando**: ele setava
`request.jwt.claims` de super_admin uma vez no topo — para criar os tenants
efêmeros — e com a claim ligada a migração aplicava numa condição que o apply
real não tem. Hoje o teste aplica com a claim resetada e tem contraprova de que o
guard está vivo, mais a sabotagem **S8**, que devolve o `update` e exige `42501`.

**Consequência que fica:** com `pausa_expira_minutos` fora da lista branca, a
janela é **da agência**, não do cliente — o painel do cliente não consegue
alterá-la nem que a tela ofereça. É o default certo enquanto o número for
palpite; se um dia o cliente for regulá-lo, a coluna precisa entrar na lista
branca de `tenants_guard_colunas`, em migração própria.

### `motivo_pausa`: coluna simples, e um check de tabela

`conversas_status_check` **não é tocado**. Dois checks novos e independentes:

```sql
motivo_pausa is null or motivo_pausa in ('manual','mensagem_humana')
status <> 'pausado' or motivo_pausa is not null      -- conversas_pausa_tem_motivo
```

O segundo proíbe a única combinação que o predicado não consegue classificar.
**Não é o bicondicional** (`(status = 'pausado')` se e somente se motivo
preenchido): aquele enuncia melhor o invariante e cobra caro — todo `UPDATE` que
toque `status` sozinho passa a estourar, e o preço real não é o toggle (que muda
junto), é o caminho futuro que ninguém lembrou, quebrando em runtime em produção
em vez de degradar.

### A lápide, que é deliberada

Com expiração preguiçosa a linha vencida **continua `status = 'pausado'` na
tabela indefinidamente**, até a próxima escrita. `api_n8n_conversa_sync` poderia
limpá-la de graça (já faz `UPDATE` no mesmo statement) e **não limpa**: seriam
duas fontes para o mesmo fato, e `api_n8n_pode_transcrever` precisaria do
predicado de qualquer jeito, porque pode rodar antes do sync.

O preço é que **`conversas.status` deixa de responder sozinho a "o agente está
pausado?"** para todo consumidor, inclusive futuro. Por isso a 47 escreve isso
num `comment on column` — a alternativa é alguém descobrir pelo comportamento
daqui a seis meses.

### O painel escreve direto na tabela — e é isso que separa os dois motivos

Descoberto ao desenhar: `definirStatusConversa` em
`src/app/(app)/painel/conversas/acoes.ts` **não passa** por
`api_n8n_definir_status_conversa`. Faz `UPDATE` direto em `conversas` via
PostgREST, com `pausado_em` carimbado do **JavaScript**.

Isso é bom — os dois motivos se separam na origem, cada escritor grava o seu — e
é o que tornou possível a forense do backfill, abaixo.

### O backfill, e a conversa que quase foi retomada por engano

Medição em 2026-08-21 (consulta direta via `pg`, **sem filtro de tenant**): 11
linhas pausadas quando o desenho começou, 12 quando terminou; universo de 88
conversas, 77 `ativo`. Não há tenant fora dessa conta.

Quase todas são efeito do conserto da pausa e não foram decisão de ninguém: viram
`mensagem_humana` e **destravam sozinhas no primeiro deploy**, sem clique nenhum.
**Uma não é.**

`emporio` conversa 6 ("Karen Ceejaar", 20/08 14:16:21.355Z) foi pausada pelo
**toggle do painel** — confirmado depois pelo autor do clique, mas deduzido antes
por dois sinais independentes:

1. **o milissegundo é redondo** (`.355000`). `new Date().toISOString()` do painel
   tem precisão de milissegundo; `now()` do Postgres tem microssegundo.
   Controles de origem SQL comprovada: `mensagens_log.criado_em` 0/344 redondos,
   `conversas.atualizado_em` (trigger) 0/88, `conversas.criado_em` de agosto
   0/19. **Zero em 451.** Os redondos de maio–julho em `criado_em` são
   contaminação do `scripts/import-producao.mjs`, que carimbou do JS — o controle
   só se separa quebrando por mês, e a primeira leitura (66/88 redondos) quase
   derrubou a heurística que estava certa;
2. **os dois carimbos se separam.** `definir_status_conversa` escreve
   `pausado_em` e `atualizado_em` no mesmo `UPDATE` com um `now()` só, então
   ficam idênticos ao microssegundo (7 das 11 linhas são). O painel manda só
   `pausado_em`; `atualizado_em` vem do trigger, depois. A conversa 6: `.355000`
   contra `.367225`, **11,9 ms**. As outras que diferem (2, 10, 13) diferem por
   17 s, 9,5 min e 12 min — bumps posteriores do `conversa_sync` — e nenhuma tem
   o ms redondo.

Backfillada como `mensagem_humana`, a janela contaria de 20/08 14:16 — **já
vencida** — e ela retomaria no primeiro deploy: o bot voltando a falar numa
conversa que alguém pausou de propósito. Seria a própria migração causando a
surpresa que a regra existe para impedir.

**A heurística do milissegundo NÃO está codificada na migração**, de propósito.
Ela é evidência para decidir uma vez, não regra: reexecutada classificaria linha
nova errado, e ninguém entenderia o `case` daqui a seis meses. O que fica é a
**lista**, declarada e versionada — precedente `PEDIDOS_HISTORICOS` em
`tests/trava-vendas.mjs`.

### A separação 47 / 48, e o custo entre elas

| | o que entra |
|---|---|
| **47** | os dois predicados, `motivo_pausa`, `pausa_expira_minutos`, backfill, os **três** `create or replace`, os checks, o `comment on column`, e o toggle passando a escrever `'manual'` |
| **48** | a view `conversas_painel` com `security_invoker`, os cinco call sites do painel, o teste de RLS e a sabotagem que tira o `security_invoker` |

A view ficou de fora pelo mesmo argumento que tirou a `transferencia`: não
empilhar duas famílias de falha no mesmo deploy. **`security_invoker` é a linha
mais perigosa do desenho** — sem ela a view roda como dona e **ignora a RLS de
`conversas`**, vazamento entre clientes por uma porta nova, com a policy
`p_conversas_all` intacta e inútil. Risco alto merece deploy próprio.

E a view não é necessária para o bot parar de ficar mudo: predicado, invólucro,
colunas e as três funções já destravam as conversas paradas.

**Custo aceito de olho aberto:** entre a 47 e a 48 o painel continua lendo
`conversas.status` cru, então mostra `pausado` em conversa que já caducou e a
contagem da Visão geral não drena. O bot volta a funcionar e a tela mente por
alguns dias. **A 48 vem em seguida — isto não pode virar semanas.**

### Ordem de implantação da 47 — e aqui ela importa

1. o SQL;
2. o deploy do código.

Entre os dois o toggle do painel fica quebrado. **Medido** como `authenticated`
com as claims reais do `emporio`, contra a 47 aplicada em transação abortada:

| ordem | SQLSTATE | `error.message` que chega ao cliente |
|---|---|---|
| SQL antes (a escolhida) | `23514` | `new row for relation "conversas" violates check constraint "conversas_pausa_tem_motivo"` |
| código antes | `42703` | `column "motivo_pausa" of relation "conversas" does not exist` |

`definirStatusConversa` não tem ramo para `23514`: tem **uma** linha genérica,
`return { erro: \`Não foi possível atualizar: ${error.message}\` }`, e
`controles.tsx` joga isso num `<Alert variant="destructive">`. Então o cliente vê
o nome da constraint cru na tela — **mesma classe do `erroSelo` que já está em
aberto** (`error.message` de banco exposto ao cliente). Não é conserto desta
migração; é mais uma entrada para quando aquele item for feito.

Das duas, a `23514` ganha: ela ao menos nomeia a regra violada, enquanto a
`42703` diz "coluna não existe" para quem só clicou em pausar. E a janela da
ordem escolhida é curta e controlada — aplicar o SQL é ato manual —, enquanto na
ordem inversa ela dura o atraso do deploy, que já derivou antes neste projeto.

**Não use o toggle de pausa entre aplicar o SQL e o deploy do código.**

### O que o painel passa a mostrar (48)

O badge **não** se resolve sozinho hoje: os cinco leitores lêem a tabela, não uma
view — que aliás não existe (`information_schema.views` filtrado por `conversas`
volta vazio). Todos precisam apontar para `status_efetivo`:

| arquivo | o que lê |
|---|---|
| `painel/conversas/page.tsx` → `lista.tsx` | badge da lista |
| `painel/conversas/[conversationId]/page.tsx` | badge + toggle |
| `painel/page.tsx` | contagem de pausadas na Visão geral |
| `painel/relatorios/page.tsx` → `agregar.ts` | `pausadasAgora` |
| `admin/tenants/[id]/page.tsx` | super-admin |

Três estados na tela, não dois:

- **ativo** → badge `success`;
- pausada vigente, motivo `manual` → `warning` **"pausado"**, com o toggle;
- pausada vigente, motivo `mensagem_humana` → `warning` **"em atendimento
  humano"**, com *"o agente volta às HH:MM"* a partir de `pausa_expira_em`.
  Rótulo diferente porque o fato é diferente: ninguém pausou, alguém respondeu;
- pausada vencida → `status_efetivo = 'ativo'` → `success` "ativo".

A pausa da `Tool - Transferir para Humano` cai hoje em `mensagem_humana`, e o
rótulo "em atendimento humano" é honesto para ela também.

### O que a regra aceita: o agente volta cego para o atendimento humano

**Durante a pausa o agente não roda, então nem as mensagens do dono nem as do
cliente entram na memória do Redis.** Quando o bot volta, ele não sabe que houve
atendimento humano: vê a conversa como estava antes e responde à mensagem nova
como se nada tivesse acontecido — podendo contradizer o dono ou repetir pergunta
já respondida.

Não bloqueia nada, e a mensagem seguinte do dono re-pausa. Mas é o **formato real
do constrangimento** que a regra aceita quando escolhe falha alta em vez de falha
calada, e por isso está escrito aqui, ao lado da regra, e não em outro arquivo.

### Fica para migração própria: `transferencia`

Os dois chamadores de `api_n8n_definir_status_conversa` no n8n
(`agente-principal` no `Pausa Conversa`, e a `Tool - Transferir para Humano`)
passam `'pausado'` fixo e são **indistinguíveis em SQL**. Separar "o bot escalou"
de "o dono interveio" — perguntas diferentes, que a agência vai querer separar —
exige parâmetro novo, com `drop function` pela lista completa de tipos e os dois
grants (`service_role` **e** `n8n_agent`) restaurados e conferidos por diff de
ACL. Vai junto com a mudança do nó.

### Registrado, não consertado

`src/lib/relatorios/agregar.ts:98-105` diz que `pausado_em` preenchido marca
"alguém assumiu, **inclusive em conversa que voltou a `ativo` depois**". Não
sobrevive: tanto `api_n8n_definir_status_conversa` quanto o toggle do painel
fazem `pausado_em = null` ao despausar. A métrica `comHumano` dos Relatórios já
mede outra coisa hoje, **independente deste trabalho** — não foi a 47 que
quebrou.

É a **sétima** instância nesta série de comentário que descreve o que o código
fazia, não o que faz.

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
