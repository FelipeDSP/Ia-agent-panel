# Vendas — estado e decisões

Documento vivo. Registra o que já foi decidido sobre o agente vender, para não
reabrir discussão a cada retomada.

Última atualização: 11/08/2026 · Nada implementado ainda.

## Escopo do lançamento

**Item avulso apenas:** quantidade × preço fixo. Serve restaurante, loja,
lavanderia por peça, oficina.

Fora do escopo por ora:
- **Assinatura / plano por período** — exige cliente persistente (chaveado por
  telefone, não por conversa) e controle de validade
- **Agendamento** — exige disponibilidade, conflito e fuso

Entram quando um cliente pagante travar por isso. O sinal não é "um cliente
perguntou se dá"; é "um cliente não fecha por causa disso".

Para o que não encaixa em nenhuma primitiva, a resposta certa é `transferir_humano`,
não improvisar. O agente cobre o pedido repetitivo; o humano pega a exceção.

## As duas travas inegociáveis

**1. Preço e total nunca vêm do `$fromAI`.**
O agente manda `produto_id` e quantidade; o banco resolve o valor a partir do
catálogo daquele tenant. `fechar_pedido` não recebe valor nenhum — soma os itens
no servidor. Se o LLM puder informar preço, um cliente insistente consegue
desconto: o modelo cede para ser prestativo.

**2. O pedido mora no banco, não na memória.**
`memoryRedisChat` está com `contextWindowLength` no default (5). Quatro trocas e
o carrinho evaporaria. Toda tool que mexe no pedido devolve **o carrinho inteiro
em texto**, o que reinjeta o estado a cada turno.

Mesmo princípio do `tenant_id`, que já vem do webhook e nunca do LLM:
**o LLM decide o quê, o servidor decide quanto.**

## Modelo de dados

`produtos`, `pedidos`, `pedido_itens`. Rascunho em `vendas_core.sql` (fora do
repo) — precisa de ajuste ao padrão do projeto antes de virar migração:
`deletado_em` em vez de `ativo`, grant só para `n8n_agent`, par `_rollback.sql`,
nome batendo com o ledger.

Decisões de modelagem:
- Dinheiro em **integer de centavos**, nunca float
- Preço em **snapshot** no item: reajuste no catálogo não muda pedido antigo
- `variacoes` e `metadados` em **jsonb** — é o que faz servir a verticais
  diferentes sem remodelar
- Índice único de **um pedido aberto por conversa**
- Status: `rascunho` → `aguardando_pagamento` → `pago` / `cancelado` / `expirado`.
  Fora de `rascunho`, não aceita alteração
- `adicionar_item` valida que o `produto_id` pertence àquele tenant

Isolamento entre clientes já é garantido pelo padrão existente: toda função
`api_n8n_*` recebe `p_tenant_id` e filtra por ele, RLS ativa, sem grant direto de
tabela. O agente da lavanderia não enxerga prato de restaurante porque a query
nem chega perto.

### Risco aberto: `descricao` tem dois públicos

A coluna `descricao` de `produtos` serve ao mesmo tempo para o cliente se
organizar e para o agente explicar o item. São usos diferentes: o segundo vai
para o contexto do LLM a cada busca de produto.

**Não foi criada uma `descricao_agente` separada**, de propósito — seria
especulação sobre um problema que ainda não aconteceu, sem saber o formato de
retorno da tool nem o custo real de contexto.

Se na fatia 2 a descrição virar ruído (catálogo com textos longos inflando o
prompt, agente citando detalhe irrelevante), **a tool trunca antes de mandar ao
LLM** — não se cria coluna nova. Só vale separar se truncar provar-se
insuficiente, e aí com evidência de conversa real, não com hipótese.

## Achados do cadastro real (fatia 1)

Levantados em 11/08/2026 cadastrando 16 produtos de verdade na tela — cardápio de
restaurante e serviços de lavanderia, em dois tenants. São observações de uso,
não hipóteses de projeto.

**Resolvido na hora:** faltava a unidade `pessoa` (couvert, rodízio, buffet — o
restaurante cobra por pessoa, não por unidade). Migração 24.

### Regra de negócio na descrição — não criar campo

Cadastrando, a descrição virou depósito de regra: "Prazo de 48h", "Mínimo de 3kg
por pedido", "Servida sábados e quartas", "Não atende couro legítimo".

**Não vira campo estruturado.** Já existe lugar para regra de negócio: a base de
conhecimento, que o agente busca. A linha de produto carrega o que ele precisa
para *vender* — nome, preço, unidade, disponibilidade.

E o risco real não é o que parecia. Não é o agente ler prosa e entender errado;
é ele **não conectar a regra ao produto certo** — saber que existe um mínimo de
3kg e não amarrar isso à lavagem por quilo na hora de fechar o pedido. Isso não
se resolve com coluna nova, se resolve com o desenho da conversa.

A fatia 2 responde com **comportamento observado**: rodar pedido real e ver onde
o agente erra. Só depois disso, se errar, discutir estrutura.

### Variação como produto separado — confirmado, entra na fatia 2

Na lavanderia, "lavagem de terno 2 peças" e "lavagem de paletó avulso" viraram
dois produtos. O mesmo aconteceria com tamanho de pizza, ponto da carne,
numeração de peça. Sem `variacoes`, o catálogo cresce como lista de combinações
e o cliente cadastra o mesmo item cinco vezes.

**Isto deixou de ser hipótese.** A coluna `variacoes` (jsonb) já existe em
`produtos` desde a migração 23, sem UI. Entra no desenho da fatia 2, junto com
`adicionar_item` — que precisa saber qual variação foi escolhida para resolver o
preço.

### Foto de produto — em aberto, decidir junto com `variacoes`

Levantado em 11/08/2026. **Nada implementado.** Registrado porque a decisão
depende de uma verificação que ainda não foi feita, e fazer o modelo de dados
antes dela é chutar.

**Mais de uma foto por produto** é requisito desde o começo, não evolução: uma
peça de roupa tem frente, verso e detalhe; um prato tem foto do prato e da mesa.

**O que decide o modelo é o lado do agente, não o do painel.** A pergunta é como
o Chatwoot aceita a imagem na mensagem que o agente envia:

- se aceita **URL**, o bucket pode ficar privado e o n8n manda uma URL assinada —
  mas aí o TTL da assinatura tem que cobrir o tempo até o WhatsApp buscar o
  arquivo, e isso é um prazo que não controlamos;
- se exige **upload multipart** dos bytes, o n8n baixa do Storage e reenvia ao
  Chatwoot. O bucket fica totalmente privado e o isolamento entre clientes não
  depende de URL nenhuma. **É o caminho mais seguro** — e o mais trabalhoso no
  workflow.

Antes de modelar, verificar **nesta ordem**:

1. o token de **Agent Bot** consegue enviar anexo? Sabemos que ele é recusado em
   endpoints de leitura da API de plataforma (ver
   `docs/DIAGNOSTICO-CREDENCIAL-CHATWOOT.md`); enviar anexo é outro endpoint e
   precisa de teste próprio. Se não conseguir, o resto da discussão muda —
   seria preciso um token de usuário, com implicação de segurança;
2. o endpoint de mensagem aceita URL ou exige multipart;
3. o WhatsApp carrega legenda junto da imagem, ou exige mensagem separada. Isso
   muda o texto que a tool de venda devolve.

**Storage:** hoje existe um bucket só, `kb-arquivos`, privado, limitado a
PDF/DOCX/TXT e 10MB (migração 14). Foto de produto precisa de bucket novo — o
MIME type não bate e o propósito é outro. O padrão de path a seguir é o de lá:
`{tenant_id}/{uuid}.{ext}`, com RLS de Storage escopando por tenant.

**Modelo de dados — a armadilha:** a vontade natural é `fotos jsonb` em
`produtos`, uma lista de paths. Funciona até aparecer o pedido óbvio seguinte,
que é **foto por variação** — camisa azul e vermelha não podem mostrar a mesma
imagem. Como `variacoes` também está em aberto (seção acima), as duas coisas
devem ser desenhadas **juntas**: fazer foto agora e variação depois obriga a
remodelar foto.

**Limpeza:** produto usa soft delete, então arquivo no Storage sobrevive à
exclusão. Precisa de uma regra explícita — ou o arquivo fica (barato, e o
cliente pode restaurar), ou entra uma rotina de limpeza. Decidir junto, não
depois.

### Paginação da tela de catálogo — gatilho definido

`/painel/catalogo` carrega o catálogo inteiro num `select` e renderiza tudo. Para
30 produtos é o certo; para 500 a tela trava, e o `idx_produtos_busca` (migração
23) fica sem uso no painel — ele existe só para a fatia 2.

**Gatilho:** o primeiro cliente passar de **~100 produtos**. Antes disso,
paginar custa complexidade sem ganho.

### Visibilidade de produto para o agente (fatia 2)

Regra única, também documentada no `comment` da coluna `disponivel`:

```sql
deletado_em is null and disponivel and (estoque is null or estoque > 0)
```

`disponivel` é separado de `estoque` porque "hoje não tem" não é "acabou o
estoque": forçar `estoque = 0` para pausar um item empurraria o cliente para o
modo de controle de estoque que ele não quis, e a alternativa seria remover o
produto — perdendo o cadastro para repor amanhã.

## Lado n8n — cuidado com a Acqua

O workflow principal é **hardcoded e compartilhado por todos os tenants**: não lê
`api_n8n_tools_ativas`. Plugar uma tool nova no AI Agent a habilita para a Acqua
também, que não contratou vendas e tem catálogo vazio.

Por isso **todo sub-workflow de venda começa checando `tool_ativa`** via
`api_n8n_config_tool(tenant_id, '<tool_nome>')`. Padrão em
`Tool - Transferir para Humano`, nó `Pode Transferir?`.

O "endgame" do `docs/ADICIONAR-TOOL.md` — AI Agent montando tools e system prompt
a partir de `api_n8n_tools_ativas` — vale fazer perto de 3–4 tools. Vendas soma
pelo menos 3, então a decisão chega junto.

## Pagamento

**Não iniciado.** Sem conta em provedor.

Modelo definido: você tem uma **conta raiz** e cria por API uma **conta separada
por cliente** (CNPJ dele, banco dele). O dinheiro cai direto na conta do cliente;
você nunca toca nele — se tocasse, seria intermediação financeira e exigiria
autorização do Banco Central.

Provedor provável: **Asaas** (subconta + split, Pix e boleto nativos). Stripe
descartado: histórico irregular no Brasil e sem os meios de pagamento que os
clientes esperam.

Gargalo é regulatório, não técnico:
- Período de avaliação: 10 subcontas, R$ 2.000 por subconta, 60 dias
- Só CNPJ (Resoluções Conjuntas 16 e 17 do BC)
- Modelo BaaS exige exibir a marca Asaas nos pontos de contato com o cliente final
- Liberação prévia com gerente de contas

Abrir essa conversa cedo — é papelada, não código.

## Ordem de construção

1. Migração de vendas + rollback, aplicada fora de produção primeiro
2. Teste de isolamento: tenant B não vê produto nem pedido do tenant A
3. **Tela de catálogo no painel** — é o custo real da feature, não o SQL
4. Sub-workflows das tools, com a trava `tool_ativa`
5. Catálogo + registro + contratar para **um tenant de teste**, nunca a Acqua
6. Pagamento, quando houver conta em provedor

O passo 4 antes do 6 é de propósito: a parte difícil não é gerar link de
pagamento, é o agente conduzir a conversa até lá sem se perder. Vale testar com
pedido fechado manualmente antes de plugar dinheiro.

## Pendências fora de vendas

- Limpeza do ledger — `docs/DIVERGENCIA-LEDGER-MIGRACOES.md`
- Migração 18 do índice em `mensagens_log`, barata agora com a tabela vazia
- Descobrir se a Acqua ainda usa o produto (zero tráfego desde 24/07; token não
  foi revogado, o que favorece a hipótese de webhook parado)
- `contextWindowLength` da memória Redis: subir de 5 para ~20 antes de vendas
