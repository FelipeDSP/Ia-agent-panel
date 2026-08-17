## Tetos de exposição — decidido antes de virar coluna

Escrito sem provedor definido, de propósito. Os números abaixo valem para
qualquer arranjo em que criamos conta por cliente e emitimos cobrança em nome
dele. Se o provedor mudar, muda a integração, não a política.

**Nada disso vira coluna enquanto não houver provedor definido.** O registro
aqui existe para que a decisão já esteja tomada quando houver — e para que
ninguém tenha que redescobrir o raciocínio olhando um número solto no schema.

### Os quatro números

| teto | valor | raciocínio |
|---|---|---|
| Por cobrança | **R$ 500** | Ticket real das verticais em escopo vai de R$ 30 a R$ 300. Mesa de restaurante com 8 pessoas e trouxa grande de lavanderia chegam a R$ 400–600. R$ 500 cobre o legítimo e ainda pega erro de ordem de grandeza — uma quantidade `1` que virou `100` estoura com folga. |
| Por mês — entrada | **R$ 2.000** | Teto de todo tenant novo. O critério é que seja menos do que custa fabricar a fraude: abrir CNPJ, passar por cadastro e esperar a liberação não se paga por R$ 2 mil. Um ciclo inteiro de liquidação cabe aqui, que é o que precisamos observar antes de liberar mais. |
| Por mês — graduado | **R$ 10.000** | Liberado na mão depois do primeiro ciclo. Dá ~R$ 330/dia, confortável para as verticais em escopo, e mantém a exposição de um tenant como fração do livro. |
| Teto de carteira | **R$ 50.000** (ponto de partida) | Soma máxima em aberto entre todos os tenants. Ver abaixo — este é o único que não é decisão de engenharia. |

### O que cada teto protege

Os três primeiros parecem a mesma coisa em escalas diferentes. Não são.

- **Por cobrança é anti-erro.** Catálogo com preço errado, agente somando
  quantidade absurda, cliente final pedindo 100 unidades de algo que se vende
  uma. Falha operacional, e é a mais provável das três.
- **Por mês é anti-tenant.** Existe para o caso em que o cliente *é* o
  problema. Saldo negativo só cresce até o volume que passou pela conta dele;
  o teto mensal é literalmente o valor máximo que um tenant consegue nos custar.
- **Teto de carteira é o livro inteiro.** Os por-tenant não limitam a soma. Dez
  clientes graduados são R$ 100 mil de exposição máxima sem que nenhum limite
  individual tenha sido violado. É o único teto que protege contra crescer
  rápido demais.

**Chargeback quase não entra nessa conta.** Sem cartão de crédito no escopo, o
que resta é Pix — janela de contestação curta e restrita a fraude — e boleto,
que na prática é irreversível. Isso importa para não afrouxar os tetos depois
achando que eles protegem contra estorno: **são controle antifraude e
anti-descontrole, não anti-chargeback.** No dia em que cartão entrar, esta
seção precisa ser reescrita, não ajustada.

### O teto de carteira é decisão de caixa

O critério não é técnico e não é benchmark de mercado. É: **quanto eu
absorveria se todos os clientes tomassem calote no mesmo mês.**

R$ 50 mil é ponto de partida, não recomendação. Quem responde é quem responde
pelo caixa. Se o número certo for R$ 20 mil, o módulo de vendas escala mais
devagar e tudo bem; se for R$ 150 mil, o freio sai do caminho antes. O que não
pode é o teto de carteira não existir — sem ele, cada cliente novo aumenta a
exposição sem que nada no sistema tenha opinião sobre isso.

### O degrau de entrada

Todo tenant entra em **R$ 2.000/mês** e sobe para **R$ 10.000/mês** por
liberação manual, depois do primeiro ciclo completo de liquidação.

A razão é que fraude se concentra nos primeiros 30–60 dias de uma conta nova.
O degrau é o controle mais barato disponível: dois valores por cliente e um
botão, sem automação, sem régua de score, sem revisão programada. Subir é uma
decisão consciente de quem olhou o histórico daquele cliente.

**Não automatizar a graduação.** Uma regra do tipo "após 30 dias sem
ocorrência, sobe sozinho" transforma o único momento de análise humana do
processo em espera. O custo de subir na mão é um clique por cliente, algumas
vezes por ano.

### A recusa é conversa, não exceção

Cobrança acima do teto no meio de um atendimento **não vira erro**. O pedido
fica preservado em `aguardando_pagamento` e o fluxo cai em
`transferir_humano` — o agente avisa que um atendente vai finalizar, e alguém
finaliza por fora.

Mesmo princípio da migração 26. O cliente final não tem nada a ver com o nosso
limite de risco, e "ocorreu um erro" no meio de um pedido fechado é o pior
lugar possível para expor um controle interno. Feito assim, o teto vira sinal
operacional para nós em vez de atrito com quem está comprando.

Isso também significa que **toda recusa por teto precisa ser registrada**,
inclusive as que o cliente final nunca percebeu. Sem o registro não dá para
saber se o teto está trabalhando ou apenas atrapalhando — mesmo argumento de
`fotos_enviadas`, que grava a recusa e não só o envio.

### Gatilho de revisão

**A primeira recusa por teto num pedido legítimo revisa aquele tenant, não a
política.** Provavelmente é um cliente cujo ticket real não é o que
imaginávamos, e a resposta é o valor dele, não o padrão.

A política só se mexe quando recusar virar rotina em **mais de um** tenant. Um
caso é exceção; dois são o número errado.

---

## Comparação de provedores — o que o contrato de BaaS do Asaas nos ensinou a perguntar

O Asaas foi o primeiro contrato que lemos inteiro, e virou nosso **benchmark**
— não nosso requisito. O que segue não é "o que precisamos ter": é a lista de
perguntas que a leitura daquele contrato revelou que existem, e que passam a
valer para qualquer candidato.

**O ponto desta seção é comparar custo total, não taxa.** Um provedor que cobre
menos por transação mas exija a mesma solidariedade e a mesma exclusividade não
é mais barato — é o mesmo risco com desconto na tarifa. A economia só é real
depois que as seis respostas abaixo estiverem lado a lado.

### As seis perguntas

**1. Exige exclusividade?**
Se sim, contratar é fechar a porta: não dá para manter um segundo provedor para
o mesmo tipo de serviço enquanto o contrato durar, nem migrar sem rescindir
antes. Isso muda o peso de todas as outras respostas, porque elimina a saída
fácil.
*Referência Asaas: sim. Exclusivo para os serviços contratados enquanto o
contrato estiver ativo, com rescisão imediata em caso de uso de outro provedor
para o mesmo arranjo.*

**2. Tem responsabilidade solidária por saldo negativo de subconta?**
A pergunta de verdade é: se um cliente nosso sumir devendo, quem paga, e o
provedor precisa tentar cobrar dele antes de cobrar de nós? "Solidária com
renúncia ao benefício de ordem" significa que não precisa — vem direto em cima
da gente. Perguntar também se existe débito automático da nossa conta principal
para cobrir subconta negativa, porque isso é requisito de capital de giro, não
risco teórico.
*Referência Asaas: sim, solidária e irrevogável, com renúncia ao benefício de
ordem, incluindo sócio pessoa física como devedor solidário. E sim, com débito
automático entre contas.*

**3. Multa por descumprimento de conformidade — e de quanto?**
O detalhe que importa não é o percentual, é o **piso**. Multa calculada como
percentual da receita gerada é inofensiva para quem tem um cliente; multa com
mínimo absoluto não é. Perguntar os pisos, e se são por infração ou por mês de
descumprimento continuado.
*Referência Asaas: três níveis, com pisos de R$ 20 mil, R$ 50 mil e R$ 100 mil,
teto de R$ 500 mil. O nível intermediário conta por infração **ou por mês** de
descumprimento continuado, o que for maior — e cobre coisas como demorar a
ajustar uma tela.*

**4. Exige exibir a marca do provedor no painel?**
Isso não é só um selo. Custa trabalho de front (cada tela com dinheiro), custa
cláusula nos nossos termos e contratos, e restringe nomenclatura — em geral não
se pode usar palavras que sugiram licença que não temos. Também é um recado de
produto: quanto do "dentro da nossa marca" sobra.
*Referência Asaas: sim, em todos os fluxos, telas, contratos e comprovantes que
envolvam movimentação de valores, com regras de nomenclatura junto.*

**5. Qual o processo e o prazo de aprovação?**
Perguntar as duas pontas: quanto tempo até poder integrar, e **o que continua
correndo depois de assinar**. O prazo pós-assinatura é o que costuma pegar,
porque começa a contar num dia em que já estamos comprometidos.
*Referência Asaas: checklist de modelo de negócio, análise em até 3 dias úteis,
contrato, liberação de API. Depois disso, questionário de segurança a responder
em até 30 dias, com prazo de adequação a critério deles e rescisão automática se
o prazo estourar.*

**6. Antecipação de recebíveis vem habilitada por padrão nas subcontas?**
Se vier, a exposição da pergunta 2 fica muito maior: o cliente saca hoje
dinheiro que só entra depois, e se não entrar, sobra para nós. Perguntar se dá
para desabilitar por padrão no arranjo, e se isso é configuração ou negociação.
*Referência Asaas: **em aberto** — não está respondido na documentação que
recebemos. O anexo de garantias é todo redigido em torno de antecipação, o que
sugere que é o caminho padrão. Precisa ser perguntado.*

### Duas que caíram da mesma leitura

Baratas de perguntar e mudam a comparação:

- **O provedor impõe teto por subconta?** Se impõe, é um freio automático que
  não precisamos construir — mas confirmar se ele some quando a conta sai do
  período de avaliação. Se some, era empréstimo, não controle.
- **Quem responde por KYC e prevenção a fraude?** Se é o provedor, boa parte do
  cadastro pesado é dele. Se é nosso, entra no custo do onboarding de cada
  cliente e vira tela no painel.

### Como usar isto

Com as respostas de dois ou mais candidatos lado a lado, a conversa deixa de ser
"qual cobra menos por Pix" e passa a ser: **o que estamos assinando junto com a
tarifa.** Um provedor sem exclusividade e sem solidariedade, cobrando mais caro,
pode ser a opção barata — porque permite sair, e porque o pior caso não chega na
nossa conta.

Enquanto essa comparação não existir, a decisão certa continua sendo a mesma:
não escrever integração.
