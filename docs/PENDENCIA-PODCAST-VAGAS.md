# Pendência — `podcast_vagas`: duas camadas ausentes, e o conserto óbvio quebra a página

**Estado:** levantado em 2026-08-21, **nada consertado**. Não é vazamento hoje —
mas o que impede o vazamento é o texto do `select`, não o modelo de permissão.

**Gatilho:** o "antes de mexer na view" é fraco de propósito documentado — quem
for mexer numa página de vagas não vai pensar em `BYPASSRLS`. Ver a seção "O
gatilho que presta" no fim.

## O que está no ar

`podcast_vagas` é uma view sobre `podcast_agendamentos`, de **outra aplicação**
no mesmo banco (o repo tem zero código de podcast — ver `AUDIT-DEBITO.md`). A
base guarda **PII**: `nome`, `empresa`, `whatsapp`.

```sql
SELECT d.d::date AS dia,
       count(a.id)::integer AS ocupadas,
       (6 - count(a.id))::integer AS vagas_restantes
  FROM generate_series('2026-08-01','2026-08-09','1 day') d(d)
  LEFT JOIN podcast_agendamentos a ON a.dia = d.d::date
 GROUP BY d.d ORDER BY d.d;
```

### Duas camadas ausentes ao mesmo tempo

**1. Permissão.** O ACL é o default do projeto, inteiro, para os três roles:

```
podcast_vagas         {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}
podcast_agendamentos  {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}
```

`anon` tem `arwdDxtm` — o conjunto inteiro, não só `SELECT`. Ninguém concedeu:
é o `ALTER DEFAULT PRIVILEGES` do projeto (ver CLAUDE.md).

**2. `security_invoker`.** A view não tem, então roda como `postgres`, que tem
`rolbypassrls = true`. Ela lê a base **passando por cima da RLS**.

### O que segura hoje, e por que não basta

Medido, não deduzido:

| tentativa como `anon` | resultado |
|---|---|
| `select from podcast_vagas` | **passa** — 9 linhas |
| `delete from podcast_vagas` | `55000 cannot delete from view` |
| `insert into podcast_vagas` | `55000 cannot insert into view` |
| `select from podcast_agendamentos` | passa, **0 linhas** (RLS sem policy nega) |
| `insert into podcast_agendamentos` | `42501` violates row-level security policy |

A escrita é barrada por **`55000`**, que é a view não ser auto-atualizável — ou
seja, **proteção por acidente de implementação**, não por permissão. É o mesmo
argumento que decidiu a lista de colunas da `conversas_painel`, agora do outro
lado: quando o que segura é uma propriedade acidental, a próxima mudança a
remove sem avisar.

E a leitura só não vaza porque o `select` expõe agregado. **Simulado:** uma view
idêntica com `max(a.nome)` acrescentado devolveu a `anon`, imediatamente e sem
erro:

```
[{"dia":"2026-08-03","ocupadas":2,"nome_vazado":"Victor Milan"},
 {"dia":"2026-08-02","ocupadas":1,"nome_vazado":"Richelmer"}]
```

Nomes reais. **Uma coluna a mais no `select` e a PII sai.**

## O conserto óbvio QUEBRA A PÁGINA — e em silêncio

`revoke` + `security_invoker` parece a resposta e **não é**. Com
`security_invoker`, a view passa a rodar como `anon`, e `anon` lendo
`podcast_agendamentos` recebe **zero linhas** (a RLS sem policy nega tudo). O
`left join` continua produzindo os dias, e a contagem vira zero:

```
a verdade (postgres)        01:6  02:1  03:2  04:1  05:1
anon SEM security_invoker   01:6  02:1  03:2  04:1  05:1
anon COM security_invoker   01:0  02:0  03:0  04:0  05:0    <- todas livres
```

**A página mostraria 6 vagas livres em todos os dias**, incluindo o 01/08 que
está lotado. Ninguém receberia erro; alguém agendaria numa vaga que não existe.
É exatamente a falha silenciosa que a gente vem trocando por barulhenta — e o
conserto a introduziria.

## As saídas reais — recomendo a A

**RECOMENDAÇÃO: A (privilégio de coluna na base + policy + `security_invoker`).**
O motivo de ela ganhar é um só: **põe a proteção na permissão em vez da lista do
`select`**, e por isso **sobrevive a alguém acrescentar coluna**. Hoje a segurança
da view é propriedade do texto dela; com A passa a ser propriedade do banco. Quem
editar a view amanhã não precisa saber de `BYPASSRLS` para não vazar — o
privilégio recusa.

B e C ficam como fallback declarado: B torna a intenção legível sem mudar o que
protege; C fecha só a camada de permissão. As duas mantêm a dependência do
`select`.

**Nenhuma entra sem falar antes com quem mantém a aplicação do podcast** — o repo
não tem o código da página.

### As três, em detalhe

**A. Privilégio de COLUNA na base + policy para `anon` + `security_invoker`.**
É a única que faz o modelo de permissão carregar a proteção:

```sql
-- a RLS passa a permitir LER as linhas...
create policy p_podcast_anon_conta on public.podcast_agendamentos
  for select to anon using (true);
-- ...mas o privilegio so alcanca as colunas sem PII
revoke all on public.podcast_agendamentos from anon;
grant select (id, dia) on public.podcast_agendamentos to anon;
```

Com isso, `anon` conta por dia e **não consegue** ler `nome`/`empresa`/`whatsapp`
— nem pela view, nem direto, nem numa view futura que alguém acrescente a
coluna. A proteção deixa de depender do texto do `select`.

Risco: a policy `using (true)` abre as LINHAS. Se amanhã alguém conceder `select`
na coluna `nome`, a policy não segura. Mas aí seriam duas mudanças deliberadas,
não uma distração.

**B. Trocar a view por função `SECURITY DEFINER`** que devolve o agregado. O
"definer" fica explícito na assinatura em vez de implícito no dono da view, e a
superfície passa a ser um contrato de retorno. Não resolve o ACL da base, mas
torna a intenção legível. Precedente no próprio projeto: `agendar_podcast` já é
`SECURITY DEFINER`.

**C. Mínimo: `revoke` sem `security_invoker`.** Tirar `arwdDxtm` e deixar
`grant select` só para quem precisa. Fecha a camada de permissão, mantém a view
como definer (a página continua funcionando), e deixa a dependência do `select`
declarada em `comment on view`. **Não** resolve o problema de fundo, mas é a
única que não pode quebrar nada.

Em qualquer uma: **o que pode quebrar a página é o `revoke` de `anon`.** O repo
não tem o código da página, então não dá para saber daqui se ela lê como `anon`
(chave anônima do Supabase) ou autenticada. `agendar_podcast` está concedida a
`authenticated` e `service_role` — **não a `anon`** —, o que sugere que o fluxo
de escrita já não é anônimo; se a leitura seguir o mesmo caminho, o `revoke` de
`anon` é inócuo. **Isso precisa ser confirmado com quem mantém aquela
aplicação, antes de qualquer coisa.**

## O gatilho que presta

"Antes de mexer na view" depende de alguém lembrar de `BYPASSRLS` enquanto edita
uma página de vagas. Não vai acontecer.

O gatilho mecânico: **um teste que varre `pg_class` e reprova toda view de
`public` sem `security_invoker` que não esteja numa lista de exceções
declarada** — com o motivo escrito ao lado de cada exceção. Aí `podcast_vagas`
aparece como exceção *documentada*, e qualquer view nova nasce coberta.

É o mesmo formato do `npm run teste:superficie` (rota sob `/painel/` que não seja
declarada reprova) e do `teste:grants-n8n` (varre por padrão, não por lista
fixa). O esquecimento vira vermelho, que alguém nota, em vez de vazamento, que
ninguém nota.
