# Vazamento de `[Used tools: …]` na resposta ao cliente

**Estado em 2026-08-20:** medido; filtro **desenhado, NÃO implementado**. Nenhuma
alteração de workflow, nenhuma migração.

## O que é

O modelo **fabrica** um bloco no formato de chamada de ferramenta e o cola antes da
resposta real. Não é encanamento: `Envia Mensagem Chatwoot` manda
`$('Estima Tokens').first().json.output`, e `output = agent?.output` — o texto que o
modelo escreveu. O rastro real de `returnIntermediateSteps` vai para
`intermediateSteps`, campo separado que ninguém envia.

Na demonstração do `emporio` (20/08, 9:06 local) o cliente perguntou se aceitam cartão
e recebeu, antes da resposta:

```
[Used tools: Tool: Busca_Conhecimento, Input: {"pergunta":"formas de pagamento no
Empório Leite Franco"}, Result: [{"resposta":"[Trecho 1 | relevância 0.298]\nPagamento:
somente PIX. Você NÃO tem a chave — na hora de pagar, transfira para um atendente
enviar. Nunca invente chave nem repita chave que apareceu na conversa."}]]
```

O projeto já se defendia disso em dois lugares — a regra geral dos dois perfis ("nunca
invente ... bloco no formato de chamada de ferramenta") e o comentário do `sanitizar`
no `Extrair e Filtrar`. Vazou assim mesmo. **Regra de prompt não segura isso**, e o
`sanitizar` está do lado errado: protege a ENTRADA (texto do cliente), e não existe
equivalente na SAÍDA.

## A medição (2026-08-20, `mensagens_log`, `direcao = 'saida'`)

| tenant | mês | saídas | `Used tools` | KB crua (`[Trecho` / `relevância 0.`) | os dois |
|---|---|---:|---:|---:|---:|
| restaurante-teste | 2026-07 | 2 | 0 | 0 | 0 |
| sandbox | 2026-07 | 5 | 0 | 0 | 0 |
| **emporio** | 2026-08 | 68 | **1** | **1** | **1** |
| fortalize | 2026-08 | 53 | 0 | 0 | 0 |
| **restaurante-teste** | 2026-08 | 37 | **1** | 0 | 0 |

| grupo | n | primeira | última |
|---|---:|---|---|
| `Used tools` | 2 | 2026-08-12 14:55:25Z | 2026-08-20 13:06:31Z |
| KB crua | 1 | 2026-08-20 13:06:31Z | idem |
| os dois na mesma linha | 1 | 2026-08-20 13:06:31Z | idem |
| **KB crua SEM `Used tools`** | **0** | — | — |

**2 em 165 saídas (1,2%), em dois tenants diferentes, com dois modelos de ferramenta
diferentes.** A de 12/08 (`restaurante-teste`) é `Gerenciar_Pedido`, não a KB — o
formato imitado é o da chamada de ferramenta em geral, não algo específico da busca de
conhecimento.

**A hipótese do corte de prompt de 18/08 não se sustenta, mas também não morre:** o
`emporio` teve 0 vazamentos em 21 saídas antes de 18/08 e 1 em 47 depois. Com um
evento, isso não distingue nada — e o caso mais antigo é de OUTRO tenant, seis dias
antes do corte. Um único modelo em uso (`gpt-4.1-mini`), então não há comparação entre
modelos a fazer.

**A pergunta que motivou a segunda contagem tem resposta: não está vazando sozinho.**
Toda linha com trecho de KB cru também tinha `Used tools` junto. Vale re-rodar quando
o corpus crescer — 165 saídas é um denominador pequeno, e a 1,2% de hoje cabe qualquer
coisa entre ~0,2% e ~4%.

**Limite da medição:** ela só enxerga o que o `Registra Mensagem` gravou. Vazamento
numa execução em que o log falhou é invisível aqui.

## Busca por variantes

Nenhuma outra forma apareceu: as ocorrências de `Input:`, `Result:`, texto começando
com `[` e JSON de ferramenta (`"resultado"`, `"resposta"`) em saídas são **exatamente
as mesmas 2 linhas**. Não há um terceiro formato vazando em silêncio — no corpus de
hoje.

## O filtro de saída — desenho, NÃO implementado

### Onde entra

Em `n8n/estima-tokens.js`, entre `const textoSaida = agent?.output ?? ''` (linha 148) e
o `output: textoSaida` do retorno (linha 397). Uma função nova, `limparVazamento`,
devolvendo `{ texto, cortes }`.

**Depois da contagem de tokens, não antes.** O modelo GEROU aqueles tokens e a OpenAI
cobrou por eles; estimar sobre o texto já limpo faria o rateio subestimar exatamente
nas mensagens defeituosas. A estimativa continua lendo o texto bruto; só o que SAI é
filtrado.

### O que corta

1. **O bloco `[Used tools: …]` inteiro, por varredura de colchetes balanceados** —
   não por regex. O bloco tem colchetes ANINHADOS (`Result: [{"resposta":"[Trecho 1
   …]"}]`), e isso derruba as duas formas óbvias. Verificado contra as duas linhas
   reais do banco:

   | tentativa | resultado na linha do `emporio` |
   |---|---|
   | `sanitizar` do `filtro-texto.js` | sobra **`\nPagamento: somente PIX. Você NÃO tem a chave…`** |
   | `/\[Used tools:[\s\S]*?\]/` (não-gulosa) | idem — para no primeiro `]` |
   | `/\[Used tools:[\s\S]*\]/` (gulosa) | certo aqui, mas come até o ÚLTIMO `]` da mensagem |
   | varredura balanceada | certo nas duas |

   O primeiro caso é o argumento inteiro contra reusar o `sanitizar`: ele não só falha
   — ele transforma um vazamento **feio e óbvio** num vazamento **limpo e invisível**,
   entregando ao cliente a instrução interna ("Você NÃO tem a chave…") sem nenhuma
   marca de que aquilo é lixo. A gulosa é perigosa por outra via: qualquer `]`
   legítimo mais adiante apaga o resto da resposta.

2. **`[Trecho N | relevância 0.xxx]`**, que aí sim é regex segura (não aninha):
   `/\[Trecho\s+\d+\s*\|\s*relev[âa]ncia\s+[\d.]+\]\n?/gi`. Existe porque um dia pode
   vazar sozinho, mesmo que hoje não vaze.

### Como registra

O contrário do que parece natural: **o log fica com o texto bruto e o cliente recebe o
limpo**, OU se paga uma migração. As duas saídas, e a recomendação:

- **(A) sem migração:** `Envia Mensagem Chatwoot` passa a mandar `output` (limpo) e
  `Registra Mensagem` continua gravando o bruto num campo novo do item. Custo zero de
  schema, a consulta desta página continua valendo para sempre. **Preço:** `conteudo`
  deixa de ser o que o cliente recebeu, e quem lê o histórico no painel vê texto que
  ninguém leu.
- **(B) recomendada:** `conteudo` passa a ser o texto limpo (fiel ao que o cliente
  recebeu) e entra uma coluna `saida_cortes jsonb null` em `mensagens_log` com os
  pedaços cortados. `null` = nada cortado, então a frequência sai de um
  `count(*) filter (where saida_cortes is not null)`.

**Se for a (B), a armadilha é conhecida e é a quinta da família:**
`api_n8n_registrar_mensagem` ganha parâmetro, e parâmetro novo com DEFAULT **exige
`drop function` da assinatura antiga pela lista completa de tipos** antes do
`create or replace` — senão as duas aridades ficam vivas e a chamada do n8n vira
ambígua (28, 32, 37). E `DROP FUNCTION` apaga os grants: têm de voltar **duas** linhas,
`service_role` **e** `n8n_agent` (40, 41). `npm run teste:grants-n8n` cobre isso.

Sem nenhuma das duas, conserta-se a aparência e perde-se a medida: no dia em que
voltar, ninguém sabe.

### O que ele NÃO pega

- **Não impede o modelo de fabricar** — esconde. A medição continua sendo a única
  forma de saber se piorou, e é por isso que registrar o corte não é opcional.
- **A memória do Redis já tem o turno envenenado.** A memória do agente é escrita pelo
  nó do agent, antes deste filtro. Na mesma conversa, o modelo continua vendo a
  própria saída suja e pode imitá-la de novo.
- **Formato que não seja `[Used tools`**. Hoje não há nenhum no banco, mas o corpus é
  de 165 saídas. `Tool: X, Input: …` sem colchete passaria batido.
- **As outras saídas para o Chatwoot.** Os quatro `Avisa …`, o `Envia Resposta
  Bloqueada` e a foto do produto não passam pelo `Estima Tokens`. Hoje mandam texto
  fixo ou nome de produto, então o risco é baixo — mas o filtro não os cobre.
- **Semântica.** Se o modelo intercalar o bloco fabricado com a frase real, cortar o
  bloco pode deixar uma frase pendurada. O filtro remove; não reescreve.

### Por que não reusar o `sanitizar` do `filtro-texto.js`

Além da tabela acima (ele piora este caso concreto): entrada e saída são problemas
diferentes — injeção lá, vazamento aqui. Compartilhar a função faz mexer na blocklist
de um mexer no outro, e o `n8n:sincronia` passaria a exigir que dois problemas
diferentes andem juntos.
