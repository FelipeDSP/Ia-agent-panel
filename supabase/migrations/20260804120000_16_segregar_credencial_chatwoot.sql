-- 16_segregar_credencial_chatwoot
--
-- Move `tenants.chatwoot_token` para tabela propria SEM policy de tenant.
--
-- MOTIVO (vulnerabilidade confirmada): RLS filtra por LINHA, nao por COLUNA. O
-- tenant_admin le a propria linha de `tenants` (nome, modelo, system_prompt,
-- etc.) via PostgREST com a publishable key + JWT — entao alcancava tambem
-- `chatwoot_token` na mesma linha, uma credencial da agencia. Verificado: um
-- GET /rest/v1/tenants?select=chatwoot_token retornava o token em plaintext.
-- Mesmo padrao (e mesma correcao) do vazamento de coluna de `mensagens_log`
-- resolvido na migracao 15.
--
-- `chatwoot_url` e `chatwoot_account_id` NAO sao credenciais e permanecem em
-- `tenants` (o tenant pode ve-los sem risco; account_id inclusive e UNIQUE la).
--
-- IMPACTO NO n8n (CLAUDE.md: verificar antes): o workflow le o token pela
-- funcao `api_n8n_credencial_chatwoot` (SECURITY DEFINER), nunca por select
-- direto em `tenants` (confirmado no export do workflow: zero `from tenants`,
-- 3 chamadas a essa funcao). Atualizamos a funcao para ler da tabela nova — o
-- workflow do n8n NAO precisa mudar.
--
-- ORDEM SEGURA: cria tabela -> copia tokens -> atualiza a funcao do n8n ->
-- SO ENTAO dropa a coluna. Aplique em branch do Supabase e rode o teste de
-- isolamento antes de producao. O deploy do codigo do painel (que passa a
-- ler/gravar o token na tabela nova) precisa ir JUNTO com esta migracao —
-- codigo antigo lendo `tenants.chatwoot_token` quebra apos o drop.
--
-- Rollback: 20260804120000_16_segregar_credencial_chatwoot_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Tabela de credenciais, sem policy de tenant
-- ---------------------------------------------------------------------------

create table if not exists public.tenant_credenciais (
  tenant_id      uuid primary key references public.tenants(id) on delete cascade,
  chatwoot_token text,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

comment on table public.tenant_credenciais is
  'Credenciais sensiveis por tenant (chatwoot_token). Segregado de tenants '
  'porque RLS nao restringe COLUNA e o tenant_admin le a propria linha de '
  'tenants. Sem policy de tenant: so super_admin le/escreve direto; o n8n le '
  'via api_n8n_credencial_chatwoot (SECURITY DEFINER, bypassa RLS).';

alter table public.tenant_credenciais enable row level security;

-- Unica policy: super_admin. Sem policy para tenant_admin => nao le nada
-- (fail-closed). O n8n nao precisa de policy: a funcao definer bypassa RLS.
create policy p_cred_super on public.tenant_credenciais
  for all to authenticated
  using (public.auth_is_super_admin())
  with check (public.auth_is_super_admin());

-- ---------------------------------------------------------------------------
-- 2. Copia os tokens existentes (preserva Acqua e demais em producao)
-- ---------------------------------------------------------------------------

insert into public.tenant_credenciais (tenant_id, chatwoot_token)
select id, chatwoot_token
from public.tenants
where chatwoot_token is not null
on conflict (tenant_id) do update set chatwoot_token = excluded.chatwoot_token;

-- ---------------------------------------------------------------------------
-- 3. Funcao do n8n passa a ler o token da tabela nova (workflow inalterado)
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE preserva os grants existentes (execute para n8n_agent).

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
  select t.chatwoot_url, c.chatwoot_token, t.chatwoot_account_id
  from public.tenants t
  left join public.tenant_credenciais c on c.tenant_id = t.id
  where t.id = p_tenant_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Fecha a exposicao: remove a coluna de tenants
-- ---------------------------------------------------------------------------
-- Seguro porque: (a) a funcao do n8n ja nao le mais daqui; (b) o guard de
-- coluna (mig 13) usa diff de jsonb, nao referencia a coluna por nome;
-- (c) api_n8n_tenant_por_chatwoot nunca retornou o token.

alter table public.tenants drop column if exists chatwoot_token;
