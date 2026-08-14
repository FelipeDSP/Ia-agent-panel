# Baseline do schema

Auditoria de 2026-08-05. O repositório e o banco de produção não contavam a
mesma história sobre quais migrações existem. Esta pasta é o que fecha a
diferença.

## O que estava errado

O ledger do Supabase (`supabase_migrations.schema_migrations`) listava 17
migrações aplicadas. O repositório tinha 7 arquivos. E **nenhum dos 7 batia com
o ledger** — nem em versão, nem em existência:

| Migração | Versão no ledger | Versão do arquivo (antes) | Situação |
|---|---|---|---|
| 01–08 | `20260724152045`…`20260724152456` | — | Aplicadas, sem arquivo |
| 09 `api_n8n` | `20260724153621` | `20260724160000` | Divergente |
| 10 `remover_fallback_app_tenant_id` | `20260724153651` | `20260724160500` | Divergente |
| 11 `api_config_tool` | `20260724185902` | — | Aplicada, sem arquivo |
| 12 `sync_usuario_app_metadata` | `20260724200507` | `20260724200000` | Divergente |
| 13 `guard_colunas_e_versao_prompt` | `20260724205021` | `20260724210000` | Divergente |
| 14 `storage_kb_arquivos` | `20260727195732` | `20260727150000` | Divergente |
| 15 `billing` | `20260727210627` | `20260727180000` | Divergente |
| 16 | — | — | Não existe (numeração pula) |
| 17 `clamp_match_count` | **ausente** | `20260804130000` | Aplicada no banco, fora do ledger |

Duas consequências concretas:

1. **`supabase db push` contra produção replayaria seis migrações.** Nenhuma das
   versões dos arquivos constava no ledger, então o CLI as trataria como novas.
   Elas são idempotentes (`create or replace`, `if not exists`, `on conflict`),
   então provavelmente sobreviveriam — mas "provavelmente sobrevive" não é
   critério para rodar DDL no banco de um cliente em produção.

2. **Não havia como levantar um ambiente novo.** Sem 01–08, as migrações do repo
   fazem `alter`/`create or replace` sobre tabelas e funções que ninguém criou.
   É por isso que `tests/isolamento-fase2.mjs` roda contra produção criando
   usuários reais no Auth: não existia alternativa.

## O que foi feito

- Os 6 arquivos divergentes foram **renomeados para a versão do ledger**. Nada
  foi aplicado no banco — só arquivo. Agora `db push` reconhece as seis como já
  aplicadas em vez de tentar rodá-las de novo.
- A migração **11** ganhou arquivo (`20260724185902_11_api_config_tool.sql`),
  extraída de `pg_get_functiondef()` no próprio banco, com a versão do ledger.
- **`00_schema_base.sql`** nesta pasta reconstrói 01–08, extraído do catálogo
  (`pg_attribute`, `pg_constraint`, `pg_indexes`, `pg_policies`,
  `pg_get_functiondef`, `pg_get_triggerdef`), não transcrito de memória.

> **Este arquivo nunca foi executado.** Foi montado a partir do catálogo de
> produção, mas não havia onde rodá-lo sem tocar no banco do cliente — sem
> Postgres local, Docker ou CLI do Supabase. Decisão consciente de 2026-08-05:
> deixar sem validar em vez de rodar DDL, ainda que em transação revertida,
> contra o banco onde o agente da Acqua atende.
>
> Na prática: **o primeiro bootstrap é o teste**. Espere erros de sintaxe ou de
> ordem de dependência na primeira execução e corrija-os aqui. O conteúdo (tipos,
> constraints, índices, policies, corpos de função) veio do banco e está certo; o
> que não foi exercitado é o script rodando do zero, numa base vazia.

## O que continua aberto

**A 17 não está no ledger.** A função `match_kb_documentos` já está com o clamp
aplicado no banco (confirmado por `prosrc`), mas alguém a aplicou por SQL avulso
sem registrar. Enquanto o registro não existir, um `db push` tentaria rodá-la —
inofensivo, é `create or replace` com o mesmo corpo, mas mantém o ledger mentindo.

Para acertar, rode uma vez em produção:

```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('20260804130000', '17_clamp_match_count')
on conflict (version) do nothing;
```

Isso é escrita em produção — não foi executada aqui de propósito. É só
contabilidade: não toca em nenhum objeto do schema.

**01–08 e 11 são "remote-only" para o CLI.** Como o baseline mora fora de
`migrations/`, `supabase migration list` vai mostrá-las como presentes no banco
e ausentes localmente. Isso é esperado. Se algum dia quiserem silenciar,
`supabase migration repair` é o caminho — mas ele mexe no ledger de produção.

**As migrações do produto `podcast_vitrine_acia`** (`20260729130722` e
`20260729130741`) estão no mesmo banco e no mesmo ledger, e não pertencem a este
projeto. Não foram reconstruídas aqui — um ambiente novo DESTE repo não deve
criar tabela de outra aplicação.

> **NÃO DROPE `podcast_agendamentos`, `agendar_podcast`, `podcast_vagas` nem os
> índices.** Três auditorias os marcaram como código morto pelo argumento "zero
> referências em `src/`" — premissa certa, conclusão errada: zero referências
> aqui é o que se espera de outra aplicação no mesmo banco.
>
> Medido em 14/08/2026: 14 linhas, última escrita em 09/08, 23 inserts e 9
> deletes numa janela de 30 dias, 117 varreduras de índice distribuídas
> exatamente como o desenho prevê (89 em `dia`, 26 em `whatsapp`). A tabela
> guarda nome, empresa e WhatsApp de 14 pessoas reais. O SQL original está
> íntegro na coluna `statements` do ledger.
>
> Detalhe que engana: RLS ativa com ZERO policies parece tabela esquecida. É o
> contrário — o acesso passa por `agendar_podcast` (`SECURITY DEFINER`) e pela
> view `podcast_vagas`, que contornam a RLS de propósito. Ver
> `docs/DIVERGENCIA-LEDGER-MIGRACOES.md`.

## Como levantar um ambiente novo

```bash
psql "$SUPABASE_DB_URL" -f supabase/baseline/00_schema_base.sql
supabase db push          # aplica 09 em diante
```

Depois disso dá para rodar `npm run teste:isolamento` sem tocar em produção —
que é o ponto.

**Em produção não se roda o baseline.** O schema já existe. Tudo nele é
idempotente, mas confira antes em vez de contar com isso.
