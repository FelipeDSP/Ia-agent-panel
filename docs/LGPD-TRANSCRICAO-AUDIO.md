# Transcrição de áudio — o que sai da nossa infraestrutura

Escrito em 12/08/2026, antes de o módulo existir para qualquer cliente.

Este documento existe para uma pergunta ser respondível **antes** de alguém
contratar: *para onde vai a voz do cliente final?*

---

## O fato

Quando um tenant tem `transcricao_audio` contratada, a nota de voz que o cliente
final manda no WhatsApp é:

1. recebida pelo Chatwoot, que **re-hospeda o arquivo** em `active_storage`
   (`https://app.chatyou.chat/rails/active_storage/blobs/redirect/...`);
2. baixada pelo n8n a partir dessa URL, com o token do Chatwoot do tenant;
3. **enviada para a OpenAI**, endpoint `/v1/audio/transcriptions`;
4. devolvida como texto, filtrada e injetada no fluxo como se tivesse sido
   digitada.

O áudio **não** é gravado em nenhum banco nosso. Só o texto resultante entra em
`mensagens_log`, como qualquer mensagem, e a duração em `audio_segundos`.

**O que sai da nossa infraestrutura é o áudio bruto — a voz da pessoa.** Isso é
categoricamente diferente de tudo que o produto fazia até aqui: texto já ia para
a OpenAI, mas voz é biometria em potencial, e o titular do dado não é nosso
cliente — é o cliente do nosso cliente.

---

## A política da OpenAI, verificada e não presumida

Consultado em 12/08/2026 em
`developers.openai.com/api/docs/guides/your-data`:

- **Não treina por padrão.** *"data sent to the OpenAI API is not used to train
  or improve OpenAI models (unless you explicitly opt in to share data with us)"*
- **Retenção para monitoramento de abuso: até 30 dias.** *"abuse monitoring logs
  are generated for all API feature usage and retained for up to 30 days"* — e o
  próprio texto ressalva que pode passar disso se a lei exigir.
- **Existe Zero Data Retention**, mas é sob aprovação: *"Eligible customers may
  have their customer content excluded from these abuse monitoring logs... by
  getting approved for the Zero Data Retention control"*.

**Não temos ZDR.** Enquanto não tivermos, o áudio de um cliente final pode ficar
até 30 dias nos logs da OpenAI. Isso precisa ser dito a quem contrata, com essas
palavras, não com "é seguro".

### A consequência prática, que não é nota de rodapé

**O impedimento para um cliente com exigência de LGPD mais rígida são os 30 dias
de retenção — não o treinamento.** O treinamento é o que as pessoas perguntam, e
a resposta é confortável: não treina. A retenção é o que ninguém pergunta, e é a
que impede.

E o peso disso é maior em áudio do que em texto. **Nota de voz de WhatsApp
costuma carregar mais dado sensível do que mensagem digitada**: as pessoas falam
nome completo, endereço com número e complemento, às vezes CPF ou dado de saúde
— coisas que hesitariam em digitar, mas dizem sem pensar porque estão falando.
Um mesmo pedido vira "quero a lavagem" por escrito e "aqui é a Maria da Silva,
rua tal, 340, apartamento 21, o CPF é..." em áudio.

Somando as duas coisas: o módulo faz dado sensível de terceiro sair da nossa
infraestrutura e ficar até 30 dias em log de um fornecedor. **Isso é parte do
que se contrata**, e tem que estar dito antes da assinatura — não descoberto
depois.

---

## O que isso obriga

**O módulo é opt-in por tenant e fica desligado por padrão.** Está fora de
`TOOLS_BASELINE` por esta razão, não por razão comercial. Ligar por padrão seria
decidir sobre dado de terceiro sem ninguém ter escolhido.

**Quem contrata precisa saber antes.** O texto do módulo no painel e a descrição
em `catalogo_tools` apontam para este documento. Contratar é o momento em que a
informação tem valor — depois é constatação.

**O cliente do nosso cliente também tem titularidade.** Não somos nós que
informamos essa pessoa: quem tem a relação com ela é o tenant. O que podemos
fazer é não deixar o tenant descobrir isso depois.

---

## Um cliente com exigência mais rígida

Se aparecer um tenant que não pode mandar voz para fora (saúde, jurídico,
público), as saídas, em ordem de custo:

1. **não contratar o módulo** — o comportamento de hoje, que responde
   `msg_midia_nao_suportada`, continua valendo e não é uma degradação para quem
   nunca teve áudio;
2. **ZDR na OpenAI**, que exige elegibilidade e contato comercial — resolve a
   retenção, não o fato de o áudio sair;
3. **transcrição local** (Whisper self-hosted), que resolve os dois e troca por
   custo de infraestrutura e latência.

Nenhuma está construída. A 1 é a única disponível hoje, e é suficiente enquanto
o módulo for opt-in.

---

## O que NÃO fazemos, e por quê

**Não usamos o `transcribed_text` do Chatwoot.** O campo existe no payload do
anexo e veio vazio no teste de 12/08. Investigado: é recurso do **Captain**, o
produto de IA pago do Chatwoot — só aparece com Captain habilitado na conta e
consome crédito de IA (1 por mensagem, quota própria).

Três razões para ignorar:

1. **depende de crédito do cliente.** Quota acabou, campo volta vazio, e o agente
   perde a capacidade sem aviso — falha silenciosa, a classe que este projeto
   mais paga caro;
2. **cria duas verdades sobre custo.** Uns tenants transcreveriam pelo Captain
   deles, outros pelo nosso Whisper. O rateio, que foi calibrado a ±1,4% para
   token e agora ganha `audio_segundos` como unidade exata, passaria a medir
   coisas diferentes com o mesmo nome;
3. **pode ser preenchido de forma assíncrona**, depois do webhook — nesse caso
   chega sempre vazio para nós e o caminho seria morto.

**Gatilho para revisitar:** um cliente que **já pague Captain**. Aproveitar a
transcrição dele evitaria custo duplicado — e aí o rateio precisa distinguir as
duas origens, senão volta o problema 2. Não antes disso.
