# Tarefa: mergear a branch `fix/segregar-chatwoot-token` (migração 16)

Correção de segurança já escrita, parada há dias. Vulnerabilidade confirmada:
`tenant_admin` lia `tenants.chatwoot_token` direto via PostgREST, porque **RLS
filtra linha, não coluna**. Qualquer cliente com acesso ao painel conseguia
extrair o token do Chatwoot da própria conta.

A branch move o token para `tenant_credenciais` (sem policy de tenant; só
super_admin e o n8n via função) e dropa a coluna de `tenants`.

Antes de começar: leia `CLAUDE.md`, `docs/ADICIONAR-TOOL.md` e o commit da branch.

## Contexto que não pode ser esquecido

**Acqua Lavanderia é cliente real em produção** (`chatwoot_account_id = 56`,
~74 conversas). O agente dela roda no n8n e lê deste mesmo banco. Não é ambiente
limpo — se `api_n8n_credencial_chatwoot` mudar de assinatura ou de shape de
retorno, o agente dela para de responder.

O n8n chama assim, e isso **não pode mudar**:

```sql
SELECT chatwoot_url, chatwoot_token FROM public.api_n8n_credencial_chatwoot($1::uuid);
```

Aparece em 3 nós do workflow principal (`Credencial (midia)`,
`Credencial (bloqueio)`, `Credencial (resposta)`) e nos sub-workflows de tool via
`api_n8n_config_tool`, que também devolve `chatwoot_url` e `chatwoot_token`.
**Confira se `api_n8n_config_tool` também lê da coluna que vai ser dropada** — se
ler, ela precisa ser atualizada na mesma migração, senão as três tools quebram.

Os workflows estão versionados em `n8n/workflows/` — dá para conferir os nós lá.

## Ordem de execução (não inverta)

1. **Branch do Supabase**, nunca produção direto. Aplique a migração lá.
2. **Teste de isolamento** com os 3 tenants do seed, incluindo tentativa de ler
   o token como `tenant_admin` via PostgREST — tem que voltar vazio ou negado.
3. **Verifique a paridade do n8n na branch**: chame
   `api_n8n_credencial_chatwoot` e `api_n8n_config_tool` e compare o retorno com
   o de produção, campo a campo.
4. **Deploy coordenado**: o código do painel (`admin/acoes.ts`) sai **junto** com
   a migração. Código antigo lendo `tenants.chatwoot_token` quebra no instante em
   que a coluna cai.
5. **Rotacionar o token do Chatwoot** depois de aplicar — ele foi exposto, trocar
   faz parte da correção. Atualize em `tenant_credenciais`.

## Requisitos do projeto

- Migração com par `_rollback.sql`
- Nome do arquivo batendo com a versão em `supabase_migrations.schema_migrations`
  (o `CLAUDE.md` explica por que isso já deu problema antes)
- Tabela nova com RLS ativo e policy na mesma migração
- `npm run build` passando sem erro de tipo
- Nenhuma `service_role` key em código client

## Ao terminar, me diga

- se `api_n8n_config_tool` precisou mudar
- o resultado do teste de isolamento
- se o token foi rotacionado
- se a migração ficou registrada no ledger com o nome certo

---

# Depois disso: núcleo de vendas

Só comece se a 16 estiver mergeada e estável.

Objetivo: o agente vender **item avulso** (quantidade × preço fixo). Assinatura e
agendamento ficam fora do escopo — entram quando um cliente pagante travar por
isso, não antes.

## Desenho já decidido

Tabelas: `produtos`, `pedidos`, `pedido_itens`.

- Preço em **integer de centavos**, nunca float
- Preço gravado em **snapshot** no item: reajuste no catálogo não muda pedido antigo
- `variacoes` e `metadados` em `jsonb` — é o que faz servir para restaurante,
  lavanderia e loja sem remodelar
- Índice único de **um pedido aberto por conversa** (`tenant_id`,
  `conversation_id`) para status em (`rascunho`, `aguardando_pagamento`)
- Status: `rascunho` → `aguardando_pagamento` → `pago` / `cancelado` / `expirado`.
  Fora de `rascunho`, o pedido **não aceita alteração**.

Funções `api_n8n_*`, todas `SECURITY DEFINER`, `search_path = public`,
`p_tenant_id` como primeiro parâmetro, grant só para o role `n8n_agent`:

| Função | Papel |
|---|---|
| `api_n8n_buscar_produtos(p_tenant_id, p_termo)` | catálogo; devolve id, nome, preço |
| `api_n8n_adicionar_item(p_tenant_id, p_conv, p_produto_id, p_qtd, p_variacao, p_obs)` | grava item, devolve **o carrinho inteiro** |
| `api_n8n_remover_item(p_tenant_id, p_conv, p_produto_id)` | idem |
| `api_n8n_ver_pedido(p_tenant_id, p_conv)` | carrinho atual |
| `api_n8n_fechar_pedido(p_tenant_id, p_conv, p_metadados)` | trava o pedido; **sem parâmetro de valor** |
| `api_n8n_cancelar_pedido(p_tenant_id, p_conv)` | libera a conversa |
| `api_n8n_tem_pedido_pendente(p_tenant_id, p_conv)` | guarda para `resolver_conversa` |

**Duas travas que não podem ser violadas:**

1. **Preço e total nunca vêm do `$fromAI`.** O agente manda `produto_id` e
   quantidade; o banco resolve o valor. Se o LLM puder informar preço, um cliente
   insistente consegue desconto — o modelo cede.
2. **Toda tool que mexe no pedido devolve o carrinho inteiro em texto.** É o que
   reinjeta o estado na memória a cada turno. A memória Redis está com
   `contextWindowLength` no default (5) — quatro trocas e o carrinho sumiria.

`api_n8n_adicionar_item` também precisa validar que o `produto_id` pertence
àquele tenant (`where id = ... and tenant_id = ...`), não só que existe.

## Lado n8n — cuidado com a Acqua

O workflow principal é **hardcoded e compartilhado por todos os tenants**: ele
não lê `api_n8n_tools_ativas`. Plugar uma tool nova no AI Agent a habilita para
a Acqua também, que não contratou vendas e tem catálogo vazio.

Por isso **todo sub-workflow de venda começa checando `tool_ativa`** via
`api_n8n_config_tool(tenant_id, '<tool_nome>')` e retorna "indisponível" se for
falso. Veja o padrão em `Tool - Transferir para Humano`, nó `Pode Transferir?`.

Siga `docs/ADICIONAR-TOOL.md` para o resto: linha em `catalogo_tools`, entrada em
`src/lib/tools/registro.ts`, `tool_nome` idêntico nos três lugares.

Mudança estrutural no n8n (criar nó, criar conexão) **não sobrevive a automação
via Pinia** — entregue como JSON pronto para importar, e valide com
`node scripts/n8n-validar.mjs <arquivo>` antes.

## Ordem sugerida

1. Migração de vendas + rollback, aplicada em branch do Supabase
2. Teste de isolamento: tenant B não vê produto nem pedido do tenant A
3. Tela de catálogo no painel (é o custo real da feature, não o SQL)
4. Sub-workflows das tools, com a trava `tool_ativa`
5. Catálogo + registro + contratar para **um** tenant de teste, nunca a Acqua

Pagamento fica fora por enquanto — sem conta em provedor ainda. `fechar_pedido`
só trava o pedido e devolve o resumo.
