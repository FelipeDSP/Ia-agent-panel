-- 21a_credencial_chatwoot_expand  (fase EXPAND)
--
-- Sucessora da migracao 16, que nunca foi aplicada. Renumerada porque 17, 18, 19
-- e 20 ja entraram em producao depois que a 16 foi escrita (04/08); aplicar um
-- arquivo com prefixo 16 e timestamp de 04/08 ficaria fora de ordem no ledger.
-- Dividida em duas fases — 21a (expand) e 21b (contract) — pelo motivo explicado
-- em "POR QUE DUAS FASES" abaixo.
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
-- ---------------------------------------------------------------------------
-- IMPACTO NO n8n (CLAUDE.md: verificar antes)
-- ---------------------------------------------------------------------------
-- O n8n nunca faz select direto em `tenants` — le sempre por funcao SECURITY
-- DEFINER. Mas sao DUAS funcoes, nao uma, e ambas liam a coluna:
--
--   api_n8n_credencial_chatwoot  -> 3 nos do workflow principal
--                                   (Credencial midia / bloqueio / resposta)
--   api_n8n_config_tool          -> sub-workflows de tool, no "Busca Config":
--                                   Tool - Resolver Conversa      ('resolver_conversa')
--                                   Tool - Transferir para Humano ('transferir_humano')
--
-- A versao original da migracao 16 atualizava so a primeira e afirmava que o n8n
-- nao precisava mudar. A afirmacao vinha de uma varredura feita so no export do
-- workflow principal; os sub-workflows de tool ficaram de fora. Na epoca
-- `api_n8n_config_tool` sequer estava versionada no repo — o arquivo da migracao
-- 11 so foi reconstruido em 05/08 —, entao a dependencia nao aparecia em nenhuma
-- busca por arquivo.
--
-- POR QUE O DROP NAO ACUSA ISSO (fase 21b). Corpo de funcao plpgsql e texto
-- opaco para o rastreador de dependencias do Postgres: nada em pg_depend liga a
-- funcao a coluna que ela referencia. O `alter table ... drop column` roda sem
-- erro nem warning, a migracao fecha verde, e a funcao so estoura na primeira
-- chamada em runtime, com `column t.chatwoot_token does not exist`. O sintoma
-- seria: migracao aplicada com sucesso e, mais tarde, as duas tools de todos os
-- clientes (Acqua inclusive) falhando em silencio no n8n.
--
-- Varredura feita em 2026-08-11 contra producao com pg_get_functiondef() sobre
-- todas as 28 funcoes de schema nao-sistema, mais pg_views, pg_policies,
-- pg_indexes e information_schema.columns: exatamente estas duas funcoes e a
-- coluna de `tenants` mencionam chatwoot_token. Nenhuma view, policy, indice ou
-- trigger depende dela.
--
-- ---------------------------------------------------------------------------
-- POR QUE DUAS FASES
-- ---------------------------------------------------------------------------
-- Se criar a tabela e dropar a coluna na mesma migracao, existe um intervalo
-- entre aplicar a migracao e o deploy do painel em que o codigo antigo em
-- producao le uma coluna que ja nao existe. Nao da para eliminar esse intervalo
-- escolhendo horario — so encolhe-lo.
--
-- Separando, ele deixa de existir:
--
--   21a (aqui)  cria a tabela, copia os tokens, aponta AS DUAS funcoes para ela,
--               e MANTEM a coluna. Painel antigo continua lendo a coluna;
--               painel novo le a tabela; n8n le a tabela pelas funcoes. As tres
--               coisas funcionam ao mesmo tempo.
--   deploy      painel novo vai para a Vercel.
--   21b         confere divergencia e dropa a coluna. Sem pressa, sem janela.
--
-- ATENCAO no intervalo entre 21a e o deploy: o painel ANTIGO grava token em
-- `tenants.chatwoot_token`, que as funcoes ja nao leem. Se alguem usar "Conectar
-- Chatwoot" nesse intervalo, o n8n passa a usar um token velho. E acao so de
-- super_admin — basta nao fazer. A 21b detecta e bloqueia se acontecer.
--
-- Esta fase NAO destroi nada: nenhuma coluna cai, nenhum dado e apagado.
--
-- Rollback: 20260811133839_21a_credencial_chatwoot_expand_rollback.sql

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
  'via api_n8n_credencial_chatwoot e api_n8n_config_tool (SECURITY DEFINER, '
  'bypassam RLS).';

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
-- 3a. api_n8n_credencial_chatwoot passa a ler o token da tabela nova
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
-- 3b. api_n8n_config_tool idem — mesma dependencia, mesma correcao
-- ---------------------------------------------------------------------------
-- Corpo identico ao da migracao 11, com uma unica diferenca: o token vem de
-- tenant_credenciais em vez de tenants. Preservado byte a byte no resto —
-- assinatura (uuid, text), nomes/tipos/ORDEM das colunas de retorno
-- (chatwoot_url, chatwoot_token, tool_ativa, config), volatilidade STABLE e
-- `set search_path = public` (sem `extensions`, como estava). O n8n consome por
-- NOME de coluna (`SELECT chatwoot_url, chatwoot_token, tool_ativa, config FROM
-- ...` e depois `$json.tool_ativa`), entao renomear qualquer uma delas quebraria
-- os sub-workflows tao silenciosamente quanto o drop quebraria a funcao.
--
-- LEFT JOIN em tenant_credenciais pela mesma razao que o LEFT JOIN em
-- tenant_tools existe desde a 11: tenant sem credencial devolve linha com token
-- nulo, nao zero linhas. Zero linhas obrigaria o sub-workflow a distinguir
-- "sem credencial" de "tenant inexistente", ramificacao que o n8n erra calado.

create or replace function public.api_n8n_config_tool(
  p_tenant_id uuid,
  p_tool_nome text
)
returns table (
  chatwoot_url   text,
  chatwoot_token text,
  tool_ativa     boolean,
  config         jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
BEGIN
  PERFORM public.n8n_assert_tenant(p_tenant_id);

  RETURN QUERY
  SELECT t.chatwoot_url,
         c.chatwoot_token,
         COALESCE(tt.ativo, FALSE),
         COALESCE(tt.config, '{}'::jsonb)
  FROM public.tenants t
  LEFT JOIN public.tenant_credenciais c
         ON c.tenant_id = t.id
  LEFT JOIN public.tenant_tools tt
         ON tt.tenant_id = t.id AND tt.tool_nome = p_tool_nome
  WHERE t.id = p_tenant_id;
END;
$$;

comment on function public.api_n8n_config_tool(uuid, text) is
  'Credencial do Chatwoot + estado e config de uma tool, numa chamada so. '
  'Usada pelos sub-workflows de tool. O token vem de tenant_credenciais '
  '(migracao 21a); url e account_id seguem em tenants.';

-- A coluna `tenants.chatwoot_token` continua existindo de proposito. Ela cai na
-- 21b, depois que o painel novo estiver no ar.
