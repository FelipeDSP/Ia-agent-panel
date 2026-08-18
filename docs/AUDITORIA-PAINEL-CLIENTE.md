# Auditoria do painel do cliente — decisões exigidas sem critério

> **Lente, e ela é o que dá valor à lista:** não procurar feiura, e sim
> **decisão que o painel exige sem dar o critério**. Feiura o cliente contorna;
> decisão sem critério ele resolve errado e não descobre.
>
> Levantada em 18/08/2026 lendo as telas, com um caso real por cima: o
> `emporio` no primeiro mês.

## A correção que originou a lente

A primeira versão deste levantamento afirmou que **o painel não diz qual
conteúdo vai no prompt e qual vai na base**. Estava errado: o critério existe,
está em `src/lib/orientacao.ts` e é bem escrito —

> `DICAS_PROMPT[4]`: "Preços, horários e endereço ficam melhor na base de
> conhecimento do que no prompt — assim você atualiza sem mexer no prompt."

O `MODELO_PROMPT` reforça duas vezes e `DICAS_BASE[0]` dá o recorte por assunto.

**O achado ficou melhor com a correção.** O problema não era ausência de
critério: era que ele estava dentro de um `<details>` **fechado nas duas telas**,
como **quinto e último** item da lista de dentro. Regra de maior consequência do
painel, a dois cliques e uma leitura até o fim.

E há prova de que não chegava: o `emporio` tinha **5.708 caracteres de fatos**
(horário, entrega, pagamento, endereço) no prompt e **127** na base — exatamente
a inversão contra a qual a dica avisa. O prompt dele também não segue o esqueleto
do `MODELO_PROMPT`, então provavelmente o "Usar modelo" nunca foi aberto.

## Feito em 18/08

### 1. O critério saiu do acordeão

`CRITERIO_NO_PROMPT` e `CRITERIO_NA_BASE` em `src/lib/orientacao.ts`, renderizados
como texto fixo em `prompt-editor.tsx` e `conhecimento/page.tsx`. As duas metades
são **recíprocas**: em qualquer das duas telas que a pessoa caia, aprende a
divisão inteira. Vivem no mesmo arquivo para não divergirem quando alguém editar
só uma.

Por que promover a frase em vez de `<details open>`: acordeão aberto por padrão
vira ruído para quem volta, e a pessoa fecha uma vez e não reabre. A regra é uma
linha; a lista continua sendo cinco e segue no acordeão.

### 2. Aviso de base pequena

`conhecimento/page.tsx`. Aparece com base de **1 a 5 trechos** e diz o efeito
real, não o número: *"o agente recebe todos os seus trechos, seja qual for a
pergunta — quem perguntar sobre entrega pode receber o que você escreveu sobre
endereço"*.

**Mede TRECHOS, não documentos** — e isso foi um desvio deliberado do pedido, que
falava em "menos de 3 documentos". Documento é a unidade errada: dois documentos
de 40 trechos cada não têm o problema, e receberiam um aviso alarmante e falso.
Quem manda é o número que a busca devolve por pergunta (5, em
`api_n8n_buscar_kb`): enquanto o total couber nesse limite, a busca não escolhe
nada — entrega a base inteira.

**O número tem trava contra deriva.** `TRECHOS_POR_BUSCA` é comparado com o que a
tool do n8n realmente pede ao banco, em `tests/conhecimento-lista.mjs`. É
afirmação sobre o comportamento do agente numa tela que o agente não lê: trocado
no n8n e não aqui, o painel passaria a mentir, e mentira desse tipo ninguém
confere porque a tela continua bonita. Sabotado nas duas direções (constante e
workflow) — as duas reprovam.

Fundamento do aviso: `docs/PENDENCIA-PISO-SIMILARIDADE.md`.

## Registrado, não implementado

### 3. `msg_fora_escopo` e `msg_midia_nao_suportada` — falta o GATILHO

`configuracoes/formulario.tsx:64-82`. Rótulo e caixa de texto, **zero apoio**.

O problema maior **não é** o rótulo "fora de escopo" ser jargão — traduzir o nome
não resolve. É que o cliente **não sabe quando aquilo dispara**: ele escreve
imaginando um caso e a frase sai em outro. Duas mensagens que vão para o cliente
final, escritas às cegas sobre a situação em que serão lidas.

O conserto é dizer o gatilho ao lado do campo ("esta frase é enviada quando…"),
não melhorar o rótulo.

### 4. Debounce — diz o que é, não como escolher

`formulario.tsx:58` explica ("tempo de espera antes de o agente responder, 1 a
60s") e para aí; falta o trade-off (alto demais parece que ninguém viu, baixo
demais responde no meio de uma mensagem quebrada em três). Em `/painel:128` o
número aparece **sem explicação nenhuma**.

**Baixa prioridade por decisão:** o default é razoável e o cliente raramente mexe.

### 5. Foto do produto — sem porta de entrada e sem critério

Não existe campo de foto no formulário de cadastro; o único acesso é um quadrado
de 48px sem rótulo visível na linha da lista, que só aparece depois de salvar. E
nada diz o que faz uma foto servir, nem que o agente manda **uma por vez**.

**Entra junto com a fatia de categoria** (`PENDENCIA-CATEGORIA-PRODUTO.md`).

### 6. Desligar um módulo — o resumo diz o que ele faz, não o que o cliente sente sem ele

`lista-modulos.tsx`. Exceção: `transferir_humano` tem card próprio explicando o
efeito. Os outros não têm.

### 7. SKU — "Opcional" e nada mais

`catalogo/componentes.tsx:189`. O menor da lista: não diz se afeta o agente
(não afeta).

## O que está bem resolvido

Vale registrar para não se gastar tempo revisando:

- estoque vazio × zero, e "Disponível para venda" ("hoje não tem", sem apagar o
  cadastro);
- o horário de transferência: *"Fora desse horário o agente informa que não há
  atendente e segue ajudando"* — critério e consequência na mesma frase;
- catálogo e base vazios apontando para cima, para onde a ação está;
- "Usar modelo" no editor de prompt, com confirmação antes de substituir.

## Um defeito de conteúdo, fora da lente

`catalogo/page.tsx:67` diz, sem condicional: *"o agente ainda não usa estes itens
para vender"*. É falso — `vendas` está contratada **e** ativa nos dois clientes
que têm a tela, e a rota só existe por causa dela. Desmotiva exatamente o
trabalho que a tela existe para colher.
