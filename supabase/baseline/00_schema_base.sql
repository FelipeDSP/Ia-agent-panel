-- 00_schema_base — reconstrucao das migracoes 01 a 08
--
-- POR QUE ESTE ARQUIVO EXISTE
--
-- O banco de producao registra em supabase_migrations.schema_migrations oito
-- migracoes (01_extensions_e_helpers ... 08_hardening_permissoes) cujos arquivos
-- nunca foram versionados neste repositorio. Sem elas, `supabase db push` num
-- projeto novo cria um schema pela metade: as migracoes 09+ que estao em
-- supabase/migrations/ fazem ALTER e CREATE OR REPLACE sobre tabelas e funcoes
-- que ninguem criou. Na pratica, ate agora nao havia como levantar um ambiente
-- de staging — e o teste de isolamento roda contra producao por falta de opcao.
--
-- Este arquivo fecha esse buraco. Foi extraido do catalogo do proprio banco
-- (pg_attribute, pg_constraint, pg_indexes, pg_policies, pg_get_functiondef,
-- pg_get_triggerdef) em 2026-08-05, nao transcrito de memoria.
--
-- POR QUE FICA FORA DE supabase/migrations/
--
-- As oito versoes ja constam no ledger de producao. Um arquivo em migrations/
-- com versao nova faria o `db push` tentar recria-las no banco que ja as tem.
-- Aqui ele e um bootstrap explicito: roda a mao, uma vez, em banco novo.
--
-- COMO USAR (projeto novo / branch do Supabase / staging)
--
--   psql "$SUPABASE_DB_URL" -f supabase/baseline/00_schema_base.sql
--   supabase db push        # aplica 09 em diante
--
-- Em producao NAO se roda: o schema ja existe. Ainda assim tudo aqui e
-- idempotente (if not exists / or replace / drop policy if exists), entao uma
-- execucao acidental nao destroi dado — mas nao conte com isso, confira antes.
--
-- ESTADO DOS CORPOS DE FUNCAO
--
-- As funcoes abaixo estao no estado ATUAL, nao no estado original de 01-08.
-- Isso e deliberado: auth_tenant_id, handle_novo_usuario e match_kb_documentos
-- foram corrigidas pelas migracoes 10, 12 e 17, e as versoes originais tinham
-- falhas conhecidas — auth_tenant_id aceitava app.tenant_id como segunda origem
-- de autorizacao, match_kb_documentos devolvia vazio em silencio para tenant
-- nulo. Recriar aquilo aqui seria reintroduzir o bug por alguns segundos, ate a
-- 10 rodar. Como 10/12/17 fazem CREATE OR REPLACE com corpo equivalente ou mais
-- novo, a ordem baseline -> 09..17 chega no mesmo lugar de qualquer forma.
--
-- A unica excecao e p_log_all (policy de mensagens_log), incluida no estado
-- ORIGINAL porque a migracao 15 a DERRUBA por nome. Sem ela aqui, a 15 falharia
-- em drop de policy inexistente — e o `drop policy if exists` da 15 mascararia
-- a diferenca sem que ninguem percebesse.

-- ---------------------------------------------------------------------------
-- 1. Extensoes (01_extensions_e_helpers)
-- ---------------------------------------------------------------------------
--
-- Todas no schema `extensions`, nao em `public`. E a convencao do Supabase e o
-- motivo de as funcoes que tocam vetor carregarem `set search_path = public,
-- extensions` — sem isso o operador <=> nao resolve.

create schema if not exists extensions;

create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto   with schema extensions;
create extension if not exists vector     with schema extensions;

-- ---------------------------------------------------------------------------
-- 2. Helpers de autorizacao
-- ---------------------------------------------------------------------------
--
-- Estas tres funcoes sao lidas por TODA policy do schema. Sao o ponto onde o
-- multi-tenancy inteiro se apoia: se auth_tenant_id() passar a aceitar uma
-- segunda origem de tenant, toda policy do banco herda o bypass de uma vez.

create or replace function public.jwt_claims()
returns jsonb
language sql
stable
set search_path = public
as $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

comment on function public.jwt_claims() is
  'Claims do JWT como jsonb, ou objeto vazio. Nunca lanca erro de parse.';

-- Corpo pos-migracao 10: so o app_metadata do JWT. Ver o cabecalho deste arquivo.
create or replace function public.auth_tenant_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(public.jwt_claims() -> 'app_metadata' ->> 'tenant_id', '')::uuid;
$$;

comment on function public.auth_tenant_id() is
  'Tenant do usuario logado, exclusivamente do app_metadata do JWT. '
  'app.tenant_id removido em 10: o n8n usa as funcoes api_n8n_*.';

-- user_metadata seria o campo errado: o proprio usuario pode edita-lo pelo
-- endpoint de update do GoTrue. app_metadata so muda pela Admin API.
create or replace function public.auth_is_super_admin()
returns boolean
language sql
stable
set search_path = public
as $$
  SELECT COALESCE(public.jwt_claims() -> 'app_metadata' ->> 'papel', '') = 'super_admin';
$$;

comment on function public.auth_is_super_admin() is
  'TRUE quando o JWT indica papel super_admin. Sempre FALSE para o n8n.';

create or replace function public.set_atualizado_em()
returns trigger
language plpgsql
set search_path = public
as $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. tenants (02_tabela_tenants)
-- ---------------------------------------------------------------------------
--
-- UUID e nao BIGINT: id sequencial deixaria enumerar clientes incrementando o
-- numero na URL. Soft delete via deletado_em — o n8n le o mesmo banco e a
-- exclusao precisa ser reversivel.

create table if not exists public.tenants (
  id                      uuid primary key default gen_random_uuid(),
  slug                    text not null unique,
  nome                    text not null,
  ativo                   boolean not null default true,
  chatwoot_account_id     bigint unique,
  chatwoot_url            text not null default 'https://app.chatyou.chat',
  chatwoot_token          text,
  agente_ativo            boolean not null default true,
  system_prompt           text not null default '',
  modelo                  text not null default 'gpt-4.1-mini',
  temperatura             numeric(3,2) not null default 0.30,
  debounce_segundos       integer not null default 8,
  msg_midia_nao_suportada text not null default 'Olá! Ainda não consigo ouvir áudios ou identificar mídias. Por favor, escreva sua dúvida em texto que te respondo na hora! 😊',
  msg_fora_escopo         text not null default 'Só posso te ajudar com dúvidas sobre este atendimento. 😊',
  deletado_em             timestamptz,
  criado_em               timestamptz not null default now(),
  atualizado_em           timestamptz not null default now(),
  constraint tenants_temperatura_check
    check (temperatura >= 0 and temperatura <= 2),
  constraint tenants_debounce_segundos_check
    check (debounce_segundos >= 1 and debounce_segundos <= 60)
);

comment on table public.tenants is 'Uma linha por empresa cliente.';

-- Parcial: o indice de busca por slug so precisa dos vivos. NAO substitui a
-- constraint UNIQUE (slug), que e global e portanto mantem o slug de um tenant
-- excluido reservado para sempre — ver AUDIT/ANALISE, item do slug.
create index if not exists idx_tenants_slug
  on public.tenants (slug) where deletado_em is null;

-- Entrada do webhook do Chatwoot: resolve account_id -> tenant a cada mensagem.
create index if not exists idx_tenants_chatwoot
  on public.tenants (chatwoot_account_id) where chatwoot_account_id is not null;

-- ---------------------------------------------------------------------------
-- 4. usuarios_painel (03_usuarios_painel)
-- ---------------------------------------------------------------------------
--
-- Projecao de auth.users, nao fonte da verdade. Quem autoriza e o app_metadata
-- do JWT, que e o que as policies leem. Se os dois divergirem, vale o JWT.

create table if not exists public.usuarios_painel (
  id            uuid primary key references auth.users(id) on delete cascade,
  tenant_id     uuid references public.tenants(id) on delete cascade,
  papel         text not null check (papel in ('super_admin', 'tenant_admin')),
  nome          text,
  email         text,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  -- super_admin nao pertence a tenant nenhum; tenant_admin sempre pertence a um.
  -- Sem esta CHECK, um tenant_admin sem tenant vira usuario que nao ve nada e
  -- ninguem entende por que.
  constraint chk_papel_tenant check (
    (papel = 'super_admin'  and tenant_id is null) or
    (papel = 'tenant_admin' and tenant_id is not null)
  )
);

create index if not exists idx_usuarios_tenant
  on public.usuarios_painel (tenant_id, ativo);

-- ---------------------------------------------------------------------------
-- 5. kb_documentos (04_base_conhecimento)
-- ---------------------------------------------------------------------------
--
-- Um chunk por linha; "documento" e o conjunto de chunks que compartilham
-- `origem`. Nao ha tabela de documento.
--
-- metadata carrega tenant_id de propósito redundante com a coluna: o node
-- PGVector do n8n filtra por metadata, nao por coluna. kb_reindex_documento
-- (migracao 14) e a autoridade que mantem as duas copias em sincronia.

create table if not exists public.kb_documentos (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  text        text not null,
  embedding   extensions.vector(1536) not null,
  metadata    jsonb not null default '{}'::jsonb,
  origem      text,
  chunk_index integer,
  deletado_em timestamptz,
  criado_em   timestamptz not null default now()
);

-- 1536 fixo: e a dimensao do text-embedding-3-small. Trocar de modelo invalida
-- todo vetor gravado — nao e uma alteracao de coluna, e uma reindexacao.

-- tenant_id primeiro em todo indice composto (regra 3 do CLAUDE.md).
create index if not exists idx_kb_tenant
  on public.kb_documentos (tenant_id, criado_em desc) where deletado_em is null;

-- Cobre o swap de reprocessamento (delete por tenant+origem) e a listagem de
-- documentos. E o indice que o planner escolhe hoje na busca vetorial.
create index if not exists idx_kb_origem
  on public.kb_documentos (tenant_id, origem) where deletado_em is null;

create index if not exists idx_kb_metadata
  on public.kb_documentos using gin (metadata jsonb_path_ops);

-- ATENCAO — este indice HNSW e global, sem tenant_id, e por isso o planner NAO
-- o usa quando a query filtra por tenant (que e sempre). Ver a secao "Busca
-- vetorial" do CLAUDE.md antes de mexer: forcar o uso dele com
-- hnsw.iterative_scan = off faz a busca devolver MENOS resultados em silencio.
create index if not exists idx_kb_embedding
  on public.kb_documentos using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 6. conversas, tenant_tools, mensagens_log (05_conversas_tools_logs)
-- ---------------------------------------------------------------------------

-- conversation_id e o id do Chatwoot: unico por conta, nao globalmente. Por isso
-- a UNIQUE e (tenant_id, conversation_id) e nao so conversation_id.
create table if not exists public.conversas (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  conversation_id bigint not null,
  contact_name    text,
  phone           text,
  status          text not null default 'ativo'
                    check (status in ('ativo', 'pausado', 'resolvido')),
  pausado_em      timestamptz,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  unique (tenant_id, conversation_id)
);

create index if not exists idx_conversas_atividade
  on public.conversas (tenant_id, atualizado_em desc);
create index if not exists idx_conversas_status
  on public.conversas (tenant_id, status);

-- Uma linha por tool habilitada para o cliente. `config` jsonb tem forma livre
-- por tool — a de transferir_humano esta documentada em
-- src/lib/tools/transferir-humano.ts e e lida pelo workflow do n8n.
create table if not exists public.tenant_tools (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  tool_nome   text not null,
  ativo       boolean not null default true,
  workflow_id text,
  descricao   text,
  config      jsonb not null default '{}'::jsonb,
  criado_em   timestamptz not null default now(),
  unique (tenant_id, tool_nome)
);

create index if not exists idx_tools_tenant
  on public.tenant_tools (tenant_id, ativo);

-- Log de auditoria e base do billing. Tem tokens_entrada/tokens_saida, que sao
-- custo da agencia — a migracao 15 fecha esta tabela para o tenant justamente
-- por isso, e serve o historico por conversa_historico(), que nao devolve token.
create table if not exists public.mensagens_log (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  conversation_id bigint,
  direcao         text not null check (direcao in ('entrada', 'saida')),
  conteudo        text,
  tokens_entrada  integer,
  tokens_saida    integer,
  modelo          text,
  criado_em       timestamptz not null default now()
);

create index if not exists idx_log_tenant_data
  on public.mensagens_log (tenant_id, criado_em desc);

-- ---------------------------------------------------------------------------
-- 7. jobs_ingestao e prompt_versoes
-- ---------------------------------------------------------------------------
--
-- jobs_ingestao veio junto com a ingestao assincrona; prompt_versoes com o
-- versionamento de prompt. As duas ja existiam quando 13 e 14 rodaram.

create table if not exists public.jobs_ingestao (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  arquivo_nome  text not null,
  -- Convencao de path: {tenant_id}/{uuid}.{ext}. A Edge Function VALIDA esse
  -- prefixo antes de baixar — ela usa service_role, que ignora o RLS de Storage.
  arquivo_path  text,
  tipo          text not null default 'arquivo' check (tipo in ('arquivo', 'texto')),
  status        text not null default 'pendente'
                  check (status in ('pendente', 'processando', 'concluido', 'erro')),
  chunks_total  integer not null default 0,
  chunks_ok     integer not null default 0,
  erro_msg      text,
  criado_por    uuid references public.usuarios_painel(id) on delete set null,
  criado_em     timestamptz not null default now(),
  concluido_em  timestamptz
);

create index if not exists idx_jobs_tenant
  on public.jobs_ingestao (tenant_id, criado_em desc);
-- Sem tenant_id: e a varredura operacional por jobs em andamento, que atravessa
-- tenants de propósito. Parcial, entao so indexa o punhado que importa.
create index if not exists idx_jobs_pendentes
  on public.jobs_ingestao (status) where status in ('pendente', 'processando');

-- Guarda o prompt ANTERIOR a cada troca; o vigente vive em tenants.system_prompt.
-- Escrito pelo trigger da migracao 13, nunca pela aplicacao.
create table if not exists public.prompt_versoes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  conteudo   text not null,
  criado_por uuid references public.usuarios_painel(id) on delete set null,
  criado_em  timestamptz not null default now()
);

create index if not exists idx_prompt_versoes
  on public.prompt_versoes (tenant_id, criado_em desc);

-- ---------------------------------------------------------------------------
-- 8. RLS (08_hardening_permissoes)
-- ---------------------------------------------------------------------------
--
-- Toda tabela com tenant_id tem RLS ligado E policy. Tabela nova sem policy nao
-- vaza (RLS ligado sem policy nega tudo), mas tabela nova SEM RLS vaza inteira.
--
-- Nota sobre grants: anon e authenticated recebem DELETE/INSERT/SELECT/UPDATE em
-- todas estas tabelas — e o grant padrao do Supabase e nao foi revogado. Quem
-- protege e o RLS, nao o grant: anon nao tem claim nenhum, entao auth_tenant_id()
-- e NULL e auth_is_super_admin() e FALSE, e nenhuma policy casa.

alter table public.tenants          enable row level security;
alter table public.usuarios_painel  enable row level security;
alter table public.kb_documentos    enable row level security;
alter table public.conversas        enable row level security;
alter table public.tenant_tools     enable row level security;
alter table public.mensagens_log    enable row level security;
alter table public.jobs_ingestao    enable row level security;
alter table public.prompt_versoes   enable row level security;

-- tenants: policies separadas por comando. INSERT e DELETE so para super_admin;
-- SELECT/UPDATE tambem para o dono da linha. O que impede o tenant_admin de
-- editar modelo/temperatura/slug pela policy de UPDATE (que enxerga a linha
-- inteira) e o trigger da migracao 13, nao o RLS.
drop policy if exists p_tenants_select on public.tenants;
create policy p_tenants_select on public.tenants
  for select using (public.auth_is_super_admin() or id = public.auth_tenant_id());

drop policy if exists p_tenants_insert on public.tenants;
create policy p_tenants_insert on public.tenants
  for insert with check (public.auth_is_super_admin());

drop policy if exists p_tenants_update on public.tenants;
create policy p_tenants_update on public.tenants
  for update using (public.auth_is_super_admin() or id = public.auth_tenant_id())
         with check (public.auth_is_super_admin() or id = public.auth_tenant_id());

drop policy if exists p_tenants_delete on public.tenants;
create policy p_tenants_delete on public.tenants
  for delete using (public.auth_is_super_admin());

-- usuarios_painel: o proprio usuario se enxerga, o super admin enxerga todos, e
-- o tenant_admin enxerga os colegas do mesmo cliente. Editar so a si mesmo (ou
-- super admin) — senao um admin trocaria o papel do outro.
drop policy if exists p_usuarios_select on public.usuarios_painel;
create policy p_usuarios_select on public.usuarios_painel
  for select using (
    id = auth.uid()
    or public.auth_is_super_admin()
    or tenant_id = public.auth_tenant_id()
  );

drop policy if exists p_usuarios_insert on public.usuarios_painel;
create policy p_usuarios_insert on public.usuarios_painel
  for insert with check (public.auth_is_super_admin());

drop policy if exists p_usuarios_update on public.usuarios_painel;
create policy p_usuarios_update on public.usuarios_painel
  for update using (public.auth_is_super_admin() or id = auth.uid())
         with check (public.auth_is_super_admin() or id = auth.uid());

drop policy if exists p_usuarios_delete on public.usuarios_painel;
create policy p_usuarios_delete on public.usuarios_painel
  for delete using (public.auth_is_super_admin());

-- Dados escopados por tenant: uma policy FOR ALL por tabela. Cobre leitura e
-- escrita com a mesma expressao, entao nao ha como um comando ficar de fora.
drop policy if exists p_kb_all on public.kb_documentos;
create policy p_kb_all on public.kb_documentos
  for all using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())
      with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

drop policy if exists p_conversas_all on public.conversas;
create policy p_conversas_all on public.conversas
  for all using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())
      with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

drop policy if exists p_tools_all on public.tenant_tools;
create policy p_tools_all on public.tenant_tools
  for all using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())
      with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

drop policy if exists p_jobs_all on public.jobs_ingestao;
create policy p_jobs_all on public.jobs_ingestao
  for all using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())
      with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

drop policy if exists p_prompt_versoes_all on public.prompt_versoes;
create policy p_prompt_versoes_all on public.prompt_versoes
  for all using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())
      with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

-- mensagens_log: estado ORIGINAL, de propósito. A migracao 15 derruba esta
-- policy pelo nome e a substitui por p_log_super, porque RLS restringe linha e
-- nao coluna — com acesso de linha o tenant lia os proprios tokens, que sao a
-- base de custo da agencia. Nao remova daqui: 15 precisa ter o que derrubar.
drop policy if exists p_log_all on public.mensagens_log;
create policy p_log_all on public.mensagens_log
  for all using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())
      with check (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

-- ---------------------------------------------------------------------------
-- 9. Busca vetorial e sync de auth (06_busca_vetorial_e_sync_auth)
-- ---------------------------------------------------------------------------
--
-- Corpos no estado atual (pos-10/12/17). Ver o cabecalho deste arquivo.

create or replace function public.match_kb_documentos(
  query_embedding vector,
  match_count     integer default 5,
  filter          jsonb   default '{}'::jsonb
)
returns table (
  id         uuid,
  text       text,
  metadata   jsonb,
  similarity double precision
)
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  v_tenant uuid := public.auth_tenant_id();
  v_limite integer := least(greatest(coalesce(match_count, 5), 1), 50);
begin
  if v_tenant is null then
    raise exception
      'match_kb_documentos: sem tenant no JWT. Super admin deve consultar a KB '
      'de um tenant especifico; o n8n usa api_n8n_buscar_kb(p_tenant_id, ...).'
      using errcode = '22023';
  end if;

  return query
  select d.id,
         d.text,
         d.metadata,
         1 - (d.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.kb_documentos d
  where d.tenant_id = v_tenant
    and d.deletado_em is null
    and d.metadata @> coalesce(filter, '{}'::jsonb)
  order by d.embedding operator(extensions.<=>) query_embedding
  limit v_limite;
end;
$$;

create or replace function public.handle_novo_usuario()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_papel     TEXT;
    v_tenant_id UUID;
BEGIN
    v_papel     := NEW.raw_app_meta_data ->> 'papel';
    v_tenant_id := NULLIF(NEW.raw_app_meta_data ->> 'tenant_id', '')::uuid;

    -- Sem papel: e o INSERT do GoTrue, que ainda vai gravar o app_metadata no
    -- UPDATE seguinte, na mesma transacao. Deixa passar.
    IF v_papel IS NULL THEN
        RETURN NEW;
    END IF;

    IF v_papel NOT IN ('super_admin', 'tenant_admin') THEN
        RAISE EXCEPTION 'papel invalido no app_metadata: %', v_papel;
    END IF;

    IF v_papel = 'tenant_admin' AND v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'tenant_admin exige tenant_id no app_metadata';
    END IF;

    IF v_papel = 'super_admin' THEN
        v_tenant_id := NULL;
    END IF;

    INSERT INTO public.usuarios_painel (id, tenant_id, papel, nome, email)
    VALUES (
        NEW.id,
        v_tenant_id,
        v_papel,
        COALESCE(NEW.raw_user_meta_data ->> 'nome', NEW.email),
        NEW.email
    )
    ON CONFLICT (id) DO UPDATE SET
        tenant_id     = EXCLUDED.tenant_id,
        papel         = EXCLUDED.papel,
        nome          = EXCLUDED.nome,
        email         = EXCLUDED.email,
        atualizado_em = now();

    RETURN NEW;
END;
$$;

comment on function public.handle_novo_usuario() is
  'Espelha app_metadata (papel, tenant_id) de auth.users em usuarios_painel. '
  'Roda no INSERT e no UPDATE de raw_app_meta_data porque o GoTrue grava o '
  'metadata depois de inserir a linha.';

-- ---------------------------------------------------------------------------
-- 10. Triggers
-- ---------------------------------------------------------------------------
--
-- O trigger de UPDATE (trg_usuario_app_metadata) e criado pela migracao 12, nao
-- aqui: e ele que conserta a criacao de usuario pelo GoTrue.

drop trigger if exists trg_tenants_upd on public.tenants;
create trigger trg_tenants_upd
  before update on public.tenants
  for each row execute function public.set_atualizado_em();

drop trigger if exists trg_conversas_upd on public.conversas;
create trigger trg_conversas_upd
  before update on public.conversas
  for each row execute function public.set_atualizado_em();

drop trigger if exists trg_usuarios_upd on public.usuarios_painel;
create trigger trg_usuarios_upd
  before update on public.usuarios_painel
  for each row execute function public.set_atualizado_em();

drop trigger if exists trg_novo_usuario on auth.users;
create trigger trg_novo_usuario
  after insert on auth.users
  for each row execute function public.handle_novo_usuario();
