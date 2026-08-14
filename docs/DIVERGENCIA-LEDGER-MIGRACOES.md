# Ledger de migrações × diretório — RESOLVIDO em 2026-08-14

Levantado em 2026-08-11 durante a preparação da migração 16. Os quatro achados
estão fechados. Este documento vira o registro do que foi decidido e **por quê**,
principalmente no achado 4, onde a conclusão foi o oposto do que três auditorias
tinham escrito.

Estado final, medido:

```
ledger: 41 entradas | arquivos: 31
só em arquivo (não aplicada):      nenhuma
mesma versão com nome diferente:   nenhuma
números de migração duplicados:    nenhum
só no ledger (sem arquivo):        10 — as 8 da baseline + as 2 do podcast
```

As 10 sem arquivo são as duas categorias **deliberadas** descritas abaixo. Toda
outra divergência foi eliminada.

---

## Achado 4 (o que mais importava) — `podcast_*` NÃO é código morto

Três auditorias marcaram `podcast_agendamentos`, `agendar_podcast` e os índices
como código morto, com o argumento "zero referências em `src/`".

**A premissa está certa e a conclusão está errada.** Zero referências neste repo
é exatamente o que se espera de uma aplicação **diferente** que compartilha o
banco. Ausência de referência num codebase não é evidência de morte; é evidência
de não ser nosso.

### A prova de que está viva

| evidência | valor |
|---|---|
| linhas | **14** (a auditoria dizia 13 — o número envelheceu) |
| última escrita | **2026-08-09**, cinco dias antes desta análise |
| inserts / deletes na janela de 30 dias | **23 inserts, 9 deletes** |
| `idx_scan` na mesma janela | **117** |
| distribuição | 89 em `dia`, 26 em `whatsapp`, 2 na pkey |

A distribuição é o argumento mais forte: ela bate **exatamente** com o desenho.
`whatsapp` tem índice único (deduplicar quem já se inscreveu) e `dia` serve a
view de vagas. Uma tabela abandonada não produz esse padrão — produz zero.

### Por que a RLS "sem policy" não significa abandono

`podcast_agendamentos` tem RLS ativo e **zero policies**, o que à primeira vista
parece tabela esquecida com segurança pela metade. É o contrário: é um desenho
de acesso fechado, em que ninguém toca a tabela direto e tudo passa por dois
objetos que **contornam a RLS de propósito**:

- `agendar_podcast(date, text, text, text)` — `SECURITY DEFINER`, dono `postgres`;
- `podcast_vagas` — view do `postgres` sem `security_invoker`.

Com RLS ligada e nenhuma policy, `anon` e `authenticated` não enxergam uma linha
sequer pela tabela, mesmo tendo GRANT. O caminho é a função e a view, e só.

### O que a tabela contém

Nome, empresa e **WhatsApp de 14 pessoas reais**, inscritas no *Podcast Vitrine
ACIA de Negócios (FEMUAR)* — o nome está no comentário da própria migração
guardada no ledger. Não é dado nosso.

### Decisão: NÃO DROPAR. Nunca.

Vale mesmo agora que o evento acabou (a view fixa a janela `2026-08-01` a
`2026-08-09`, e a última inscrição é de 09/08). Evento encerrado não torna o
dado nosso — torna-o histórico de terceiros.

> Uma tabela de outra aplicação convivendo é chato; uma tabela de outra
> aplicação apagada é incidente de terceiros.

**Onde o SQL delas vive:** na coluna `statements` do próprio ledger, íntegro.
Não foi reconstruído em `supabase/migrations/` de propósito — um ambiente novo
deste repo **não deve** criar tabela de outra aplicação. A divergência é a
resposta certa, e passa a ser documentada em vez de invisível.

**Se um dia precisar mexer:** procure o dono do Podcast Vitrine ACIA antes.

---

## Achado 1 — migração 17 aplicada e fora do ledger — RESOLVIDO

`match_kb_documentos` tinha o clamp de `match_count` no corpo, mas não havia
entrada em `schema_migrations`.

Registrada como `20260804130000 / 17_clamp_match_count`, com os `statements` do
arquivo. **A inserção foi condicionada à verificação do efeito** (`pg_get_functiondef`
contendo o clamp): marcar como aplicada uma migração que não rodou seria pior
que a divergência original — a próxima pessoa confiaria no ledger.

---

## Achado 2 — índice do histórico pendente — RESOLVIDO

`idx_log_conversa (tenant_id, conversation_id, criado_em)` não existia.
`conversa_historico()` varria todas as mensagens do tenant para abrir UMA
conversa.

Aplicado em 14/08 com `mensagens_log` em **72 linhas**: 70 ms. O arquivo previa
8 linhas; a diferença não muda nada, mas a urgência subiu — desde a migração 37
o log é gravado a cada mensagem, então a tabela deixou de ser estática.

**O planner ainda NÃO usa o índice, e isso está certo.** Um `explain (analyze)`
da consulta do `conversa_historico()` hoje mostra `Sort` + varredura: com 72
linhas, ler a tabela inteira é mais barato que descer no índice. Quem conferir
agora e esperar ver `Index Scan` vai achar que a migração falhou — não falhou.
O índice existe para o dia em que cada cliente tiver milhares de mensagens, e é
justamente por isso que ele foi criado enquanto criar custa 70 ms.

É a mesma forma do índice HNSW descrita no CLAUDE.md: existir e não ser usado
pelo plano atual não é defeito, desde que se saiba por quê.

---

## Achado 3 — dois arquivos numerados 18 — RESOLVIDO

```
20260805120000_18_indice_historico_conversa.sql   (pendente)
20260805155810_18_seguranca_tenant_tools.sql      (aplicada)
```

Renumerado o **pendente**, porque renumerar o aplicado quebraria a
correspondência nome ↔ versão do ledger:

```
20260814170000_39_indice_historico_conversa.sql
```

O timestamp acompanhou o número e bate com a versão gravada na aplicação real.

---

## Como reconferir

```bash
node -e "
const fs=require('fs');
const m=fs.readFileSync('.env.local','utf8').match(/SUPABASE_DB_URL=(.*)/);
const {Client}=require('pg');
const c=new Client({connectionString:m[1].trim(),ssl:{rejectUnauthorized:false}});
(async()=>{await c.connect();
const r=await c.query('select version, name from supabase_migrations.schema_migrations order by version');
const arq=new Set(fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')&&!f.endsWith('_rollback.sql')).map(f=>f.slice(0,14)));
console.log('so no ledger:', r.rows.filter(x=>!arq.has(x.version)).map(x=>x.name).join(', '));
await c.end();})();
"
```

O esperado é **exatamente** 10 nomes: `01_extensions_e_helpers` … `08_hardening_permissoes`
(reconstruídas em `supabase/baseline/`) e as duas `podcast_vitrine_acia_*`.
Qualquer nome a mais é divergência nova.
