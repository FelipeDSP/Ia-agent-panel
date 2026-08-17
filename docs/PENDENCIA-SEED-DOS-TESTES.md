# Pendência — os testes de isolamento dependem de seed que alguém pode apagar

> Registrada em **2026-08-17**, depois de a suíte de isolamento passar quatro dias
> cega. **Não implementada de propósito** — o conserto rápido já foi aplicado
> (seeds restaurados). Este arquivo é a reescrita, que fica para depois.

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

## O alvo

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

Ou seja: para os cinco testes de isolamento o alvo é **estender ao tenant o que
eles já fazem com o usuário**. O `finally` de limpeza já está escrito; falta o
tenant entrar nele.

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

## Gatilho para retomar

Não tem gatilho de evento — tem prazo. **Antes do próximo cliente entrar.** A
suíte de isolamento é a única prova de que multi-tenancy funciona, e o custo de
ela estar cega cresce com o número de clientes, que é justamente o que está
subindo.

Enquanto não for feito, o paliativo é operacional e frágil: **não excluir**
`clinica-teste`, `sandbox-de-testes` e `restaurante-teste` pelo painel.
Escrito aqui porque paliativo que só existe na cabeça de alguém não é paliativo.
