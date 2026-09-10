-- =====================================================================
-- 57. SKU gerado por tenant + categoria por tenant (fase 1: banco)
-- =====================================================================
--
-- ESCOPO: banco e painel. Nada de n8n — a exposicao do sku ao cliente final, a
-- resolucao por sku nas ferramentas e o "mapa do catalogo" sao FASE 2, junto da
-- fusao das quatro tools de pedido, que ja vai reescrever a assinatura delas.
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRACAO FAZ
--
--   1. `categorias` — lista POR TENANT, com isolamento por RLS;
--   2. `produtos.categoria_id` — UMA categoria por produto, opcional no BANCO
--      e obrigatoria no FORMULARIO (ver abaixo);
--   3. `produto_sku_seq` — o contador por tenant que faz o sku nunca ser
--      reusado;
--   4. troca do indice unico de sku, que hoje libera numero ao apagar produto;
--   5. trigger que atribui o sku no INSERT;
--   6. o BACKFILL dos 90 produtos vivos dos quatro tenants.
--
-- ---------------------------------------------------------------------
-- O CONTADOR EXISTE PORQUE `max(sku)+1` NAO GARANTE O QUE PRECISA SER GARANTIDO
--
-- A regra e "nunca reusado": produto apagado NAO devolve o numero para a fila,
-- senao um pedido antigo passaria a apontar para outro produto.
--
-- `max(sku)+1` cumpre isso ENQUANTO o soft delete for respeitado — a linha fica,
-- o max continua alto. Mas a garantia passa a depender de ninguem nunca fazer
-- `delete` fisico, e isso e uma promessa sobre o comportamento futuro do codigo,
-- nao uma propriedade do schema. Uma tabela de contador torna "so sobe" um fato
-- do banco: apagar produto, de qualquer jeito, nao mexe no contador.
--
-- ---------------------------------------------------------------------
-- O INDICE UNICO DE HOJE JA TEM O DEFEITO, E O CODIGO JA O DOCUMENTA
--
-- Hoje existe:
--
--   uq_produtos_tenant_sku ... (tenant_id, sku) WHERE sku IS NOT NULL
--                                                 AND deletado_em IS NULL
--
-- Com `deletado_em is null` no predicado, apagar um produto TIRA a linha do
-- indice e libera o numero. O comentario de `excluirProduto` em
-- `src/app/(app)/painel/catalogo/acoes.ts` diz isso com todas as letras:
-- "o indice unico de SKU e parcial em `deletado_em is null`, entao apagar assim
-- libera o SKU para reuso". Era verdade e era aceitavel quando o sku era texto
-- digitado pelo cliente; deixa de ser quando ele vira sequencia.
--
-- A troca abaixo tira o `deletado_em` do predicado. `sku is not null` fica: os
-- produtos legados sem sku nao colidem entre si.
--
-- ---------------------------------------------------------------------
-- CATEGORIA: OBRIGATORIA NO FORMULARIO, NULL NO BANCO
--
-- `not null` obrigaria a inventar uma categoria "sem categoria" para os 90
-- produtos existentes — que e o mesmo vazio com outro nome, e ainda por cima um
-- nome que o cliente veria na tela e o agente falaria na fase 2. A coluna e
-- nullable; quem exige e o formulario, para produto NOVO. Os legados entram pelo
-- backfill desta migracao.
--
-- ISOLAMENTO POR TENANT SEM DEPENDER DA APLICACAO: a FK e COMPOSTA,
-- `(tenant_id, categoria_id) -> categorias (tenant_id, id)`. Uma FK simples em
-- `categorias(id)` deixaria o produto do tenant A apontar para a categoria do
-- tenant B — o banco aceitaria, e a RLS nao pega, porque a leitura da categoria
-- aconteceria pelo join e nao por um select direto. Com a FK composta o proprio
-- Postgres recusa.
--
-- REMOVER CATEGORIA QUE TEM PRODUTO: `on delete restrict`, ou seja, RECUSA.
-- Decidido, e as alternativas foram descartadas por motivo:
--   - `set null` deixaria produto sem categoria em silencio, e o formulario
--     passaria a exigir algo que o proprio sistema tirou;
--   - `cascade` apagaria produto, que e trabalho de cadastro do cliente — a
--     mesma razao pela qual descontratar nao apaga catalogo (CLAUDE.md).
-- O painel mostra quantos produtos usam a categoria e manda mover antes.
--
-- ---------------------------------------------------------------------
-- O BACKFILL, E O QUE ELE NAO FAZ
--
-- SKU. Onde o nome tem prefixo numerico, AQUELE numero vira o sku e sai do nome.
-- Medido em 2026-09-10: `emporio` tem 40 prefixos distintos de 1 a 40, sem
-- repetido e sem buraco; `estudyou-sendbox` tem 21, de 1 a 21, idem. Os clientes
-- ja mantem uma sequencia a mao, no campo errado. Adotar o numero deles e o que
-- impede o produto que o emporio chama de "11" de virar sku 27 — dois numeros
-- para a mesma coisa, com o cliente confiando no errado.
--
-- SKU JA PREENCHIDO NAO E TOCADO. Tres produtos tem sku de TEXTO, digitado no
-- painel: `BEB-AGUA-500`, `BEB-CHOPP-300` (restaurante-teste) e `LAV-CAM-SOC`
-- (sandbox-de-testes). O backfill preenche so o que esta vazio. **A consequencia
-- fica declarada: a coluna passa a misturar sequencia numerica e texto legado.**
-- Sobrescrever seria apagar dado que uma pessoa digitou; e uniformizar e decisao
-- de produto, nao de migracao. Os dois tenants sao de teste, entao isto nao
-- alcanca cliente real hoje.
--
-- CATEGORIA. Agrupa pela PRIMEIRA PALAVRA do nome ja sem o prefixo. Medido:
--   emporio  13 categorias para 41 produtos (Polpa 15, Queijo 7, Bolo 3, Cafe 3,
--            Iogurte 2, Pao 2, Capuccino 2, Costela 2, e 5 com 1)
--   sendbox   7 para 30 (Curso 13, Denuncyou 6, Treinamento 5, Chatyou 3, e 3)
--   restaurante-teste 12 para 13, sandbox-de-testes 3 para 6
-- Isso troca "classificar 41 produtos do zero" por "revisar 13 grupos".
--
-- A COMPARACAO E SEM CAIXA, e nao e esperteza: o `sendbox` tem
-- "CURSO DE PRIMEIROS SOCORROS" ao lado de doze "Curso de ...". Sem isso
-- apareceriam `Curso` E `CURSO` — exatamente o "Queijo/queijos/QUEIJOS" que a
-- lista por tenant existe para impedir, e criado por mim, no backfill. A grafia
-- que fica e a MAIS FREQUENTE do grupo.
--
-- QUAL PECA FAZ ESSE TRABALHO, medido e nao suposto: NAO e o `lower()` do
-- agrupamento. Trocando `lower(token)` por `token` na secao 7, o resultado e
-- IGUAL — uma categoria `Curso` com 13 produtos. Quem colapsa as duas grafias e
-- o par (a) indice unico `(tenant_id, lower(nome))`, que recusa a segunda, e
-- (b) o `lower()` do JOIN do update, que liga "CURSO ..." a categoria "Curso".
--
-- O `lower()` do agrupamento continua aqui porque e ele que torna a escolha da
-- grafia DETERMINISTICA e mais-frequente em vez de depender de qual linha o
-- `on conflict` descartar. Mas a garantia esta nas outras duas, e e nelas que a
-- sabotagem do teste bate — sabotar o agrupamento ficava verde por motivo
-- errado, que foi exatamente o que a primeira versao do teste fez.
--
-- O QUE O BACKFILL NAO TENTA ADIVINHAR: no `sendbox`, `Curso` e `Treinamento`
-- sao comercialmente a mesma coisa e caem separados. Fica separado. Juntar e
-- decisao do cliente, na tela de categorias.
--
-- NAO TOCA EM `pedido_itens.nome_snapshot`. O congelamento e deliberado: pedido
-- antigo segue com o nome de quando foi criado.
-- NAO POVOA `variacoes`. Ela esta vazia nos quatro tenants e segue morta.
--
-- ---------------------------------------------------------------------
-- DOIS CASOS QUE O BACKFILL ENCONTRA E **NAO CONSERTA** — decisao sua
--
--   "29 -  - Polpa de Cupuaçu"  ->  nome fica "- Polpa de Cupuaçu"
--   "32 -  - Polpa de Uva"      ->  nome fica "- Polpa de Uva"
--
-- O prefixo foi digitado com um hifen a mais. O backfill tira SO o prefixo
-- numerico e deixa o resto como esta — inventar a limpeza certa aqui e adivinhar
-- o que o cliente quis. Os dois sku (29 e 32) saem corretos, e a CATEGORIA sai
-- correta (`Polpa`), porque a derivacao pega o primeiro token alfanumerico e
-- ignora pontuacao inicial. Isso nao e "consertar o nome": e nao deixar um hifen
-- solto virar uma categoria chamada "-".
--
--   "34 - Polpa de Morango" e "35 - Polpa de Morango" — nome IGUAL, dois
--   produtos, no `emporio`.
--
-- Ficam os dois, com sku 34 e 35. Nao ha como decidir daqui se e duplicata para
-- apagar ou dois itens que precisam de nomes diferentes. O teste reporta.
--
-- ---------------------------------------------------------------------
-- SEGURANCA
--   - `categorias` nasce com RLS ATIVO e policy no mesmo arquivo (regra 2);
--   - `produto_sku_seq` tem RLS ativo e NENHUMA policy: negacao implicita, e
--     declarada aqui de proposito. Ninguem le nem escreve o contador direto; so
--     a trigger `SECURITY DEFINER` mexe nele;
--   - `revoke` ANTES do grant: objeto novo neste projeto nasce com `arwdDxtm`
--     para `anon` e `authenticated`, entao grant sem revoke e decoracao;
--   - a trigger de sku e `SECURITY DEFINER` porque escreve no contador, que o
--     `authenticated` nao alcanca.
--
-- ROLLBACK: 20260910140000_57_sku_e_categoria_rollback.sql
--   Ele DEVOLVE o prefixo ao nome. Sem isso, reverter deixaria o cliente com o
--   catalogo renomeado e sem o numero em lugar nenhum.
--
-- NOME DO ARQUIVO x LEDGER: aplicada fora do CLI, confira
-- `supabase_migrations.schema_migrations` e renomeie o arquivo para a versao
-- registrada (nota de migracoes do CLAUDE.md).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. categorias
-- ---------------------------------------------------------------------
create table if not exists public.categorias (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  nome          text not null,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint categorias_nome_nao_vazio check (btrim(nome) <> ''),
  constraint categorias_nome_tamanho   check (length(nome) <= 60)
);

-- `tenant_id` PRIMEIRO no indice composto (regra 3 do CLAUDE.md).
-- `lower(nome)`: e o que impede "Queijo" e "QUEIJOS"... nao, impede "Queijo" e
-- "queijo". Grafias diferentes da MESMA palavra viram uma categoria so; plural
-- continua sendo outra, e isso e do cliente resolver na tela.
create unique index if not exists uq_categorias_tenant_nome
  on public.categorias (tenant_id, lower(nome));

-- Alvo da FK composta de `produtos`. Sem este unique o Postgres recusa a FK.
--
-- ADICIONA SO SE FALTAR, em vez de `drop` + `add`: na segunda execucao a
-- `produtos_categoria_fk` ja existe e DEPENDE deste unique, entao o `drop`
-- estoura com `2BP01 ... because other objects depend on it` e a migracao deixa
-- de ser reexecutavel. Pego pelo teste, que aplica duas vezes.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.categorias'::regclass
       and conname  = 'uq_categorias_tenant_id'
  ) then
    alter table public.categorias
      add constraint uq_categorias_tenant_id unique (tenant_id, id);
  end if;
end $$;

drop trigger if exists trg_categorias_upd on public.categorias;
create trigger trg_categorias_upd before update on public.categorias
  for each row execute function public.set_atualizado_em();

alter table public.categorias enable row level security;
drop policy if exists p_categorias_all on public.categorias;
create policy p_categorias_all on public.categorias
  for all
  using      (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())
  with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

revoke all on public.categorias from public;
revoke all on public.categorias from anon;
revoke all on public.categorias from authenticated;
revoke all on public.categorias from service_role;
grant select, insert, update, delete on public.categorias to authenticated;
grant select, insert, update, delete on public.categorias to service_role;

-- ---------------------------------------------------------------------
-- 2. produtos.categoria_id, com FK COMPOSTA (isolamento pelo schema)
-- ---------------------------------------------------------------------
alter table public.produtos
  add column if not exists categoria_id uuid;

alter table public.produtos
  drop constraint if exists produtos_categoria_fk;
alter table public.produtos
  add constraint produtos_categoria_fk
  foreign key (tenant_id, categoria_id)
  references public.categorias (tenant_id, id)
  on update cascade
  on delete restrict;

create index if not exists idx_produtos_tenant_categoria
  on public.produtos (tenant_id, categoria_id)
  where deletado_em is null;

-- ---------------------------------------------------------------------
-- 3. o contador de sku, por tenant
-- ---------------------------------------------------------------------
create table if not exists public.produto_sku_seq (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,
  proximo       integer not null default 1,
  atualizado_em timestamptz not null default now(),
  constraint produto_sku_seq_positivo check (proximo >= 1)
);

-- RLS ATIVO E SEM POLICY = nega tudo, e a negacao esta DECLARADA aqui em vez de
-- ficar implicita (a licao de `podcast_agendamentos` no CLAUDE.md). O contador e
-- interno: quem o move e a trigger `SECURITY DEFINER`, que roda como dono.
alter table public.produto_sku_seq enable row level security;

revoke all on public.produto_sku_seq from public;
revoke all on public.produto_sku_seq from anon;
revoke all on public.produto_sku_seq from authenticated;
revoke all on public.produto_sku_seq from service_role;
grant select on public.produto_sku_seq to service_role;

-- ---------------------------------------------------------------------
-- 4. o indice unico que NAO libera numero ao apagar
-- ---------------------------------------------------------------------
drop index if exists public.uq_produtos_tenant_sku;
create unique index uq_produtos_tenant_sku
  on public.produtos (tenant_id, sku)
  where sku is not null;

-- ---------------------------------------------------------------------
-- 5. a trigger que atribui o sku
-- ---------------------------------------------------------------------
create or replace function public.produtos_atribui_sku()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_proximo integer;
begin
  -- sku vindo preenchido e respeitado: e o caso do legado de texto, e o caso de
  -- uma restauracao que precisa recolocar o numero original.
  if new.sku is not null and btrim(new.sku) <> '' then
    return new;
  end if;

  insert into public.produto_sku_seq (tenant_id, proximo)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do nothing;

  -- `update ... returning` num unico comando: o lock da linha do contador
  -- serializa dois cadastros simultaneos do mesmo tenant, entao nao ha corrida
  -- que devolva o mesmo numero duas vezes.
  update public.produto_sku_seq
     set proximo = proximo + 1,
         atualizado_em = now()
   where tenant_id = new.tenant_id
  returning proximo - 1 into v_proximo;

  new.sku := v_proximo::text;
  return new;
end;
$function$;

drop trigger if exists trg_produtos_sku on public.produtos;
create trigger trg_produtos_sku before insert on public.produtos
  for each row execute function public.produtos_atribui_sku();

-- ---------------------------------------------------------------------
-- 6. BACKFILL — sku
-- ---------------------------------------------------------------------
-- 6-zero. O REGISTRO QUE TORNA O ROLLBACK EXATO.
--
-- O rollback precisa devolver o prefixo ao nome, e depois do backfill nao ha
-- como distinguir "produto que teve o prefixo removido" de "produto que nunca
-- teve prefixo e ganhou sku da sequencia". Os dois terminam com nome sem numero
-- e sku numerico. Reconstruir por heuristica poria prefixo em produto que nunca
-- teve — o cliente veria "27 - Denuncyou Plano Essencial" aparecer do nada.
--
-- Entao a migracao ANOTA o nome de antes, linha a linha, e o rollback consome e
-- dropa a tabela. Ela tambem e o que permite ao teste provar a restauracao um
-- por um, e nao por contagem.
create table if not exists public.backfill_57_nome_original (
  produto_id uuid primary key references public.produtos(id) on delete cascade,
  nome_antes text not null,
  anotado_em timestamptz not null default now()
);

alter table public.backfill_57_nome_original enable row level security;
revoke all on public.backfill_57_nome_original from public;
revoke all on public.backfill_57_nome_original from anon;
revoke all on public.backfill_57_nome_original from authenticated;
revoke all on public.backfill_57_nome_original from service_role;
grant select on public.backfill_57_nome_original to service_role;

insert into public.backfill_57_nome_original (produto_id, nome_antes)
select p.id, p.nome
  from public.produtos p
 where (p.sku is null or btrim(p.sku) = '')
   and p.nome ~ '^[0-9]+[ ]*-[ ]*'
   and btrim(regexp_replace(p.nome, '^[0-9]+[ ]*-[ ]*', '')) <> ''
    on conflict (produto_id) do nothing;

-- 6a. quem tem prefixo numerico adota AQUELE numero e o perde do nome.
--     `regexp_replace` sem a flag `g`: troca so a primeira ocorrencia, entao
--     "29 -  - Polpa de Cupuaçu" fica "- Polpa de Cupuaçu" (o hifen sobrando e
--     deliberadamente preservado — ver o cabecalho).
update public.produtos p
   set sku  = (regexp_match(p.nome, '^([0-9]+)'))[1],
       nome = btrim(regexp_replace(p.nome, '^[0-9]+[ ]*-[ ]*', ''))
 where (p.sku is null or btrim(p.sku) = '')
   and p.nome ~ '^[0-9]+[ ]*-[ ]*'
   and btrim(regexp_replace(p.nome, '^[0-9]+[ ]*-[ ]*', '')) <> '';

-- 6b. o contador comeca DEPOIS do maior numero ja adotado pelo tenant.
--     Conta TODOS os produtos, inclusive deletados: numero de produto apagado
--     nao volta para a fila.
insert into public.produto_sku_seq (tenant_id, proximo)
select p.tenant_id,
       coalesce(max((p.sku)::integer), 0) + 1
  from public.produtos p
 where p.sku ~ '^[0-9]+$'
 group by p.tenant_id
    on conflict (tenant_id) do update
   set proximo = greatest(public.produto_sku_seq.proximo, excluded.proximo),
       atualizado_em = now();

-- 6c. quem ficou sem sku recebe o proximo da sequencia do tenant.
with sem_sku as (
  select p.id, p.tenant_id,
         row_number() over (partition by p.tenant_id order by p.criado_em, p.id) as n
    from public.produtos p
   where p.sku is null or btrim(p.sku) = ''
), base as (
  select t.tenant_id, coalesce(s.proximo, 1) as inicio
    from (select distinct tenant_id from sem_sku) t
    left join public.produto_sku_seq s on s.tenant_id = t.tenant_id
)
update public.produtos p
   set sku = (b.inicio + ss.n - 1)::text
  from sem_sku ss
  join base b on b.tenant_id = ss.tenant_id
 where p.id = ss.id;

-- 6d. o contador avanca alem do que 6c consumiu.
insert into public.produto_sku_seq (tenant_id, proximo)
select p.tenant_id, max((p.sku)::integer) + 1
  from public.produtos p
 where p.sku ~ '^[0-9]+$'
 group by p.tenant_id
    on conflict (tenant_id) do update
   set proximo = greatest(public.produto_sku_seq.proximo, excluded.proximo),
       atualizado_em = now();

-- ---------------------------------------------------------------------
-- 7. BACKFILL — categoria
-- ---------------------------------------------------------------------
-- A grafia que fica e a MAIS FREQUENTE do grupo (desempate: a que aparece
-- primeiro por `criado_em`). `lower()` so na CHAVE de agrupamento — o nome
-- guardado preserva a caixa que o cliente usa.
with palavra as (
  select p.id, p.tenant_id, p.criado_em,
         (regexp_match(p.nome, '[[:alnum:]][[:alnum:]]*'))[1] as token
    from public.produtos p
   where p.deletado_em is null
     and p.categoria_id is null
), valida as (
  select * from palavra where token is not null and btrim(token) <> ''
), contagem as (
  select tenant_id, lower(token) as chave, token,
         count(*) as n,
         min(criado_em) as primeiro
    from valida
   group by 1, 2, 3
), escolhida as (
  select distinct on (tenant_id, chave) tenant_id, chave, token
    from contagem
   order by tenant_id, chave, n desc, primeiro asc
)
insert into public.categorias (tenant_id, nome)
select e.tenant_id, e.token from escolhida e
    on conflict (tenant_id, lower(nome)) do nothing;

update public.produtos p
   set categoria_id = c.id
  from public.categorias c
 where c.tenant_id = p.tenant_id
   and lower(c.nome) = lower((regexp_match(p.nome, '[[:alnum:]][[:alnum:]]*'))[1])
   and p.deletado_em is null
   and p.categoria_id is null;

commit;
