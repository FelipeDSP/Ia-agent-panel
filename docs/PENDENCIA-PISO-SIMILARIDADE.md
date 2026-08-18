# Pendência — piso de similaridade na busca da base de conhecimento

> **Registrada em 18/08/2026. NÃO implementada.** O achado é real e confirmado;
> o que falta não é o código, é o **número** — e a medição abaixo mostra que o
> número óbvio não existe.

## O achado

`public.match_kb_documentos` **não tem piso de similaridade**. Ela ordena por
distância e corta no `limit`:

```sql
order by d.embedding operator(extensions.<=>) query_embedding
limit v_limite;
```

Não há `where similarity >= x`. Consequência: **a busca sempre devolve algo.**
Ela não sabe dizer "não tenho isso na base" — devolve o menos distante, seja ele
o que for.

**O caso que expôs isso:** o `emporio` está com UM chunk (o endereço, 127
caracteres). Toda pergunta de todo cliente dele retorna o endereço rotulado como
contexto relevante. Perguntaram sobre entrega? Chega o endereço. Sobre horário?
O endereço. O agente não recebe "vazio" para reagir com "não sei" — recebe uma
resposta errada com cara de certa.

Com 4 ou 5 chunks o problema fica menos agudo e **não some**: um chunk
irrelevante sempre volta se for o menos distante dos que existem.

## Por que o número é o difícil — medido, não suposto

Medido em 18/08 contra o corpus real de produção (pgvector, `1 - (a <=> b)`):

**Conteúdo IRRELEVANTE chega a 0,625.** O chunk de endereço do `emporio` contra
os chunks de outros tenants:

| similaridade | conteúdo |
|---|---|
| **0,625** | horários de funcionamento do `restaurante-teste` |
| 0,526 | horário de emissão da `acqua-lavanderia` |
| 0,450 | CEP e ponto de referência do `restaurante-teste` |
| 0,044 | seção "Hepatite B" do `fortalize` |
| −0,008 | documento de teste da `clinica-teste` |

**Conteúdo do MESMO documento desce a 0,165.** Dentro dos 86 chunks do
`fortalize` (um único documento), a similaridade contra um chunk de referência:

```
menor 0,165   média 0,436   maior 1,000
```

**As duas faixas se sobrepõem, e é isso que mata o conserto ingênuo.** Um piso
alto o bastante para barrar o falso positivo de 0,625 precisaria ficar acima
de 0,63 — e nessa altura ele silencia a maior parte dos chunks legítimos do
próprio documento do cliente, cuja média é 0,436. É exatamente o risco de "alto
demais e a base cala quando devia responder", com número em cima.

**Limite honesto desta medição:** são similaridades chunk↔chunk, não
consulta↔chunk. Embedding de pergunta curta ("vocês entregam?") se comporta
diferente de embedding de passagem longa, e a assimetria pode deslocar as duas
faixas. Medir do lado da consulta exige gerar embedding com a chave da OpenAI,
que não está no `.env.local`. Então o que está provado aqui é a **escala** e a
**sobreposição**; o piso definitivo precisa da medição do lado da pergunta.

## Caminhos, quando for feito

1. **Piso por consulta, medido com perguntas reais.** Pegar 20 perguntas de
   conversas de produção, gerar o embedding de cada uma, e olhar a distribuição
   de similaridade do 1º resultado quando a resposta existe na base contra
   quando não existe. O piso mora no vale entre as duas distribuições — se
   houver vale.
2. **Piso relativo em vez de absoluto.** Em vez de `>= x`, descartar resultados
   muito piores que o melhor (ex.: `similaridade >= 0,8 * melhor`). Não resolve
   o caso do `emporio` (com 1 chunk o melhor é o único), mas é robusto a
   corpus de tamanhos diferentes, que é onde piso fixo erra.
3. **Tratar o caso "base pequena" à parte.** Base com menos de N chunks quase
   não tem o que comparar; ali o problema não é a busca, é a base. Um aviso no
   painel ("sua base tem 1 documento — o agente vai usá-lo para qualquer
   pergunta") resolve mais rápido que qualquer piso, e não arrisca calar.

**Re-rodar `npm run teste:recall` antes e depois, sempre.** Trocar o critério de
retorno da busca vetorial sem medir recall é a mesma classe de erro que mexer no
tamanho do chunk sem medir: quebra calado.

## Gatilho

Quando houver cliente com base grande **e** relato de resposta fora de contexto —
ou seja, quando o falso positivo custar atendimento. Até lá o problema aparece
como base pequena, e a correção certa é encher a base, não filtrar a busca.
