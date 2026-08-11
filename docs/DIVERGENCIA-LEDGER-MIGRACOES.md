# Ledger de migrações divergente do diretório, nos dois sentidos

Levantado em 2026-08-11 durante a preparação da migração 16, comparando
`supabase_migrations.schema_migrations` (produção) com `supabase/migrations/`.
**Não bloqueia a 16** — está aberta como higiene separada, de propósito, para não
misturar reconciliação de ledger com um deploy de segurança.

Contexto do CLAUDE.md: já houve um episódio em que nenhum arquivo batia com o
ledger, porque as migrações vinham sendo aplicadas por SQL avulso (editor/MCP),
que grava a versão com o timestamp do momento da aplicação, enquanto o arquivo
ficava com outro. Foram renomeadas na época. Estes quatro casos são o resíduo.

## Achado 1 — migração 17 aplicada em produção, ausente do ledger

`20260804130000_17_clamp_match_count.sql` não tem entrada em
`schema_migrations`, mas **está aplicada**: `pg_get_functiondef` de
`match_kb_documentos` mostra o clamp de `match_count` no corpo.

Efeito: um `supabase db push` a trataria como nova e a replayaria contra
produção. Neste caso o replay é `create or replace function` e seria inofensivo,
mas o mecanismo é o mesmo que tornaria perigoso um replay de migração com DDL
destrutivo.

## Achado 2 — migração 18_indice_historico_conversa genuinamente pendente

`20260805120000_18_indice_historico_conversa.sql` não está no ledger **e não
está aplicada**: `mensagens_log` tem só `idx_log_tenant_data`
`(tenant_id, criado_em desc)`; o índice com `conversation_id` não existe.

O próprio cabeçalho do arquivo explica a urgência baixa e a janela: a tabela tem
8 linhas hoje porque o n8n ainda não chama `api_n8n_registrar_mensagem` em
produção. Criar o índice agora é instantâneo; criar depois, com carga, é janela
de manutenção. Vale aplicar antes de o log começar a ser gravado de verdade.

## Achado 3 — dois arquivos numerados 18

```
20260805120000_18_indice_historico_conversa.sql   (pendente — achado 2)
20260805155810_18_seguranca_tenant_tools.sql      (aplicada, no ledger)
```

O prefixo numérico é convenção humana e não afeta a ordenação real (que é por
timestamp), mas duplicar o número quebra a referência por número usada em todo
o repo — comentários de migração citam "migração 13", "migração 15", "migração
16". "Migração 18" hoje é ambígua.

## Achado 4 — duas entradas no ledger sem arquivo correspondente

```
20260729130722  podcast_vitrine_acia_agendamentos
20260729130741  podcast_vitrine_acia_funcao_agendar
```

Aplicadas em produção em 29/07, sem arquivo em `supabase/migrations/`. Pelo nome
parecem de outra iniciativa (vitrine/podcast) que compartilhou o mesmo banco.

Precisa decidir: (a) reconstruir os arquivos a partir de
`pg_get_functiondef`/`pg_dump` como foi feito com as migrações 01–08 em
`supabase/baseline/`, ou (b) documentar explicitamente que são de outro escopo e
que o ledger deste repo não as cobre. O que não pode continuar é ficarem
invisíveis: quem levantar um ambiente novo a partir do repo não terá os objetos
que elas criaram, e o ambiente novo diverge de produção sem aviso.

## Ordem sugerida

1. Achado 4 primeiro — decidir se os objetos do podcast fazem parte deste schema.
   Isso determina o que "ambiente limpo reproduzível" significa aqui.
2. Achado 2 — aplicar o índice enquanto `mensagens_log` está vazia.
3. Achados 1 e 3 — renomear arquivos e inserir a entrada faltante no ledger,
   alinhando nome ↔ versão conforme a regra do CLAUDE.md.

## Como reproduzir

```bash
node -e "
const fs=require('fs');
const m=fs.readFileSync('.env.local','utf8').match(/SUPABASE_DB_URL=(.*)/);
const {Client}=require('pg');
const c=new Client({connectionString:m[1].trim(),ssl:{rejectUnauthorized:false}});
(async()=>{await c.connect();
const r=await c.query('select version, name from supabase_migrations.schema_migrations order by version');
r.rows.forEach(x=>console.log(x.version, x.name||''));
await c.end();})();
"
ls supabase/migrations/
```
