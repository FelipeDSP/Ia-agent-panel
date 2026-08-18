# Transferir para um time do Chatwoot — desenho

> **Estado: desenho, nada construído.** A medição que decidia o custo do projeto
> está feita (seção 1) e o resultado é o barato: sem conta cross-tenant, sem
> segredo novo, sem `$env`.

## 1. O que foi medido, em 18/08/2026

Token de Agent Bot do `fortalize`, conta 1, contra `app.chatyou.chat`.

```
POST /api/v1/accounts/1/conversations/1636/assignments
  {"team_id": 20}      → 200  {"id":20,"name":"suporte","description":"Suporte",
                               "allow_auto_assign":true,"account_id":1,...}
  {"team_id": 999999}  → 200  null
  {"team_id": 20}      → 200  (idêntico — repetido para não ser acaso)
  {"team_id": null}    → 200  null   (desatribui)
```

**O bot atribui.** O relato de `"Access to this endpoint is not authorized for
bots"` não se aplica a este endpoint nesta versão.

**Mas se aplica a tudo que é descoberta:**

| endpoint | resultado |
|---|---|
| `POST /conversations/{id}/assignments` | **200** |
| `POST /conversations/{id}/messages` | 200 |
| `POST /conversations/{id}/toggle_status` | 200 |
| `GET /teams` `/agents` `/inboxes` `/labels` `/conversations` | **401** `not authorized for bots` |

Os 200 de escrita são o controle que faz os 401 significarem política de bot, e
não credencial inválida.

### 1.1 O bot cria conversa? Não — medido em 18/08

A pergunta decidia se dava para validar num "atendimento técnico" criado pelo
próprio painel, em vez de mexer em conversa de cliente.

```
POST /contacts        {}                                        → 401  not authorized for bots
POST /conversations   {}                                        → 404  Resource could not be found
POST /conversations   {inbox_id:189}                            → 404  (idem)
POST /conversations   {inbox_id:189, source_id:"..."}            → 404  (idem)
POST /conversations   {inbox_id:189, source_id:"...", contact_id}→ 404  (idem)
```

O `404` é interessante e **não muda a conclusão**: ele não é o 401 de bot, ou
seja, a requisição passou da autorização e morreu resolvendo recurso. Mas as
três formas falham igual, e o caminho para sair do 404 exigiria um
`contact_id` real — que o bot não consegue obter, porque **criar contato é 401 e
listar contato também**.

Porta fechada, então. O estado "time não verificado" (seção 6) fica.

## 2. A regra que sustenta o desenho: olhe o CORPO, não o status

`team_id` inexistente devolve **200 com corpo `null`**. Status 200 aqui não
significa nada — significa "a requisição foi aceita", não "a conversa foi
atribuída".

> **O sub-workflow decide pelo CORPO:** objeto com `id` = atribuiu; `null` = não
> atribuiu.

Sem esta regra, `team_id` digitado errado vira transferência para o vazio, com
sucesso no log e nada no atendimento. É o modo de falha mais perigoso do
projeto inteiro, e o único sinal disponível — porque o bot **não consegue ler o
estado de volta** (`GET /conversations` é 401).

## 3. O que acontece com a pausa que já existe

**Os dois acontecem, e nesta ordem: pausa primeiro, atribuição depois.**

A pausa é o que faz o agente calar (`conversas.status = 'pausado'`, checado no
`Nao Pausado?`). A atribuição é roteamento dentro do Chatwoot. São mecanismos
independentes e **a atribuição não substitui a pausa** — conversa que vai para um
time com o bot ainda respondendo é pior que hoje.

A ordem não é estética, é o que decide como se degrada:

- **pausa → atribuição:** se a atribuição falhar, a conversa fica pausada e sem
  time. Alguém vê na fila geral, o bot está calado. **Degradação segura**;
- **atribuição → pausa:** se a pausa falhar, o time recebe uma conversa em que o
  bot continua falando por cima do atendente. **Degradação péssima.**

A nota privada continua existindo e ganha uma linha a mais: para qual time foi.

## 4. Como o time chega ao agente — e o que custa

`GET /teams` é 401, então **não há como popular um seletor**: o cliente cadastra.

### 4.1 Onde a descrição entra

O LLM escolhe pelo **nome**; o servidor resolve o **id** — mesmo padrão de
`produto_id`. Para escolher, ele precisa ler as descrições, e elas entram no
**System Message**, montadas a partir do banco pelo mesmo caminho que já resolve
o tenant. Não dá para pôr na descrição da tool: aquela é estática no workflow, e
o time é por cliente.

### 4.2 O teto, e por que ele existe

Isso entra em **toda chamada ao modelo** — o mesmo custo por turno que foi
medido no `system_prompt` (era 63% do turno do Empório antes da otimização).

Proposta: **120 caracteres por descrição E 720 caracteres no total**.

```
120 chars ≈ 39 tokens · 6 times ≈ 234 tokens por chamada
turno de 2 chamadas ≈ 470 tokens
```

Contra um turno de ~8.300 (Empório com o prompt novo), são ~6%. Aceitável.
Com 160 chars e 10 times seriam ~1.030 por turno, ~12% — não aceitável para uma
funcionalidade de roteamento.

**O teto que vale é o da SOMA, e o por-descrição sozinho não segura nada:**
quinze times de 80 caracteres passam em toda validação individual e custam
1.200 — o dobro do cenário de seis. Quem paga a conta é o total, então é o total
que precisa de limite; o teto por descrição existe só para uma única descrição
não comer a cota inteira.

Na prática o cliente vê **"580 de 720 usados"** somando tudo, e o formulário
recusa o que passar. Contador por campo sem contador do conjunto é a mesma
armadilha de olhar uma linha e não a tabela.

**Estourar o teto BLOQUEIA o salvamento, com o contador à vista.** Não trunca: o
texto é lido por um modelo para tomar decisão, e cortar no meio muda o sentido
sem avisar ninguém — "quando o cliente quer comprar ou pedir orçamento para
revenda" cortado em 120 vira outra regra. Truncar seria a versão silenciosa do
mesmo defeito que a seção 2 elimina.

## 5. Como o cliente descobre o `team_id`

Ele **não** descobre sozinho, e isso precisa estar escrito na tela — senão vira
chamado de suporte, toda vez.

No Chatwoot: **Configurações → Times → clicar no time**. O id é o número no fim
da URL:

```
https://app.chatyou.chat/app/accounts/1/settings/teams/20/edit
                                                       ^^
```

A tela de cadastro mostra esse caminho com o exemplo, e não como tooltip: é a
única informação sem a qual o formulário não pode ser preenchido.

**E a validação fecha o buraco** (seção 6): mesmo lendo errado, o cliente
descobre na hora.

## 6. Validação no cadastro — a peça que evita o pior caso

Ao salvar um time, o painel **tenta atribuir** e olha o corpo:

- corpo com `id` → o `team_id` existe naquela conta. Salva.
- corpo `null` → id errado, ou de outra conta. **Recusa com mensagem clara.**

É o único jeito de validar: não há `GET /teams`. E é incomparavelmente melhor
descobrir na tela do que no atendimento.

Duas exigências para essa validação não ter efeito colateral:

- **atribuir e desatribuir na mesma operação.** Validar mexe numa conversa real;
  ao terminar, ela volta ao estado anterior. `{"team_id": null}` desatribui —
  medido.
- **usar a conversa mais antiga já RESOLVIDA**, e não a mais recente. Sem
  `GET /conversations` o painel escolhe pelo próprio banco, e a mais recente é
  provavelmente um atendimento em curso — atribuir e desatribuir ali é mexer
  na tela de alguém que está trabalhando. A mais antiga resolvida ninguém está
  olhando.

Se o tenant não tiver conversa nenhuma, a validação não roda e o time é salvo
como **não verificado**, com o aviso na tela. Melhor um estado declarado do que
uma validação que finge ter acontecido.

## 6.1 E se o time for apagado no Chatwoot depois?

A validação da seção 6 roda **uma vez**, no cadastro. O time pode sumir depois —
e aí a transferência volta a ser silenciosa, que é justamente o que este desenho
existe para impedir.

**O sinal já existe e é o mesmo da seção 2:** no momento da transferência, o
corpo volta `null`. O que falta é não descartá-lo.

Regra: quando a atribuição devolve `null` em runtime, o fluxo

1. cai para o time padrão (seção 7) — o atendimento não pode parar por isso;
2. **grava a falha no time cadastrado** — algo como `verificado_em` /
   `falhou_em` na linha daquele time;
3. e o painel mostra o time com aviso: *"não encontrado no Chatwoot na última
   transferência"*, com o botão de revalidar ao lado.

Assim o cliente descobre pelo painel, e não por um atendimento que não chegou.
É o mesmo raciocínio de `PENDENCIA-PERGUNTA-SEM-RESPOSTA`: o sinal existe no
momento em que a coisa falha, e o valor está em **persistir** em vez de deixar
passar.

**Não** revalidar periodicamente em background: seria atribuir e desatribuir
conversas de clientes reais numa rotina, sem ninguém pedindo. O evento de
transferência é o momento honesto de descobrir.

## 7. O time padrão

Obrigatório, e não só porque "o modelo às vezes erra". Com `null` silencioso, sem
padrão o cliente fica **sem transferência e sem aviso**.

Regra: nome que o modelo mandou e não casa com nenhum time → vai para o padrão,
e a nota privada diz que foi para o padrão e qual nome ele tentou. Esse texto na
nota é o que permite descobrir que falta um time — é o mesmo raciocínio da
pendência do "não soube responder".

## 8. O que ficaria por fazer, na ordem

1. tabela de times por tenant (`team_id`, nome, descrição ≤120, padrão sim/não);
2. cadastro no painel — **superfície da tool `transferir_humano`**, então só
   existe para quem contratou, com as três checagens (menu, rota, Server Action);
3. o System Message passa a receber o bloco de times do tenant;
4. `transferir_humano` ganha o parâmetro de time via `$fromAI`; o sub-workflow
   resolve nome → id no banco, **pausa, atribui e confere o corpo**;
5. a nota privada passa a dizer o time.

## 9. O que este desenho descarta, e por quê

**A conta de administrador cross-tenant.** Ela só seria necessária para listar
times e popular um seletor. Pagar uma credencial que compromete **todos** os
clientes para economizar um campo de texto é troca ruim — e o argumento não é
teórico: a migração 43 acabou de fechar uma exposição em que o token de um
cliente saía por rota pública. Um segredo cross-tenant no mesmo sistema teria
transformado aquilo em incidente de todos.
