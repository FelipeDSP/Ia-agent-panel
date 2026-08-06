-- 20_catalogo_tools
--
-- §4.3 do ESPEC-CATALOGO-DE-TOOLS: catalogo GLOBAL de tools. Hoje cada linha de
-- tenant_tools repete descricao e workflow_id em texto livre; com 20 clientes
-- isso diverge (mesma tool com descricoes diferentes; workflow_id digitado
-- errado vira tool que o despachante ignora sem erro).
--
-- Solucao: uma tabela de catalogo (sem tenant_id, so super_admin) com o padrao
-- de cada tool. tenant_tools passa a REFERENCIAR o catalogo (FK por tool_nome),
-- e descricao/workflow_id viram OVERRIDE opcional (null = usa o padrao).
-- api_n8n_tools_ativas faz COALESCE(override, padrao) e continua devolvendo as
-- MESMAS 4 colunas — assinatura inalterada, o n8n em producao depende dela.
--
-- SEGURANCA: o catalogo NAO e legivel pelo cliente. Se fosse, um tenant_admin
-- enumeraria pela API todos os modulos existentes — inclusive os que nao
-- contratou —, expondo a estrutura de planos (a §5.2 proibe isso explicitamente).
-- Por isso a policy e super_admin only. O painel do cliente monta rotulo e
-- formulario a partir do registry NO CODIGO (src/lib/tools), nao lendo o
-- catalogo; o estado (ativo/config/contratado) vem de tenant_tools, que o
-- cliente ja pode ler das proprias linhas.
--
-- PARIDADE: as 3 tools em uso (busca_conhecimento, transferir_humano,
-- resolver_conversa) sao semeadas com workflow_id_padrao = NULL. Como as linhas
-- atuais de tenant_tools tem descricao nao-nula (override) e o padrao de
-- workflow e null, o COALESCE devolve exatamente o valor de hoje para todas as
-- linhas — retorno da funcao identico antes/depois (verificado com diff).
--
-- Rollback: 20260805162526_20_catalogo_tools_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Tabela de catalogo (global, sem tenant_id)
-- ---------------------------------------------------------------------------

create table if not exists public.catalogo_tools (
  tool_nome           text primary key,
  nome_exibicao       text not null,
  descricao_padrao    text,
  workflow_id_padrao  text,
  schema_config       jsonb   not null default '{}'::jsonb,
  ativo               boolean not null default true,
  criado_em           timestamptz not null default now()
);

comment on table public.catalogo_tools is
  'Catalogo global de tools (sem tenant_id, so super_admin). Padrao de cada tool; '
  'tenant_tools referencia por tool_nome e sobrescreve descricao/workflow_id opcionalmente.';
comment on column public.catalogo_tools.schema_config is
  'Descreve os campos de config que o cliente edita. Fonte da verdade do formulario '
  'e o registry no codigo (src/lib/tools); aqui serve para validacao/documentacao.';

-- ---------------------------------------------------------------------------
-- 2. RLS: so super_admin (le e escreve). anon nunca.
-- ---------------------------------------------------------------------------

alter table public.catalogo_tools enable row level security;
alter table public.catalogo_tools force row level security;

-- RLS so atua com grant de tabela. authenticated recebe os comandos; a policy
-- restringe a super_admin. service_role bypassa RLS mas precisa do grant.
grant select, insert, update, delete on public.catalogo_tools to authenticated;
grant select, insert, update, delete on public.catalogo_tools to service_role;
-- anon: nenhum privilegio de proposito (nao concede).

create policy p_catalogo_all on public.catalogo_tools
  for all to authenticated
  using (public.auth_is_super_admin())
  with check (public.auth_is_super_admin());

-- ---------------------------------------------------------------------------
-- 3. Seed das tools em uso (precisa existir ANTES do FK do passo 4)
-- ---------------------------------------------------------------------------

insert into public.catalogo_tools
  (tool_nome, nome_exibicao, descricao_padrao, workflow_id_padrao, schema_config, ativo)
values
  ('busca_conhecimento', 'Buscar na base de conhecimento',
   'Busca informacoes na base de conhecimento do cliente.',
   null, '{}'::jsonb, true),
  ('transferir_humano', 'Transferir para humano',
   'Transfere o atendimento para um humano quando o cliente pede ou o agente nao resolve.',
   null,
   '{"campos_cliente":["horario","notificacao.canal","notificacao.destino"],"campos_agencia":["notificacao.sessao"]}'::jsonb,
   true),
  ('resolver_conversa', 'Resolver conversa',
   'Encerra a conversa quando o cliente se despede ou o atendimento termina.',
   null, '{}'::jsonb, true)
on conflict (tool_nome) do nothing;

-- ---------------------------------------------------------------------------
-- 4. FK: tenant_tools referencia o catalogo
--    Impede provisionar uma tool que nao existe no catalogo (o furo do
--    workflow_id digitado errado). RESTRICT (default): nao deixa apagar do
--    catalogo uma tool que algum tenant ainda usa.
-- ---------------------------------------------------------------------------

alter table public.tenant_tools
  add constraint tenant_tools_tool_nome_fkey
  foreign key (tool_nome) references public.catalogo_tools(tool_nome);

-- ---------------------------------------------------------------------------
-- 5. api_n8n_tools_ativas: COALESCE(override, padrao). Assinatura inalterada.
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

  -- INNER JOIN: a FK garante que a linha de catalogo existe, entao o join nao
  -- descarta nenhuma tool. Nao filtra por c.ativo de proposito — desligar uma
  -- tool no catalogo gera decisao de PROVISIONAMENTO (o que a agencia pode
  -- contratar), nao mata em silencio um agente que ja a usa.
  return query
  select t.tool_nome,
         coalesce(t.workflow_id, c.workflow_id_padrao) as workflow_id,
         coalesce(t.descricao,   c.descricao_padrao)   as descricao,
         t.config
  from public.tenant_tools t
  join public.catalogo_tools c on c.tool_nome = t.tool_nome
  where t.tenant_id = p_tenant_id
    and t.contratado
    and t.ativo;
end;
$$;

revoke all on function public.api_n8n_tools_ativas(uuid) from public;
revoke all on function public.api_n8n_tools_ativas(uuid) from anon, authenticated;
grant execute on function public.api_n8n_tools_ativas(uuid) to n8n_agent;
