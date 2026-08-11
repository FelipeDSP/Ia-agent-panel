# Runbook — importar a fatia 2 de vendas no n8n

O que fazer na UI do n8n para colocar as tools de venda no ar. **Este é o único
passo da fatia 2 que a Acqua sente**: o workflow principal é compartilhado por
todos os clientes.

Tudo o que dá para automatizar já está automatizado. O que sobra aqui é o que
exige a UI — importar workflow e reapontar referência — porque mudança estrutural
não sobrevive a automação via Pinia (`n8n/README.md`).

---

## Passo 0 — congelar o "antes" (não pule)

O repositório tem uma cópia do workflow principal, mas a instância do n8n é que
manda. Se alguém editou pela UI desde o último commit, o diff da mudança de
vendas ficaria misturado com essa deriva.

1. No n8n, abra **Agente Multi-Tenant (Supabase)** → `...` → **Download**
2. Substitua `n8n/workflows/agente-principal.json` pelo arquivo baixado
3. `node scripts/n8n-limpar-export.mjs n8n/workflows/agente-principal.json`
4. `git diff n8n/workflows/agente-principal.json`

- **Diff vazio** → o repo estava em dia. Siga.
- **Diff com conteúdo** → é deriva da instância. Commite como *"antes: deriva da
  instância"* ANTES de aplicar vendas, e **reexecute os geradores**:
  ```
  node scripts/gerar-workflows-vendas.mjs
  node scripts/gerar-principal-vendas.mjs
  ```
  Eles são reexecutáveis e reconstroem a partir do arquivo atual.

---

## Passo 1 — importar os 4 sub-workflows

Para cada arquivo, **Workflows → ... → Import from File**:

| Arquivo | Nome que aparece |
|---|---|
| `n8n/workflows/tool-consultar-catalogo.json` | Tool - Consultar Catalogo (Multi-Tenant) |
| `n8n/workflows/tool-gerenciar-pedido.json` | Tool - Gerenciar Pedido (Multi-Tenant) |
| `n8n/workflows/tool-fechar-pedido.json` | Tool - Fechar Pedido (Multi-Tenant) |
| `n8n/workflows/tool-cancelar-pedido.json` | Tool - Cancelar Pedido (Multi-Tenant) |

**Anote o ID de cada um** — está na URL depois de `/workflow/`. O import sempre
cria workflow novo com ID novo; é por isso que o principal vem com placeholder.

Confira a credencial de Postgres em cada nó (`Agent ia Supabase`). O import
costuma casar pelo id, mas se a instância for outra ele deixa em branco.

---

## Passo 2 — reimportar o Resolver Conversa (corrigido)

`n8n/workflows/Tool - Resolver Conversa (Multi-Tenant).json` mudou. **Dois
defeitos, ambos pré-existentes:**

1. ele buscava `tool_ativa` e **nunca checava** — o fluxo ia direto de
   `Busca Config` para o Chatwoot. Desligar "Resolver conversa" no painel não
   surtia efeito nenhum;
2. não havia guarda de pedido pendente — o agente encerraria a conversa com o
   carrinho em aberto.

Importe por cima (ou substitua o conteúdo). **Se o ID mudar, atualize a
referência no principal** — hoje é `lT5oxXJKulPdlPPR`.

---

## Passo 3 — importar o principal e reapontar os IDs

1. Importe `n8n/workflows/agente-principal.json`
2. Nos 4 nós novos, o campo **Workflow** está com placeholder. Troque pelo ID
   real anotado no passo 1:

```
Consultar Catalogo  →  SUBSTITUIR_ID_CONSULTAR_CATALOGO
Gerenciar Pedido    →  SUBSTITUIR_ID_GERENCIAR_PEDIDO
Fechar Pedido       →  SUBSTITUIR_ID_FECHAR_PEDIDO
Cancelar Pedido     →  SUBSTITUIR_ID_CANCELAR_PEDIDO
```

3. Confira que os 3 nós antigos (`Busca Conhecimento`, `Transferir para Humano`,
   `Call 'Tool - Resolver Conversa'`) continuam apontando para os IDs certos
4. **Save**

Depois de reapontar, baixe o principal de novo e atualize o arquivo no repo com
os IDs reais — senão o próximo import repete o trabalho. Atualize também a
tabela de IDs em `n8n/README.md`.

---

## Passo 4 — provar a trava ANTES de deixar rodando

A ordem importa: `Busca Config` → `Vendas Ativa?` são os dois primeiros nós
depois do trigger, **antes** de qualquer Postgres de escrita e de qualquer HTTP.
Se a checagem estivesse depois, uma conversa da Acqua criaria linha em `pedidos`
antes de descobrir que a tool está desligada — vazaria dado, não só
comportamento.

```bash
npm run teste:trava-vendas
```

Ele imprime os dados para a execução manual. Em cada um dos 4 sub-workflows:
**Execute Workflow** → preencher os inputs com o `tenant_id` da Acqua → executar.

**Esperado nos quatro:** o ramo `Vendas Indisponivel`, e nenhum nó de Postgres de
escrita colorido como executado.

Depois dos quatro, rode de novo:

```bash
npm run teste:trava-vendas
```

O teste falha se qualquer tenant sem vendas contratada tiver pedido. **É o banco
que decide, não a resposta do workflow** — uma checagem posicionada depois de um
efeito colateral ainda devolveria "indisponível" com a linha já gravada.

---

## Passo 5 — medir o TOKENS_FERRAMENTAS de verdade

O `Estima Tokens` está com `TOKENS_FERRAMENTAS = 320`, **provisório**. O valor
antigo (110) era constante calibrada para 3 tools; agora são 7.

Não dá para derivar do texto: o schema das tools é contado como prompt token
pela API e não aparece no que o nó vê. Medição:

1. Abra uma execução recente do principal, entre no sub-nó **OpenAI Chat Model**
2. Anote `tokenUsageEstimate.promptTokens`
3. Compare com o que o `Estima Tokens` registrou na mesma execução
4. A diferença é o valor real — ajuste a constante e reexecute
   `node scripts/gerar-principal-vendas.mjs` (ele preserva o número que estiver lá)

Errar isso não quebra nada visível: só faz o rateio de custo por tenant mentir.
Por isso é passo separado, com número anotado.

---

## Passo 6 — contratar para UM tenant de teste

**Nunca a Acqua.** Admin → cliente → Módulos → contratar **Vendas** para
`restaurante-teste`, que já tem catálogo com 13 produtos.

Depois disso o agente daquele cliente passa a vender. Uma conversa de ponta a
ponta pelo WhatsApp de teste fecha a validação.

---

## Se der errado

Reimporte o `agente-principal.json` do commit anterior — é o "antes" do passo 0.
As tools de venda param de existir para o modelo; nada mais é afetado, porque as
migrações 25–27 não alteraram nada que já existia.

Para desligar sem reimportar: descontrate **Vendas** do tenant na tela de
Módulos. A trava `tool_ativa` passa a recusar, e o efeito é imediato — mas o
custo de token dos schemas continua, porque os nós seguem pendurados no AI Agent.
Esse custo só some com o endgame (ver `docs/VENDAS-ESTADO.md`).

---

## Conferência rápida, a qualquer momento

```bash
npm run n8n:sincronia      # System Message do AI Agent == WRAPPER do Estima Tokens
npm run teste:trava-vendas # nenhum pedido para quem não contratou
node scripts/n8n-validar.mjs n8n/workflows/agente-principal.json
```
