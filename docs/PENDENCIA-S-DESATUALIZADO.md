# Pendência — o `S` do perfil de vendas foi medido com 7 tools e o perfil tem 8

**Estado:** achado em 2026-09-09, ao levantar o custo em token das ferramentas
para a [`INVESTIGACAO-POR-QUE-FABRICA.md`](INVESTIGACAO-POR-QUE-FABRICA.md) §3.
**Nada corrigido.** Não afeta cliente nenhum — afeta o número com que a agência
rateia custo entre clientes.

**Gatilho: a próxima vez que `S` for tocado, e ela está marcada.** A redação nova
das descrições de ferramenta (§7 da investigação) levaria `S` de 622 para ~964
sozinha; se ela for aplicada sem re-medição, a correção deste item vira pré-
requisito. Fora isso, é dívida fria — cresce só quando ferramenta nova entra.

## O fato, com data

```js
// scripts/gerar-principal.mjs
// `S` e o custo em token dos schemas daquele conjunto de tools, usado pelo
// Estima Tokens. O de vendas foi MEDIDO (622, ~89 por tool); ...

const TOOLS_VENDAS = ['Consultar Catalogo', 'Gerenciar Pedido', 'Fechar Pedido',
                      'Cancelar Pedido', 'Enviar Foto do Produto'];

vendas: { agente: 'AI Agent Vendas', tools: [...TOOLS_BASICO, ...TOOLS_VENDAS],
          S: 622, medido: true }
```

`622 ÷ 7 ≈ 89 por tool` — a própria nota diz sete. O perfil de vendas hoje tem
**oito**: três do básico mais cinco de venda.

Datado pelo git, e a diferença é de **um dia**:

| quando | o quê |
|---|---|
| 2026-08-11 | `188159b` — *"Fatia 3: tools por perfil"* introduz `S: 622`, medido contra as execuções `3948813 / 3948994 / 3948818`, com **7** ferramentas |
| 2026-08-12 | `d312cc2` — *"Metade 2 da foto"* acrescenta `Enviar Foto do Produto` ao `TOOLS_VENDAS`, virando **8** |

O `S` nunca foi re-medido depois. São **28 dias** de rateio subestimado para o
perfil de vendas.

## O tamanho do erro

`comp_schema_tools = chamadas × S`, então o erro entra multiplicado pelo número de
chamadas do turno.

| | |
|---|---:|
| `S` em uso | 622 |
| estimativa para 8 tools, à razão de ~89 | ~711 |
| erro por **chamada** | ~89 (−12,5 %) |
| erro por **turno** (`chamadas` médio 1,56) | ~139 tokens |
| sobre a entrada média do `emporio` (6 230) | ~2,2 % |

O `~711` é **regra de três, não medição** — é exatamente o mesmo tipo de número
que a nota do gerador marca como `medido: false` para o perfil básico. Serve para
dimensionar o erro; não serve para substituir o 622. O conserto é medir, pelo
método das duas equações que o gerador descreve, com uma execução real do perfil
de vendas.

## Por que merece item próprio, e não uma linha solta

Porque é a **reincidência exata do defeito que fez o `Estima Tokens` existir**. O
cabeçalho de `n8n/estima-tokens.js` abre com isto:

> MULTIPLICIDADE (a de 10x). Ele contava UMA chamada ao modelo. Mas cada tool call
> e outro round-trip que reenvia o prompt inteiro: a venda fez 6. E o erro cresce
> com o uso de ferramenta — ou seja, **quem vende era subcobrado contra quem so
> conversa**.

O erro de hoje é menor (−12,5 %, não −900 %) e tem a **mesma direção e a mesma
vítima**: subestima o perfil que usa mais ferramenta, isto é, cobra de menos
justamente de quem custa mais. A correção de 11/08 removeu a versão grande do viés
e a mudança de 12/08 reintroduziu uma versão pequena dele, no dia seguinte, sem
ninguém reparar — porque nada liga "acrescentar tool" a "re-medir `S`".

## O conserto, e o que ele exige

1. **Re-medir `S` do perfil de vendas** com uma execução real, pelo método das
   duas equações (duas execuções com números de chamadas diferentes resolvem `S` e
   a base). O `r` já é conhecido, então uma execução basta, como a própria nota do
   gerador diz para o caso do básico.
2. **Medir o `S` do básico junto**, se houver execução: ele está marcado
   `medido: false` desde sempre e é regra de três até hoje. São o mesmo trabalho.
3. **Ligar as duas coisas**, que é o que impede a terceira ocorrência: hoje
   `TOOLS_VENDAS` e `S` moram a oito linhas um do outro no mesmo arquivo e nada os
   relaciona. O mínimo é a contagem entrar na declaração —
   `S: 622, medido_com_tools: 7` — e o gerador reprovar quando
   `medido_com_tools !== tools.length`. Vira erro na geração, não descoberta um mês
   depois.

O passo 3 é o que vale escrever mesmo que 1 e 2 demorem: sem ele, a próxima
ferramenta repete isto pela terceira vez.

## O que NÃO fazer

Não trocar 622 por 711. É trocar um número medido e desatualizado por um número
inventado e atual, e o `medido: true` continuaria mentindo — agora sobre um valor
que nunca foi medido por ninguém. Se for para pôr estimativa, ela entra com
`medido: false`, como o básico, e fica visível que é estimativa.
