# Pendência — registrar quando o agente não soube responder

> **Registrada em 18/08/2026. NÃO construída.** É a lacuna que mais dói dos
> Relatórios, e por um motivo específico: é a única cuja resposta **melhoraria a
> base de conhecimento**. As outras métricas descrevem o que aconteceu; esta
> diria o que fazer a seguir.

## A pergunta que a tela não responde

O dono da loja vai perguntar, e é a pergunta certa:

> **"O que perguntaram e o agente não soube responder?"**

Hoje não há como saber. `mensagens_log` guarda o que foi perguntado e o que foi
respondido, e nada distingue *"o agente respondeu com base na sua base"* de *"o
agente improvisou"* ou *"o agente disse que não sabia"*.

E o dado que existe engana: a busca **sempre devolve alguma coisa**
(`match_kb_documentos` não tem piso de similaridade — ver
[`PENDENCIA-PISO-SIMILARIDADE.md`](PENDENCIA-PISO-SIMILARIDADE.md)). Então nem
"a busca voltou vazia" é sinal confiável, porque ela nunca volta vazia.

## O que precisaria existir

**O sinal nasce no n8n, não no painel.** Quem sabe se a resposta veio da base é o
fluxo, no momento em que chama `api_n8n_buscar_kb` e recebe (ou não) algo
utilizável. O painel só pode ler o que for gravado.

Duas peças, nesta ordem:

1. **Coluna em `mensagens_log`** — algo como `kb_similaridade numeric` (a
   similaridade do melhor resultado daquele turno) e/ou `kb_usada boolean`.
   Similaridade é mais útil que booleano: permite descobrir o corte depois, com
   dado real, em vez de cravar um limiar agora — que é exatamente o problema
   aberto na pendência do piso.

2. **O fluxo passa a gravar.** A tool de busca já recebe a similaridade
   (`k.similarity` no nó `Busca Vetorial`); hoje ela é usada para ordenar e
   descartada. Levá-la até o `Registra Mensagem` significa carregar o valor
   pelo fluxo, ou gravar num segundo passo por `execucao_id` — que é a chave
   que a migração 37 criou justamente para ligar turno a linha.

## Como a tela usaria

Uma lista das perguntas cujo melhor resultado ficou abaixo do corte, ordenada
por frequência. É acionável de um jeito que nenhuma outra métrica é: cada linha
é um documento que falta na base, escrito com as palavras que o cliente usou.

## Cuidados registrados desde já

- **Não é "o agente errou".** Similaridade baixa significa que a base não tinha
  o assunto, não que a resposta foi ruim. Rotular como erro faria o cliente
  desconfiar do produto por um dado que não mede isso.
- **Gravar a PERGUNTA, não só a métrica.** Sem o texto, a lista vira um número
  ("12 perguntas sem resposta") que não diz o que escrever na base.
- **O caminho quente é o de sempre:** o que for acrescentado ao
  `Registra Mensagem` não pode derrubar o log da mensagem se vier nulo ou mal
  formado — mesma regra que a migração 42 aplicou aos componentes de token.

## Gatilho

Quando um cliente perguntar "o que o agente não soube responder?" — ou quando a
base de alguém parar de crescer e ninguém souber o que acrescentar. Enquanto as
bases estiverem sendo montadas do zero, a lista de faltas é a base inteira.
