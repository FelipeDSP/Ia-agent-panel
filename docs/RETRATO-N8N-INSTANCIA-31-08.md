# Retrato — instância do n8n contra o repositório, 2026-08-31

**Primeira vez que o ciclo fechou inteiro:** `verificados: 9 de 9`. Até aqui o
`n8n:sincronia` comparava o ARQUIVO com o GERADOR e o `n8n:diff` só tinha sido
rodado sobre o workflow principal. Os oito sub-workflows nunca tinham sido
conferidos contra a instância.

Fonte do lado "instância": os workflows da pasta `Agente de ia` (projeto
`wb60X1hzUujDicl7`, pasta `rzEq3lg1pHV8Lfkk`), lidos pela sessão do navegador em
31/08. Comparador: `scripts/diff-n8n-instancia.mjs --completo`.

## O que a pasta tem, e o que a tela mostra

| | quantos |
|---|---|
| arquivos em `n8n/workflows/` | **9** |
| workflows que a UI lista na pasta | **10** |
| workflows que a API devolve na pasta | **15** |

**A UI esconde os arquivados; a API não.** Os cinco que só a API mostra:

```
Agente de ia conversasional   31 nós   ARQUIVADO
Agente de ia disparador       29 nós   ARQUIVADO
Agente de ia remarketing      10 nós   ARQUIVADO
Agente de ia transfertool      8 nós   ARQUIVADO
My workflow 43                 2 nós   ARQUIVADO
```

Ficaram fora do diff de propósito — arquivado não é produção. Mas registrar a
diferença importa: quem contar pela tela acha 10, quem contar pela API acha 15, e
os dois estão certos. Alguém vai tropeçar nisso, e o tropeço mais provável é
concluir que a API está trazendo lixo de outra pasta.

O décimo ativo, sem contrapartida no repo, é o `Limpar Memoria (Webhook do
Painel)` — item próprio em [`PENDENCIA-LIMPAR-MEMORIA.md`](PENDENCIA-LIMPAR-MEMORIA.md).

## O resultado

**21 divergências em 3 workflows.** Seis sub-workflows saíram sem divergência
nenhuma: Busca KB, Resolver Conversa, Transferir para Humano, Cancelar Pedido,
Consultar Catalogo, Fechar Pedido.

Das 21, **15 são ruído e 6 são reais** — e a separação foi feita nó a nó, não
pelo rótulo do comparador.

### O ruído (15), e por que é ruído

Campo que a instância omitiu porque o valor bate com o default do nó:

| campo | valor no repo | por que omitir não muda nada |
|---|---|---|
| `parameters.tail` | `false` | é o default |
| `parameters.maxItems` / `keep` | `1` / `firstItems` | defaults do nó Limit; o `Volta a Um Item` virou `parameters: {}` |
| `options.response.response.outputPropertyName` (×2) | `data` | default do HTTP Request |
| `rules.values.N.outputKey` (×7) | nomes dos ramos | **conferido:** `fallbackOutput` e `renameFallbackOutput` são IGUAIS nos dois lados; o roteamento é posicional e só o rótulo do ramo some |

Os sete `outputKey` mereciam a conferência: se `renameOutputs` divergisse, o ramo
mudaria de identidade. Não diverge.

### Real 1 — `Consulta Pausa` sem credencial no repo (CONSERTADO em 31/08)

```
Consulta Pausa · credentials.postgres
   repo:      (ausente)
   instância: Agent ia Supabase
```

Dos **dez** nós Postgres do agente principal, era o **único** sem credencial no
arquivo do repo. Importar o arquivo trocaria um portão de pausa funcionando por
um nó sem com o que se conectar.

**Desde quando:** commit `c4514d0`, **2026-08-21** — o commit que *criou* o
portão de pausa. Conferido nos quatro commits que tocaram o arquivo desde então
(`c4514d0`, `eb6c976`, `a6c9fa0`, `968db45`): **SEM credencial em todos**. Dez
dias, e o arquivo nunca foi importável nesse período.

**Causa:** o gerador não tem helper para nó Postgres — cada um é empurrado com
`credentials: CRED_PG` escrito à mão. O `Consulta Pausa` foi empurrado sem.

**Por que nada pegou:** o JSON é válido, o nó existe, a query está certa, as
referências `$('...')` apontam para nós que existem. As sete regras do
`n8n-validar.mjs` olhavam **expressão** e **topologia**. Nenhuma perguntava se o
nó tem com o que se conectar.

**Conserto (31/08):** a linha entrou no **gerador**, não no arquivo — o gerador
reescreve o JSON e um conserto só no arquivo duraria até a próxima geração. O
`agente-principal.json` foi regerado e mudou exatamente seis linhas, só a
credencial. A guarda é a **regra 8** do validador, mais o `teste:n8n-validar`,
que a sabota e exige que fique vermelha.

**A inversão que isso registra:** a instância estava CERTA e o repo errado. É o
sentido oposto do que este projeto costuma assumir ao dizer "importa o arquivo do
repo".

### Real 2 — o segredo da foto em texto claro na instância

Item próprio, com o procedimento de rotação:
[`PENDENCIA-SEGREDO-FOTO.md`](PENDENCIA-SEGREDO-FOTO.md).

### Real 3 — a saída 4 do `Qual Acao?` não tem destino na instância

`Tool - Gerenciar Pedido (Multi-Tenant)`:

```
                       repo                     instância
options.fallbackOutput   3                        3          (existe nos dois)
Qual Acao? main[3]    -> Acao Invalida          -> (nada)
Acao Invalida vem de     Qual Acao?[main3]        Vendas Indisponivel[main0]
```

Os dois lados têm a quarta saída no Switch. No repo ela vai para `Acao Invalida`;
**na instância ela não vai a lugar nenhum**, e o nó `Acao Invalida` está pendurado
no caminho de vendas desligada.

**A consequência:** ação fora de `adicionar`/`remover`/`ver` cai na saída 4 e
morre ali — o sub-workflow **não devolve nada** ao agente.

É a mesma família da saída solta do `E Humano ou Dispositivo?`, que passou meses
assim. E conversa direto com a
[`PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md`](PENDENCIA-VENDA-AFIRMADA-SEM-TOOL.md):
tool que não devolve nada é a condição em que o modelo inventa o resultado. **Não
é afirmação de causa** — os casos medidos lá não foram rastreados até aqui. É a
constatação de que o caminho existe e está aberto.

**O repo já está certo.** O conserto é do lado da instância, importando
`tool-gerenciar-pedido.json` — **vai na próxima janela de import**.

## A capacidade dormindo do `cancelar_pedido`

A migração 55 trocou `api_n8n_cancelar_pedido` de 2 para 3 argumentos. O nó
`Cancela Pedido` manda dois:

```sql
SELECT public.api_n8n_cancelar_pedido($1::uuid, $2::bigint) AS resultado;
```

**Isso não quebra, e foi verificado chamando** — a string verbatim, como
`n8n_agent`, contra a produção migrada:

```
OK  a chamada de 2 argumentos RESOLVE
    -> NADA FOI CANCELADO: nao ha carrinho aberto nesta conversa...
assinaturas vivas: 1
  p_tenant_id uuid, p_conversation_id bigint, p_alvo text DEFAULT NULL::text
```

Uma assinatura só (sem ambiguidade) e `DEFAULT` no terceiro (sem `42883`).

**Mas registra-se o que fica inalcançável:** com `p_alvo` sempre `null`, o agente
só chega ao carrinho. **Cancelar venda fechada pelo número não existe na
prática** até o workflow mandar o terceiro argumento. O default seguro foi
decisão nossa (opção 3, §10.1 da pendência de venda afirmada) e continua certa —
o que não pode acontecer é isso virar "achamos que dava e não dava" no dia em que
alguém precisar cancelar uma venda.

Quando for feito: o nó passa a mandar um terceiro item no `queryReplacement`, com
o número que o modelo informar, e o `p_alvo` só aceita número — qualquer outro
texto cai no carrinho, que é o desenho da opção 3.

## Como refazer este retrato

```
# exportar da UI para uma pasta (um por vez), ou puxar pela sessão do navegador
node scripts/diff-n8n-instancia.mjs --dir <pasta> --completo
node scripts/diff-n8n-instancia.mjs --dir <pasta> --completo --resumo   # só o agrupamento
npm run n8n:validar        # as nove regras sobre os arquivos do repo
npm run n8n:sincronia      # arquivo x gerador (é outra pergunta)
```

**Nada foi importado nesta varredura.** A instância está exatamente como estava.
