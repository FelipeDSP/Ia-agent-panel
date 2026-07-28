-- 09_api_n8n
--
-- Opcao C da secao 5.4: o n8n nao recebe acesso a tabela nenhuma.
-- Recebe um role dedicado e uma API de funcoes onde o tenant e parametro
-- obrigatorio da assinatura. O filtro de tenant nao pode ser esquecido
-- porque nao existe caminho que nao passe por ele.
--
-- Motivo de nao ser a Opcao A: a service_role key da acesso total, inclusive
-- a auth.users e a todas as tabelas do painel. Credencial de n8n vazada
-- deixaria de ser incidente de um tenant e passaria a ser do banco inteiro.
--
-- Motivo de nao ser a Opcao B: o node PGVector do LangChain abre conexao
-- propria, entao set_config de node anterior nao alcanca a query.
--
-- Rollback: 20260724160000_09_api_n8n_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Role dedicado
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'n8n_agent') then
    create role n8n_agent login nobypassrls;
  end if;
end $$;

comment on role n8n_agent is
  'Agente n8n. Sem privilegio de tabela: so executa as funcoes api_n8n_*. '
  'Senha definida fora da migracao (alter role n8n_agent password ...).';

-- Sem senha aqui de proposito: segredo em migracao vai para o git.
-- Definir manualmente:  alter role n8n_agent password '<segredo>';

-- Explicito, ainda que redundante: o role nasce sem privilegio de tabela e
-- assim deve permanecer. Se algum dia alguem der grant, esta linha documenta
-- que foi contra o desenho.
revoke all on all tables in schema public from n8n_agent;
revoke all on all sequences in schema public from n8n_agent;

grant usage on schema public to n8n_agent;
grant usage on schema extensions to n8n_agent;  -- tipo vector(1536)

-- ---------------------------------------------------------------------------
-- 2. Guarda comum
-- ---------------------------------------------------------------------------

create or replace function public.n8n_assert_tenant(p_tenant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if p_tenant_id is null then
    raise exception 'api_n8n: p_tenant_id e obrigatorio'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.tenants t
    where t.id = p_tenant_id
      and t.ativo
      and t.deletado_em is null
  ) then
    -- Mensagem sem vazar se o id existe mas esta inativo: para quem chama,
    -- tenant desconhecido e tenant suspenso sao a mesma resposta.
    raise exception 'api_n8n: tenant % indisponivel', p_tenant_id
      using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Entrada: webhook do Chatwoot entrega account_id, nao UUID
-- ---------------------------------------------------------------------------

create or replace function public.api_n8n_tenant_por_chatwoot(p_account_id bigint)
returns table (
  tenant_id                uuid,
  slug                     text,
  nome                     text,
  agente_ativo             boolean,
  system_prompt            text,
  modelo                   text,
  temperatura              numeric,
  debounce_segundos        integer,
  msg_midia_nao_suportada  text,
  msg_fora_escopo          text,
  chatwoot_url             text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select t.id, t.slug, t.nome, t.agente_ativo, t.system_prompt, t.modelo,
         t.temperatura, t.debounce_segundos, t.msg_midia_nao_suportada,
         t.msg_fora_escopo, t.chatwoot_url
  from public.tenants t
  where t.chatwoot_account_id = p_account_id
    and t.ativo
    and t.deletado_em is null;
$$;

comment on function public.api_n8n_tenant_por_chatwoot(bigint) is
  'Resolve account_id do Chatwoot -> config do agente. Nao retorna o token: '
  'ver api_n8n_credencial_chatwoot.';

-- Token separado de proposito: o n8n loga a saida dos nodes, e a config do
-- agente e lida a cada mensagem. Token so no node que precisa dele.
create or replace function public.api_n8n_credencial_chatwoot(p_tenant_id uuid)
returns table (chatwoot_url text, chatwoot_token text, chatwoot_account_id bigint)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  return query
  select t.chatwoot_url, t.chatwoot_token, t.chatwoot_account_id
  from public.tenants t
  where t.id = p_tenant_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Busca vetorial — substitui o node PGVector do LangChain
-- ---------------------------------------------------------------------------

create or replace function public.api_n8n_buscar_kb(
  p_tenant_id uuid,
  p_embedding vector(1536),
  p_limite    integer default 5,
  p_filtro    jsonb   default '{}'::jsonb
)
returns table (
  id         uuid,
  text       text,
  metadata   jsonb,
  similarity double precision
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_limite integer := coalesce(p_limite, 5);
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if v_limite < 1 or v_limite > 50 then
    v_limite := 5;
  end if;

  -- O filtro de metadata continua aceito para compatibilidade com o que o
  -- workflow ja passava, mas e aditivo: nao substitui o filtro por coluna.
  -- Mesmo com p_filtro = '{}' nenhum documento de outro tenant e alcancavel.
  return query
  select d.id,
         d.text,
         d.metadata,
         1 - (d.embedding operator(extensions.<=>) p_embedding) as similarity
  from public.kb_documentos d
  where d.tenant_id = p_tenant_id
    and d.deletado_em is null
    and d.metadata @> coalesce(p_filtro, '{}'::jsonb)
  order by d.embedding operator(extensions.<=>) p_embedding
  limit v_limite;
end;
$$;

comment on function public.api_n8n_buscar_kb(uuid, vector, integer, jsonb) is
  'Busca vetorial escopada por tenant. Substitui o node PGVector do LangChain, '
  'que abre conexao propria e nao enxerga set_config de node anterior.';

-- ---------------------------------------------------------------------------
-- 5. Conversas
-- ---------------------------------------------------------------------------

-- Chamada no inicio de cada mensagem: registra a conversa se for nova e
-- devolve o estado, que e o que decide se o agente responde.
create or replace function public.api_n8n_conversa_sync(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_contact_name    text default null,
  p_phone           text default null
)
returns table (status text, pausado_em timestamptz)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_conversation_id is null then
    raise exception 'api_n8n: p_conversation_id e obrigatorio'
      using errcode = '22023';
  end if;

  return query
  insert into public.conversas as c
    (tenant_id, conversation_id, contact_name, phone)
  values
    (p_tenant_id, p_conversation_id, p_contact_name, p_phone)
  on conflict (tenant_id, conversation_id) do update
    set contact_name   = coalesce(excluded.contact_name, c.contact_name),
        phone          = coalesce(excluded.phone, c.phone),
        atualizado_em  = now()
  returning c.status, c.pausado_em;
end;
$$;

create or replace function public.api_n8n_definir_status_conversa(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_status          text
)
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_status text;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_status not in ('ativo', 'pausado', 'resolvido') then
    raise exception 'api_n8n: status invalido: %', p_status
      using errcode = '22023';
  end if;

  update public.conversas
     set status        = p_status,
         pausado_em    = case when p_status = 'pausado' then now() else null end,
         atualizado_em = now()
   where tenant_id      = p_tenant_id
     and conversation_id = p_conversation_id
  returning status into v_status;

  if v_status is null then
    raise exception 'api_n8n: conversa % nao encontrada no tenant', p_conversation_id
      using errcode = '02000';
  end if;

  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Log de mensagens (auditoria e billing)
-- ---------------------------------------------------------------------------

create or replace function public.api_n8n_registrar_mensagem(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_direcao         text,
  p_conteudo        text default null,
  p_tokens_entrada  integer default null,
  p_tokens_saida    integer default null,
  p_modelo          text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_direcao not in ('entrada', 'saida') then
    raise exception 'api_n8n: direcao invalida: %', p_direcao
      using errcode = '22023';
  end if;

  insert into public.mensagens_log
    (tenant_id, conversation_id, direcao, conteudo,
     tokens_entrada, tokens_saida, modelo)
  values
    (p_tenant_id, p_conversation_id, p_direcao, p_conteudo,
     p_tokens_entrada, p_tokens_saida, p_modelo)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Tools habilitadas
-- ---------------------------------------------------------------------------

create or replace function public.api_n8n_tools_ativas(p_tenant_id uuid)
returns table (tool_nome text, workflow_id text, descricao text, config jsonb)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  return query
  select t.tool_nome, t.workflow_id, t.descricao, t.config
  from public.tenant_tools t
  where t.tenant_id = p_tenant_id
    and t.ativo;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Permissoes
--
-- Por padrao o Postgres da EXECUTE a PUBLIC em toda funcao nova. Sem o revoke
-- abaixo, anon (usuario deslogado do PostgREST) chamaria api_n8n_buscar_kb
-- passando qualquer tenant_id — as funcoes sao SECURITY DEFINER e ignoram RLS.
-- O revoke e o que segura a Opcao C de pe.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'api\_n8n\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon, authenticated', f.sig);
    execute format('grant execute on function %s to n8n_agent', f.sig);
  end loop;
end $$;

-- A guarda e interna: nem o n8n precisa chamar direto.
revoke all on function public.n8n_assert_tenant(uuid) from public;
revoke all on function public.n8n_assert_tenant(uuid) from anon, authenticated;
