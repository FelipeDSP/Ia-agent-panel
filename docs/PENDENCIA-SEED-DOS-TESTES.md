# Pendência PARCIAL — fecharam os cinco de isolamento, não a suíte

> **Escopo concluído em 2026-08-17: `tests/isolamento-*.mjs`, cinco arquivos.**
> Eles criam e destroem os próprios tenants, e o critério foi verificado das duas
> formas (varredura estática permanente + uma execução com os TRÊS seeds
> soft-deletados, 130 asserções verdes).
>
> **Escopo em aberto: outros nove testes continuam acoplados aos seeds.**
> Contado por seed: apagar `restaurante-teste` derruba quatro (mais
> `trava-vendas`, que degrada calado); `clinica-teste`, três; `sandbox-de-testes`,
> dois. Ver
> [Escopo — o que fechou e o que não fechou](#escopo--o-que-fechou-e-o-que-não-fechou).

> **Por que este título deixou de dizer FEITO (18/08).** Dizia, por um dia. O
> critério de aceitação abaixo — *"apagar seed nenhum consegue deixá-los
> verdes"* — foi cumprido para **eles**, os cinco, e o título omitia o
> antecedente. Quem lesse daqui a um mês concluiria que a CLASSE de defeito
> fechou e pararia de procurar; foi a mesma armadilha de um "Provedor definido:
> Asaas" escrito quando só a comparação tinha terminado. Pendência de escopo
> parcial se marca parcial, com o resto listado por nome — a lista é o que
> impede o esquecimento de virar conclusão.

## O que aconteceu

Em **13/08/2026** os tenants `clinica-teste` e `sandbox-de-testes` foram
soft-deletados pelo painel — operação legítima, feita sem relação com testes. A
partir dali `npm run teste:isolamento` morria na pré-condição:

```
ERRO: tenant de teste ausente no banco: sandbox-de-testes
```

Ficou assim **quatro dias**, exatamente na semana em que três clientes reais
(`emporio`, `estudyou-sendbox`, `fortalize`) foram conectados. O teste que prova
que o cliente A não lê dado do cliente B esteve fora do ar no momento em que
passou a haver mais clientes para vazar entre si.

Restaurado em 17/08 (`deletado_em = null`, `ativo = true`, sem
`chatwoot_account_id`). Restaurar e não recriar: o UUID é o mesmo, então os 6
produtos do sandbox, as `tenant_tools` dos dois e qualquer fixture gravada sob o
id antigo continuaram valendo. Tenant novo teria id novo e órfãos.

## O problema de desenho

**O teste depende de dado de produção que qualquer pessoa pode apagar pela
interface, e nada liga uma coisa à outra.** Quem excluiu não tinha como saber, o
painel não tinha como avisar, e a falha só apareceu quando alguém rodou a suíte à
mão. Não é erro de operação — é acoplamento.

Agrava: dos seis testes que dependem desses slugs, **apenas um quebrou**. Os
outros cinco continuaram verdes por acaso, não por robustez — a diferença é uma
linha:

| Teste | Como resolve o seed | Sobreviveu ao soft delete? |
|---|---|---|
| `isolamento-fase2` (`teste:isolamento`) | `.is('deletado_em', null)` + exige os 3 | **não** — quebrou |
| `isolamento-pedidos` | `.in('slug', SLUGS)`, sem filtro | passou na contagem, **quebrou** depois na função (tenant indisponível) |
| `isolamento-modulos` | `.in('slug', SLUGS)`, sem filtro | sim (verde por acaso) |
| `isolamento-produtos` | `.in('slug', SLUGS)`, sem filtro | sim (verde por acaso) |
| `isolamento-fotos` | `.in('slug', SLUGS)`, sem filtro | sim (verde por acaso) |
| `trava-vendas`, `migracao-*` | só `restaurante-teste`, que seguiu vivo | não exercitado |

Ler linha soft-deletada e chamar de "tenant de teste" é o que salvou três deles.
Isso é pior do que parece: eles passaram **testando isolamento entre tenants que
a aplicação considera excluídos**. Verde por um motivo que ninguém escolheu.

E um `DELETE` físico (ou um cascade futuro) derruba os seis de uma vez.

### Já feito em 17/08: os quatro passaram a falhar alto

Os quatro que não filtravam receberam `.is('deletado_em', null)` na query de
seed. **Isso não é a reescrita** — eles continuam dependendo de dado externo. O
que muda é o modo de falha: apagar seed virou reprovação na pré-condição em vez
de verde mentiroso.

Verificado por sabotagem real, não por leitura: `clinica-teste` foi soft-deletado
de verdade, `teste:modulos` reprovou com
`esperava 3 tenants (…), achei 2` e saída não-zero, e o seed foi restaurado no
`finally` do mesmo processo. Restaurar em script separado deixaria o seed apagado
se algo estourasse no meio — que é o estado que esta semana foi gasta
consertando.

## Escopo — o que fechou e o que não fechou

Levantado em 18/08 com `grep -rn "slug\s*=\s*'<seed>'\|eq('slug', '<seed>')" tests/`,
e **cada modo de falha foi conferido, não presumido** (a primeira leitura desta
lista errou justamente aí: chamou de "passa verde" um teste que estoura).

**Fechados — não tocam mais em seed:** `isolamento-fase2`, `isolamento-modulos`,
`isolamento-produtos`, `isolamento-pedidos`, `isolamento-fotos`.

**Abertos — resolvem seed por slug:**

| Arquivo | Seed | Se o seed sumir |
|---|---|---|
| `tests/migracao-expirar-pedido.mjs:101` | restaurante-teste | **FALHA nomeada** (consertado em 18/08 — era crash sem resumo) |
| `tests/migracao-audio.mjs:144` | restaurante-teste | crash opaco: `t.id` de `undefined`, `TypeError` sem citar o seed |
| `tests/migracao-foto-agente.mjs:80-81` | restaurante-teste, sandbox-de-testes | crash opaco: idem, em `A.id` |
| `tests/migracao-log-idempotente.mjs:115` | restaurante-teste | throw nomeado |
| `tests/restricao-coluna-fase3.mjs:59` | clinica-teste | throw nomeado, já com ponteiro para este doc |
| `tests/seguranca-tenant-tools.mjs:67` | clinica-teste | throw nomeado |
| `tests/jobs-mortos.mjs:91` | sandbox-de-testes | throw nomeado |
| `tests/deletes-escopados.mjs:156` | clinica-teste | throw nomeado, já com ponteiro para este doc |

**Aberto, mas por outro mecanismo:** `tests/trava-vendas.mjs:92` usa
`restaurante-teste` como CHAVE de `PEDIDOS_HISTORICOS`, e itera os tenants que o
banco devolve. Com o seed apagado ele não fica vácuo — apenas deixa de exercitar
aquele tenant, silenciosamente. É o padrão de estado declarado que a CLAUDE.md
recomenda; o acoplamento é mais fraco, não inexistente.

**A boa notícia, medida:** nenhum dos nove passa VERDE com o seed ausente. Todos
morrem, e sete dizem por quê. Não é a classe "teste verde que não testa nada" —
é a classe "suíte que uma operação legítima de painel derruba".

**Por que o guard não pega estes.** `tests/seed-independente.mjs:40-44` é uma
**lista fixa de cinco caminhos**, não uma varredura de `tests/`. Ele prova o que
foi consertado e é cego para o resto — inclusive para um arquivo novo que nasça
acoplado. Trocar a lista por varredura com allowlist para os casos legítimos
(`trava-vendas`, `tenants-efemeros`) é o próximo passo natural, e é barato.

**Ordem sugerida quando isto for retomado:** os dois crashes opacos primeiro
(`migracao-audio`, `migracao-foto-agente`), porque hoje custam uma sessão de
depuração para descobrir que a causa era um tenant apagado; depois a varredura
do guard; e por último a migração dos oito para `tenants-efemeros.mjs`, que é
trabalho maior e sem urgência enquanto os seeds existirem.

## Critério de aceitação da reescrita

Uma frase, e ela é verificável:

> **Apagar seed nenhum consegue deixá-los verdes.**

O antecedente de "-los" é **os cinco de isolamento**, e só eles. O critério
nunca foi enunciado sobre a suíte inteira; o que faltou foi escrever isso ao
lado da palavra FEITO.

**Atingido em 17/08, para os cinco.** Os três seeds foram soft-deletados de verdade e os cinco
rodaram: fase2 56, modulos 15, produtos 21, pedidos 21, fotos 17 — todos zero
vermelhas. Seeds restaurados no `finally` do mesmo processo.

A verificação que fica é `tests/seed-independente.mjs`: estático, roda em
milissegundos e não toca em nada. A comportamental não pode virar suíte — um
teste que apaga tenant de produção para se provar é pior que o defeito que
evita.

O que a reescrita trouxe além do critério:

- **`tests/lib/tenants-efemeros.mjs`**, com o cuidado que a experiência desta
  semana pediu: remoção com DUAS condições (id capturado E prefixo de slug),
  porque as 13 FKs são CASCADE; e slug único por execução, para duas rodadas
  simultâneas não colidirem.
- **Conteúdo semeado e CONFERIDO.** "O tenant A não vê os documentos de B" é
  verdade por vacuidade quando B não tem documento. Antes o teste escapava
  disso por acidente — mirava a Acqua, que tem 12 documentos, e nunca conferia
  que tinha. Agora a vítima nasce com conteúdo e o teste reprova se o `insert`
  falhar em silêncio.
- **Duas asserções vácuas encontradas e consertadas** — ver abaixo.

Registro é lembrete; o que segura é constraint, trigger e teste que falha alto.
Dos três, aqui coube o terceiro — e é ele que está no ar.

## O alvo — o raciocínio que guiou a reescrita

**Cada teste cria e limpa o próprio tenant.** Nenhuma asserção depende de linha
que existia antes dele começar.

Há dois padrões no repo, e **eles não são intercambiáveis** — a escolha depende
de quantas conexões o teste usa:

- **Transação abortada** — `tests/descontratar-preserva-dado.mjs`. Abre `begin`,
  assume o papel com `set local request.jwt.claims`, faz tudo e nunca comita
  (`(transação abortada — produção não mudou)`). É o mais forte quando **tudo
  passa por uma conexão só**, porque nem precisa limpar.
- **Criar e remover** — o que os testes de isolamento já fazem para os
  **usuários**, com `finally`. É o único caminho quando o teste autentica de
  verdade por HTTP: cada login é outra conexão e **não enxerga uma transação não
  comitada**. Foi por isso que `isolamento-fase2` não pode virar transação
  abortada — ele existe justamente para exercitar JWT real.

Ou seja: para os cinco testes de isolamento o caminho foi **estender ao tenant o
que eles já faziam com o usuário** — o `finally` de limpeza já existia; o tenant
entrou nele. Foi o que se fez.

Cuidado ao fazer: criar tenant exige o papel da agência
(`trg_tenants_guard_colunas` recusa `slug`/`nome`/status para qualquer outro), e
numa conexão direta isso sai com
`set local request.jwt.claims = '{"app_metadata":{"papel":"super_admin"}}'` —
nunca desligando o trigger, que valeria para a sessão inteira.

## Dois defeitos menores achados no caminho

1. **`isolamento-pedidos.mjs:140` derruba o processo em vez de reprovar.** Quando
   a criação do pedido de B falha, `pedidoB` fica `null` e a linha seguinte lê
   `pedidoB.id` — `Cannot read properties of null`. O teste morre ali e as
   asserções seguintes não rodam, então não se sabe o que mais quebrou. É
   exatamente a regra do `CLAUDE.md`: *rejeição inesperada tem que virar FALHA,
   não crash*.
2. **As chamadas RPC descartam o `error`.** O padrão `const { data } = await
   admin.rpc(...)` some com o motivo: a falha aparece como `null` e o diagnóstico
   começa do zero. Foi o que escondeu o `25006` por trás de um `— null` (ver
   `supabase/migrations/20260817000000_40_ver_pedido_volatile.sql`). Destruturar
   `{ data, error }` e imprimir o erro no `checar` paga sozinho.

## O prazo, cumprido — para os cinco

Era "antes do próximo cliente entrar". Feito em 17/08, com `emporio`,
`estudyou-sendbox` e `fortalize` já conectados e o quarto (`CEEJAAR`) recém-criado
— dentro do prazo, por pouco.

Os cinco não dependem mais dos seeds, mas **`restaurante-teste`,
`sandbox-de-testes` e `clinica-teste` continuam vivos e ainda sustentam outros
testes** (`trava-vendas`, `migracao-*`, `restricao-coluna-fase3`,
`descontratar-preserva-dado`). Não excluí-los pelo painel segue valendo — só
deixou de ser a única linha de defesa da suíte de isolamento.


## As duas asserções vácuas que a reescrita desenterrou

Nenhuma das duas foi encontrada por leitura: apareceram porque trocar a Acqua
por uma vítima controlada obriga a perguntar *o que exatamente estou afirmando*.

**1. O token do Chatwoot — a mais séria.** A asserção era:

```js
const { data } = await cliente.from('tenants').select('id, chatwoot_token').eq('id', acqua.id);
checar('não lê o token do Chatwoot da Acqua', (data ?? []).length === 0);
```

A coluna `chatwoot_token` saiu de `tenants` na **migração 21** (11/08) e foi para
`tenant_credenciais`. Desde então o select ERRA, `data` vem `null`, e
`(null ?? []).length === 0` é `true`. **A asserção de isolamento do segredo mais
sensível do sistema passou seis dias verde sem executar nada.** Agora mira
`tenant_credenciais`, exige que a query **não** tenha erro, e tem contraprova de
que a linha existe.

**2. `UPDATE em tenant_tools de outro tenant não afeta linha.`** Só significa
alguma coisa se o outro tenant TIVER a linha. Passava porque os três seeds tinham
`transferir_humano` contratado — estado do mundo, de novo. Os tenants efêmeros
agora nascem com a tool explicitamente.

Os dois casos têm a mesma forma: **uma asserção negativa sem contraprova de que
havia algo para encontrar.** É a próxima classe a varrer quando sobrar tempo.
