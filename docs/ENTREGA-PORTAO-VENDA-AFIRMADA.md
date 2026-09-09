# Entrega — portão de venda afirmada + narração por código

**Estado: ENTREGUE, NADA APLICADO.** Migração não rodada em produção, workflow
não importado, gerador não executado. Tudo abaixo está no repositório.

| artefato | arquivo |
|---|---|
| migração 56 | `supabase/migrations/20260909180000_56_portao_venda_afirmada.sql` |
| rollback | `..._56_portao_venda_afirmada_rollback.sql` |
| corpo do nó (fonte) | `n8n/aplica-portao.js` |
| workflow pronto para importar | `n8n/workflows/agente-principal.json` (64 nós, +4) |
| script que o monta | `scripts/aplicar-portao-venda.mjs` |
| teste dos dois vereditos | `npm run teste:portao-venda` — 42/42 |
| teste da migração | `npm run teste:migracao-portao` — 34/34 |

---

## 1. São TRÊS referências por nome, não duas

O enunciado lista duas (`Envia Mensagem Chatwoot.body` e o 3º elemento do
`queryReplacement`). **Há uma terceira, e ela falha exatamente do mesmo jeito
silencioso:** o **10º** elemento, `componentes_json`.

```
$1  tenant_id          $6  modelo
$2  conversation_id    $7  lista_depois
$3  output          <- portão      $8  audio_segundos
$4  tokens_entrada     $9  $execution.id
$5  tokens_saida       $10 componentes_json  <- portão
```

Se o 10º continuar apontando para `Estima Tokens`, o portão funciona, o cliente
recebe o texto certo e **o veredito nunca chega ao banco** — que é a metade que
a `VAZAMENTO-USED-TOOLS.md` ensina a não perder. O script troca as três e
**confere as três depois**, abortando sem escrever se alguma ficou para trás;
confere também que o array continua com 10 elementos na mesma ordem.

**`tokens_entrada` e `tokens_saida` seguem vindo do `Estima Tokens`, de
propósito.** Eles medem o que a OpenAI cobrou pelo texto que o **modelo** gerou;
o portão não muda isso. Apontá-los para o portão faria o rateio contar o texto
substituto, que ninguém gerou por token.

---

## 2. "Houve escrita neste turno" — a escolha, e o que foi descartado

```
ultima_mutacao_do_pedido  >  ultima_saida_registrada_desta_conversa
```

O instante de referência sai do **próprio banco**, não do n8n. Funciona porque
`Registra Mensagem` roda **depois** do portão: no momento da consulta, a saída
mais recente registrada é a do turno anterior. "Mutou depois dela" = "mutou
neste turno", e isso cobre o turno inteiro, inclusive as tool calls que o agente
fez antes de existir texto.

Descartadas:

- **instante de início da execução do n8n** — não há campo confiável em
  expressão (`$execution` dá `id` e `mode`). Obter um exigiria capturar
  `Date.now()` num nó do início, e os candidatos são `Extrair e Filtrar` (corpo
  injetado pelo gerador) ou `api_n8n_conversa_sync` (mudança de assinatura,
  família 28/32/37/40/41);
- **`Date.now()` no `Estima Tokens` ou na própria função** — os dois rodam
  **depois** do agente, então uma escrita feita pela tool é anterior a esse
  instante e sairia classificada como "turno passado". O critério ficaria
  invertido justamente no caso que importa;
- **guardar o estado anterior em Redis** — fonte de verdade nova, com TTL
  próprio, para responder o que uma coluna já responde.

**Limite conhecido e aceito:** execuções concorrentes na mesma conversa (cliente
em rajada) intercalam o registro das saídas e a janela sai errada — o mesmo
limite que a §6.1 da pendência já registra ("uma vez em 40"). O erro cai para o
lado seguro: uma escrita da execução vizinha faz o turno parecer que escreveu e a
mensagem **passa**.

---

## 3. Cobertura medida — 3 dos 4 casos reais, e o quarto dito de frente

```
R$ 60,00  (emporio/1636, 20/08)  -> barrado_regra_1
R$ 249,80 (sendbox, 28/08)       -> barrado_regra_1
R$ 279,60 (sendbox, 08/09)       -> barrado_regra_1
R$ 42,50  (emporio/18, 21/08)    -> passou
```

E os três turnos do caso do `emporio` de 08/09 — inclusive o *"seu pedido
ficou:"* que **nenhum dos quatro detectores pegava** — são barrados.

**Por que o R$ 42,50 escapa, e é consequência direta de uma decisão do
enunciado.** Naquele turno a tool RODOU (`chamadas = 4`) e fechou o pedido de
R$ 30,00; o texto publicou R$ 42,50. Como o `fechar_pedido` transformou o
rascunho em `aguardando_pagamento`, no instante da consulta **não há rascunho** —
e "sempre o rascunho, pedido fechado é passado" é regra do enunciado. Regra 1 não
pega porque houve escrita; Regra 2 não avalia porque não há referência.

Não mudei a regra: a decisão está escrita e tem motivo. Fica registrado que o
preço dela é **um caso em quatro**, e que ele é da modalidade B sobre pedido
recém-fechado. Fechar esse buraco pediria comparar também contra o pedido fechado
**na janela do próprio turno** — desenho novo, não ajuste.

---

## 4. Dois defeitos que o próprio teste pegou

Ambos no meu código, ambos encontrados pelas checagens que o enunciado exigiu.

**(a) O caso de controle da §8 — barrar pelo motivo errado.** Montei o controle
como pedido: mesmo texto fabricado, **rascunho presente e total correto**. Ele
**barrou**. Causa: em

```
- 1x NR 06 — R$ 69,90

Total: R$ 279,60
```

os dois valores ficam à **mesma distância** do lema "total" (dois caracteres), e
o desempate por "primeiro encontrado" elegia o R$ 69,90 — o subtotal da linha
anterior. O portão barrava venda correta comparando o total do banco contra o
preço de um item. Corrigido: o valor **depois** do lema tem precedência, e só se
não houver nada depois é que se olha para trás (que é o caso de *"por R$ 4,50 no
total"*).

Sem o caso de controle, os três verdes da seção 1 seriam por acaso.

**(b) O falso positivo do `fortalize`.** *"Atualizando a lista das vacinas…,
**inclu**indo a influenza anual"* casa `inclu[ií]` e era barrado pela Regra 1 —
num tenant de saúde, que tem `vendas` contratada e passaria pelo portão. Era o
falso positivo conhecido da D1, agora com consequência: mensagem bloqueada.
Corrigido com guarda de **contexto**, não de vocabulário: a frase precisa falar
de `pedido`, `carrinho` ou `R$`. Isso mantém o gatilho largo onde importa —
*"Separei 2 pedaços…, totalizando R$ 15,00"* não tem a palavra pedido e continua
sendo pego pelo `R$`.

---

## 5. A transferência entrega a nota, e NÃO pausa — por quê

Duas barradas seguidas → nota privada no Chatwoot com **os dois, rotulados**: o
bloco do banco como *estado de fato* e o texto do modelo como *o que o agente
afirmou*. A divergência é a informação; substituir um pelo outro a apaga.

**Não pausa a conversa, e a razão é de dado.** A única função que pausa hoje é
`api_n8n_definir_status_conversa`, e ela crava `motivo_pausa = 'mensagem_humana'`
(migração 47). Usá-la aqui gravaria um motivo **falso** — diria que um humano
falou quando quem interveio foi o portão — e `motivo_pausa` existe exatamente
para distinguir isso. Pausar de verdade pede um motivo novo, que é migração
própria.

**Consequência aceita:** hoje a transferência avisa e não silencia o agente. Ele
segue respondendo até um humano falar. Fica aberto.

---

## 6. O que ficou pendente de autorização

**`n8n:sincronia` está vermelho, e não é deste trabalho.** A entrega anterior
cortou do system message a instrução *"repita esse resumo, os itens e o total"* —
o item que este enunciado também pede, e que **já está aplicado**. O que falta é
uma execução do `gerar-principal.mjs` para re-derivar o wrapper dentro do
`Estima Tokens`, que guarda a mesma frase.

```
57 passaram, 2 falharam
  - systemMessage de AI Agent Vendas == wrapper "vendas" — 3964 vs 3767 chars
```

Não rodei: o enunciado diz "não rode o gerador nem toque no wrapper sem
autorização explícita". Um comando fecha, e o corte e a narração ficam sendo um
item só, como pedido — a narração por código já está no portão (o bloco 📋 com
itens), então tirar a instrução não deixa o cliente sem resumo.

**E o corpo do `Aplica Portao` nasce campo órfão.** O gerador não o conhece; a
cópia no JSON é injetada pelo `aplicar-portao-venda.mjs`. É a mesma classe da
`PENDENCIA-GERADOR-CAMPO-ORFAO.md`, registrada de propósito no rodapé de
`n8n/aplica-portao.js` — dívida conhecida, não esquecimento.

---

## 7. Ordem de implantação

As duas ordens são seguras, e isso é deliberado (mesma propriedade da 46): nó
antes da migração, a função ignora a chave que não conhece e a coluna fica nula;
migração antes do nó, nada muda até o nó subir. **Mas o nó `Estado do Pedido`
chama `api_n8n_estado_pedido`** — se ele subir antes da migração, estoura `42883`
a cada mensagem. Então:

1. aplicar a migração 56 (conferir o ledger e renomear o arquivo se aplicar fora
   do CLI);
2. importar o workflow;
3. conferir na instância as **três** referências por nome — é o único ponto onde
   um import parcial deixa o cliente recebendo um texto e o banco gravando outro.

E o rollback tem ordem inversa: **reverter o workflow antes** de dropar a função.

---

## 8. Como medir depois

```sql
select t.slug,
       count(*) filter (where l.portao is not null)                        as avaliadas,
       count(*) filter (where l.portao ->> 'veredito' like 'barrado%')     as barradas,
       count(*) filter (where (l.portao -> 'regra2_avaliada')::boolean)    as regra2_avaliada,
       count(*) filter (where (l.portao -> 'transferiu')::boolean)         as transferidas
  from public.mensagens_log l join public.tenants t on t.id = l.tenant_id
 where l.direcao = 'saida'
 group by 1 order by 2 desc;
```

**`regra2_avaliada` é a coluna que avisa antes do silêncio.** O marcador de
totalidade depende de **como o `system_prompt` manda o agente escrever**. Se um
cliente editar o prompt e a forma mudar, a cobertura cai a zero — e uma regra que
nunca dispara é indistinguível, no log, de uma regra que nunca é avaliada. Só
esse contador separa as duas.
