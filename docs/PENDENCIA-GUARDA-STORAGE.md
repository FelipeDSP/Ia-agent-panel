# Pendência — a guarda de dado alheio é cega para o Storage

> Registrada em **2026-08-17**, junto com o escopo por tenant dos quatro deletes.
> **Não implementada de propósito.** O risco hoje é baixo; o gatilho abaixo é o
> momento em que deixa de ser.

## O que a guarda cobre, e o que não cobre

`tests/lib/guarda-tenants.mjs` tira um retrato (md5 por linha) de **14 tabelas**
do Postgres e reprova se um comando tocou tenant que não criou. É o que pegou o
risco dos deletes de limpeza.

**Ela não olha o Storage.** `storage.objects` não está em `TABELAS`, e um
`remove()` de bucket não aparece em retrato nenhum. `tests/isolamento-fotos.mjs`
apaga objeto de bucket em três pontos (`limparObjetos`, e mais dois no `finally`)
— mesma classe dos quatro deletes de SQL, num lugar onde a guarda é cega.

## Por que o risco é baixo HOJE — e a parte que não é

**Os `remove()` de hoje já são escopados por tenant, por construção.** O layout
do bucket é `<tenant_id>/<arquivo>`, e o teste monta o caminho a partir do id do
tenant que ele usa (`${A.id}/...`). Não há varredura por prefixo nem `list()`
seguido de remoção em lote. Conferido em 17/08:

| bucket | pasta | dono | objetos |
|---|---|---|---|
| `produto-fotos` | `ebef4715…` | `restaurante-teste` | 1 |
| `kb-arquivos` | `ebef4715…` | `restaurante-teste` | 4 |
| `kb-arquivos` | `e94e9a48…` | **`estudyou-sendbox`** (cliente real) | **12** |

Duas coisas que essa tabela mostra e que mudam a leitura:

1. **Em `produto-fotos`, só o `restaurante-teste` tem foto** — é o que sustenta
   "risco baixo".
2. **Em `kb-arquivos` já há 12 arquivos de um cliente real.** Nenhum teste hoje
   toca esse bucket (verificado por varredura em `tests/` e `scripts/`), mas a
   cegueira da guarda já vale para dado de cliente, não só para dado de teste.

**O que sobra de risco real hoje**, mesmo com os caminhos escopados: os nomes de
arquivo são **fixos** (`00000000-0000-0000-0000-00000000000a.jpg`). Duas execuções
simultâneas do mesmo teste, ou um objeto de cliente que por acaso tenha esse
nome dentro da própria pasta, colidem. É a mesma aposta em improbabilidade que os
quatro deletes faziam — só que numa superfície menor.

## Gatilho para retomar

**O primeiro cliente além do `restaurante-teste` com foto no catálogo**
(`produto-fotos`). A partir daí, um `remove()` mal escopado deixa de atingir só
dado de teste — e, ao contrário de linha de tabela, objeto de bucket não tem
soft delete nem histórico: some e acabou.

Antecipa o gatilho, se acontecer antes: qualquer teste ou script novo que passe
a **escrever ou apagar em `kb-arquivos`**, porque lá o dado de cliente real já
está.

## O que fazer quando vier

Duas frentes, e a primeira é barata:

1. **Vigiar `storage.objects` na guarda.** A tabela tem `bucket_id`, `name`,
   `owner`, `updated_at` e metadados. O tenant sai do primeiro segmento de
   `name` (`split_part(name, '/', 1)`), o que encaixa no formato de `TABELAS` com
   um campo a mais: hoje `tenant` é um nome de coluna, e aqui precisaria aceitar
   expressão. É a mudança mais valiosa por linha escrita — passa a cobrir os dois
   buckets de uma vez, incluindo o dado do `estudyou-sendbox`.
2. **Nome de arquivo único por execução** em `isolamento-fotos.mjs`, no lugar dos
   UUIDs fixos. Some com a colisão sem depender da guarda.

Nada disso é migração: `storage.objects` é tabela existente e a leitura é
`select`. Não precisa de branch, o que importa porque o projeto está no **plano
Free** e branch exige Pro.
