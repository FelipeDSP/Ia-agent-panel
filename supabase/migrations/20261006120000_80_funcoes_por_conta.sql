-- =====================================================================
-- Migração 80 — funções por conta (equipe do cliente)
-- =====================================================================
-- Pedido do Felipe, 06/10/2026: "o admin deve determinar o que cada um pode
-- fazer, ou categorizar por funções e cada função pode fazer X coisa, algo
-- como as funções personalizadas do Chatwoot". Desenho em
-- `docs/DESENHO-USUARIOS-POR-CONTA.md`, seções 6–10 (06/10) — elas SUBSTITUEM
-- a decisão de 17/09 de marcar checkbox por pessoa.
--
-- O ESTADO DE HOJE, medido antes de escrever:
--   - `papel` aceita só `super_admin` e `tenant_admin` (CHECK);
--   - a policy de INSERT em `usuarios_painel` é `auth_is_super_admin()`, e a
--     Server Action de convite começa com `exigirSuperAdmin()` — o admin do
--     CLIENTE não cria ninguém, por duas camadas;
--   - cada uma das 5 contas tem exatamente 1 usuário, e ele pode tudo.
--
-- O QUE ESTA MIGRAÇÃO FAZ
--
-- 1. `tenant_funcoes`: a função é entidade, não campo da pessoa. Mudar
--    "Vendedor" muda todo mundo que a tem — o ponto do modelo do Chatwoot.
-- 2. `usuarios_painel`: papel novo `tenant_agente` e coluna `funcao_id`.
-- 3. A CAPACIDADE NÃO VAI PARA O JWT. É a decisão central e está na seção 7 do
--    desenho: com função nomeada, espelhar no `app_metadata` exigiria
--    reescrever o metadata de toda pessoa que tem a função E ainda assim
--    ninguém perderia acesso até o token virar (~1 h). O admin tiraria a
--    permissão, veria a tela confirmar, e a pessoa seguiria editando. A RLS
--    passa a ler do banco, na hora, por `auth_capacidades()`.
-- 4. Toda policy `for all` do cliente VIRA DUAS: select por tenant, escrita por
--    tenant E capacidade. Pôr a capacidade na `for all` tiraria o SELECT junto
--    — um agente sem `editar_catalogo` deixaria de VER o catálogo, e a tela
--    quebraria sem ninguém entender por quê (seção 8).
-- 5. As `SECURITY DEFINER` que o cliente chama ganham a checagem POR DENTRO.
--    Policy não é a única porta: `SECURITY DEFINER` roda como `postgres`, que
--    tem BYPASSRLS. `painel_marcar_pedido` ESCREVE e é o botão pago/retirado;
--    `conversa_historico` lê o diálogo inteiro. As duas por `create or
--    replace` de MESMA assinatura — sem `drop`, então os grants ficam (a
--    armadilha das migrações 40/41 é o DROP).
--
-- NÃO MUDA NADA PARA QUEM EXISTE HOJE: todo usuário vivo é `tenant_admin`, e
-- `auth_capacidades()` devolve tudo para admin. A conta só ganha comportamento
-- novo quando o admin criar uma função e convidar alguém.
--
-- Rollback: 20261006120000_80_funcoes_por_conta_rollback.sql
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. As capacidades que existem. Lista FIXA: o cliente compõe funções, não
--    inventa capacidade. O espelho desta lista no código é
--    `src/lib/usuarios/capacidades.ts`, e `teste:funcoes-por-conta` executa
--    esta função e compara com aquele arquivo — par derivado não diverge.
-- ---------------------------------------------------------------------
create or replace function public.capacidades_conhecidas()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'ver_conversas',    -- abrir Conversas e ler o histórico
    'pausar_retomar',   -- pausar o agente numa conversa e retomar
    'limpar_memoria',   -- fazer o agente esquecer o histórico de uma conversa
    'marcar_pedido',    -- marcar pago / retirado em Pedidos
    'editar_catalogo',  -- produtos, categorias e fotos
    'editar_prompt',    -- o prompt do agente
    'editar_base',      -- base de conhecimento (subir e remover documento)
    'ver_consumo'       -- relatórios e consumo
  ]::text[];
$$;

revoke all on function public.capacidades_conhecidas() from public;
revoke all on function public.capacidades_conhecidas() from anon;
grant execute on function public.capacidades_conhecidas() to authenticated;
grant execute on function public.capacidades_conhecidas() to service_role;

-- ---------------------------------------------------------------------
-- 2. A tabela das funções.
--    `tenant_id` é a PRIMEIRA coluna do índice composto (regra 3 do CLAUDE.md).
-- ---------------------------------------------------------------------
create table if not exists public.tenant_funcoes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  nome          text not null,
  capacidades   text[] not null default '{}'::text[],
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint ck_tenant_funcoes_nome check (btrim(nome) <> ''),
  -- capacidade inventada não entra: o conjunto é o do código.
  constraint ck_tenant_funcoes_capacidades
    check (capacidades <@ public.capacidades_conhecidas())
);

create unique index if not exists uq_tenant_funcoes_nome
  on public.tenant_funcoes (tenant_id, lower(btrim(nome)));
create index if not exists idx_tenant_funcoes_tenant
  on public.tenant_funcoes (tenant_id, nome);

drop trigger if exists trg_tenant_funcoes_upd on public.tenant_funcoes;
create trigger trg_tenant_funcoes_upd
  before update on public.tenant_funcoes
  for each row execute function public.set_atualizado_em();

-- Objeto novo nasce com `arwdDxtm` para `anon` neste projeto (nota do
-- CLAUDE.md, medida em 2026-08-21). Revogar vem ANTES de conceder, senão o
-- grant é decoração sobre algo que já nasceu público.
revoke all on public.tenant_funcoes from public;
revoke all on public.tenant_funcoes from anon;
revoke all on public.tenant_funcoes from authenticated;
revoke all on public.tenant_funcoes from service_role;
grant select, insert, update, delete on public.tenant_funcoes to authenticated;
grant select, insert, update, delete on public.tenant_funcoes to service_role;

alter table public.tenant_funcoes enable row level security;

-- ---------------------------------------------------------------------
-- 3. `usuarios_painel`: papel novo e a função da pessoa.
-- ---------------------------------------------------------------------
alter table public.usuarios_painel
  add column if not exists funcao_id uuid references public.tenant_funcoes(id) on delete set null;

create index if not exists idx_usuarios_painel_funcao
  on public.usuarios_painel (tenant_id, funcao_id);

-- OS NOMES SAEM DO CATÁLOGO. A primeira versão dropava
-- `usuarios_painel_check`, que não existe: a restrição de papel×tenant se
-- chama `chk_papel_tenant`. O `drop ... if exists` não reclama de nome errado,
-- então o `add` seguinte convivia com a antiga e o INSERT de `tenant_agente`
-- morria no CHECK que ninguém tinha tirado. Mesmo erro das policies, no mesmo
-- dia: nome montado é suposição.
do $$
declare x record;
begin
  for x in
    select conname from pg_constraint
     where conrelid = 'public.usuarios_painel'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%papel%'
  loop
    execute format('alter table public.usuarios_painel drop constraint %I', x.conname);
  end loop;
end $$;

alter table public.usuarios_painel
  add constraint usuarios_painel_papel_check
  check (papel = any (array['super_admin','tenant_admin','tenant_agente']));

alter table public.usuarios_painel
  add constraint chk_papel_tenant
  check (
       (papel = 'super_admin'  and tenant_id is null)
    or (papel = 'tenant_admin' and tenant_id is not null)
    or (papel = 'tenant_agente' and tenant_id is not null)
  );

-- Função só pode ser do MESMO tenant da pessoa. Sem isto, o admin de A
-- apontaria alguém para uma função de B e herdaria as capacidades dela.
create or replace function public.usuarios_painel_funcao_do_tenant()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_tenant uuid;
begin
  if new.funcao_id is null then
    return new;
  end if;
  select tenant_id into v_tenant from public.tenant_funcoes where id = new.funcao_id;
  if v_tenant is distinct from new.tenant_id then
    raise exception 'funcao % nao pertence ao tenant do usuario', new.funcao_id
      using errcode = '42501';
  end if;
  if new.papel <> 'tenant_agente' then
    raise exception 'so tenant_agente tem funcao; % nao', new.papel
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_usuarios_painel_funcao on public.usuarios_painel;
create trigger trg_usuarios_painel_funcao
  before insert or update on public.usuarios_painel
  for each row execute function public.usuarios_painel_funcao_do_tenant();

-- ---------------------------------------------------------------------
-- 4. Quem é quem, e o que pode. LIDO DO BANCO, não do JWT.
--
--    `SECURITY DEFINER` porque estas funções são chamadas de dentro de policy
--    sobre `usuarios_painel`, que tem RLS — sem isso, recursão. Elas leem
--    SÓ a linha de `auth.uid()`: não são porta para ver usuário alheio.
--    `STABLE` é o que torna o custo aceitável: o planner resolve uma vez por
--    statement, não por linha.
-- ---------------------------------------------------------------------
create or replace function public.auth_papel()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select u.papel from public.usuarios_painel u where u.id = auth.uid() and u.ativo),
    nullif(public.jwt_claims() -> 'app_metadata' ->> 'papel', '')
  );
$$;

create or replace function public.auth_e_admin()
returns boolean
language sql
stable
set search_path = public
as $$
  select public.auth_is_super_admin() or public.auth_papel() = 'tenant_admin';
$$;

create or replace function public.auth_capacidades()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.auth_is_super_admin() then public.capacidades_conhecidas()
    else coalesce(
      (select case
                when u.papel in ('super_admin','tenant_admin') then public.capacidades_conhecidas()
                else coalesce(f.capacidades, '{}'::text[])
              end
         from public.usuarios_painel u
         left join public.tenant_funcoes f on f.id = u.funcao_id
        where u.id = auth.uid() and u.ativo),
      '{}'::text[])
  end;
$$;

create or replace function public.auth_pode(p_capacidade text)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_capacidade = any (public.auth_capacidades());
$$;

revoke all on function public.auth_papel() from public;
revoke all on function public.auth_e_admin() from public;
revoke all on function public.auth_capacidades() from public;
revoke all on function public.auth_pode(text) from public;
revoke all on function public.auth_papel() from anon;
revoke all on function public.auth_e_admin() from anon;
revoke all on function public.auth_capacidades() from anon;
revoke all on function public.auth_pode(text) from anon;
grant execute on function public.auth_papel() to authenticated, service_role;
grant execute on function public.auth_e_admin() to authenticated, service_role;
grant execute on function public.auth_capacidades() to authenticated, service_role;
grant execute on function public.auth_pode(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Policies de `tenant_funcoes`: ver é de quem é do tenant; mexer é do ADMIN.
--    Agente que pudesse editar a própria função se autopromoveria.
-- ---------------------------------------------------------------------
drop policy if exists p_tenant_funcoes_select on public.tenant_funcoes;
drop policy if exists p_tenant_funcoes_write  on public.tenant_funcoes;

create policy p_tenant_funcoes_select on public.tenant_funcoes
  for select using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

create policy p_tenant_funcoes_write on public.tenant_funcoes
  for all
  using      (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id() and public.auth_e_admin()))
  with check (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id() and public.auth_e_admin()));

-- ---------------------------------------------------------------------
-- 6. As policies do cliente: cada `for all` vira SELECT + escrita.
--
--    A lista das tabelas e de qual capacidade manda em cada uma está aqui, por
--    extenso, de propósito: é a parte que uma revisão desatenta erra, e
--    `teste:funcoes-por-conta` varre `pg_policy` para exigir que nenhuma tabela
--    escopada por tenant tenha ficado com `for all` sem capacidade.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  p record;
begin
  for r in
    select * from (values
      ('categorias',     'editar_catalogo', null),
      ('produtos',       'editar_catalogo', null),
      ('kb_documentos',  'editar_base',     null),
      ('jobs_ingestao',  'editar_base',     null),
      ('prompt_versoes', 'editar_prompt',   null),
      -- conversas é a única em que LER também é capacidade: quem não pode ver
      -- conversa não deve abrir a lista.
      ('conversas',      'pausar_retomar',  'ver_conversas')
    ) as t(tabela, cap_escrita, cap_leitura)
  loop
    -- DROPA PELO CATÁLOGO, não por nome montado. A primeira versão desta
    -- migração montava `p_<tabela>_all` e errou em duas: as policies reais se
    -- chamam `p_kb_all` e `p_jobs_all`, não `p_kb_documentos_all` nem
    -- `p_jobs_ingestao_all`. As antigas sobreviveriam ao lado das novas — e
    -- policies permissivas são OR, então a antiga (só tenant) teria concedido
    -- tudo de volta, em silêncio. Quem pegou foi a varredura de `pg_policy` do
    -- teste; nome montado é suposição, catálogo é fato.
    for p in select polname from pg_policy where polrelid = format('public.%I', r.tabela)::regclass
    loop
      execute format('drop policy if exists %I on public.%I', p.polname, r.tabela);
    end loop;

    execute format(
      'create policy p_%1$s_select on public.%1$I for select using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id()%2$s))',
      r.tabela,
      case when r.cap_leitura is null then '' else format(' and public.auth_pode(%L)', r.cap_leitura) end);

    execute format(
      'create policy p_%1$s_ins on public.%1$I for insert with check (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id() and public.auth_pode(%2$L)))',
      r.tabela, r.cap_escrita);
    execute format(
      'create policy p_%1$s_upd on public.%1$I for update using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id() and public.auth_pode(%2$L))) with check (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id() and public.auth_pode(%2$L)))',
      r.tabela, r.cap_escrita);
    execute format(
      'create policy p_%1$s_del on public.%1$I for delete using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id() and public.auth_pode(%2$L)))',
      r.tabela, r.cap_escrita);
  end loop;
end $$;

-- `tenant_times` e `tenant_tools` são CONFIGURAÇÃO da conta: nenhuma
-- capacidade as cobre, e quem mexe nelas é o admin. Agente nenhum liga ou
-- desliga módulo.
do $$
declare p record;
begin
  for p in select polname from pg_policy where polrelid = 'public.tenant_times'::regclass
  loop execute format('drop policy if exists %I on public.tenant_times', p.polname); end loop;
end $$;
create policy p_tenant_times_select on public.tenant_times
  for select using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());
create policy p_tenant_times_write on public.tenant_times
  for all
  using      (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id() and public.auth_e_admin()))
  with check (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id() and public.auth_e_admin()));

drop policy if exists p_tools_update on public.tenant_tools;
create policy p_tools_update on public.tenant_tools
  for update
  using      (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id() and public.auth_e_admin()))
  with check (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id() and public.auth_e_admin()));

-- ---------------------------------------------------------------------
-- 7. `usuarios_painel`: o admin do CLIENTE passa a gerir a própria equipe.
--    Nunca a si mesmo, nunca o papel, nunca outro tenant.
-- ---------------------------------------------------------------------
drop policy if exists p_usuarios_insert on public.usuarios_painel;
drop policy if exists p_usuarios_update on public.usuarios_painel;
drop policy if exists p_usuarios_delete on public.usuarios_painel;

create policy p_usuarios_insert on public.usuarios_painel
  for insert with check (
    public.auth_is_super_admin()
    or (tenant_id = public.auth_tenant_id() and public.auth_e_admin() and papel = 'tenant_agente')
  );

create policy p_usuarios_update on public.usuarios_painel
  for update
  using (
    public.auth_is_super_admin()
    or id = auth.uid()
    or (tenant_id = public.auth_tenant_id() and public.auth_e_admin())
  )
  with check (
    public.auth_is_super_admin()
    or id = auth.uid()
    or (tenant_id = public.auth_tenant_id() and public.auth_e_admin())
  );

create policy p_usuarios_delete on public.usuarios_painel
  for delete using (
    public.auth_is_super_admin()
    or (tenant_id = public.auth_tenant_id() and public.auth_e_admin() and papel = 'tenant_agente')
  );

-- O guard da 73 continua valendo para quem não é admin (só o próprio nome),
-- e passa a deixar o ADMIN do tenant mexer em `funcao_id`, `ativo` e `nome`
-- da equipe — nunca em `papel`, `tenant_id` ou `email`, que são da agência,
-- e nunca na própria linha (ninguém se promove).
create or replace function public.usuarios_painel_guard_colunas()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.auth_is_super_admin() then
    return new;
  end if;

  if public.auth_e_admin()
     and old.tenant_id = public.auth_tenant_id()
     and old.id <> auth.uid()
  then
    if (to_jsonb(new) - '{nome,funcao_id,ativo,atualizado_em}'::text[])
       is distinct from
       (to_jsonb(old) - '{nome,funcao_id,ativo,atualizado_em}'::text[])
    then
      raise exception
        'Sem permissao: o admin da conta muda nome, funcao e ativo da equipe. Papel, tenant e email sao da agencia.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if (to_jsonb(new) - '{nome,atualizado_em}'::text[])
     is distinct from
     (to_jsonb(old) - '{nome,atualizado_em}'::text[])
  then
    raise exception
      'Sem permissao: voce so pode alterar o proprio nome. Papel, tenant, email e ativo sao da agencia.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- O trigger que nasce do GoTrue precisa aceitar o papel novo.
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

    IF v_papel NOT IN ('super_admin', 'tenant_admin', 'tenant_agente') THEN
        RAISE EXCEPTION 'papel invalido no app_metadata: %', v_papel;
    END IF;

    IF v_papel IN ('tenant_admin', 'tenant_agente') AND v_tenant_id IS NULL THEN
        RAISE EXCEPTION '% exige tenant_id no app_metadata', v_papel;
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

-- ---------------------------------------------------------------------
-- 8. As SECURITY DEFINER que o cliente chama. Policy não as alcança: elas
--    rodam como `postgres`, que tem BYPASSRLS. `create or replace` de MESMA
--    assinatura — sem `drop`, os grants ficam intactos (a armadilha das 40/41
--    é o DROP).
--
--    OS CORPOS ABAIXO SÃO OS DE PRODUÇÃO, VERBATIM, com UMA linha acrescentada
--    em cada. Foram lidos de `pg_get_functiondef` em 06/10 e não reescritos de
--    memória: a primeira tentativa, escrita de cabeça, perdeu o `for update`,
--    o `deletado_em is null`, as transições estritas de status, o
--    `pagamento_modo` e o encerramento das `pedido_cobrancas`. Teria passado
--    no teste de permissão e quebrado a venda.
-- ---------------------------------------------------------------------
create or replace function public.painel_marcar_pedido(p_pedido_id uuid, p_acao text)
returns table(ok boolean, motivo text, status text, pago_em timestamptz, retirado_em timestamptz)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_p record;
begin
  if p_acao not in ('pago', 'retirado') then
    return query select false, 'acao_invalida', null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 80: a ÚNICA linha nova. O botão some da tela para quem não tem
  -- `marcar_pedido`, mas a tela não é a porta: esta função é chamável direto
  -- pelo PostgREST por qualquer sessão autenticada do tenant.
  if not public.auth_pode('marcar_pedido') then
    return query select false, 'sem_permissao', null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select p.* into v_p
  from public.pedidos p
  where p.id = p_pedido_id
    and p.deletado_em is null
    and (public.auth_is_super_admin() or p.tenant_id = public.auth_tenant_id())
  for update;

  if v_p.id is null then
    return query select false, 'nao_encontrado', null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if p_acao = 'pago' then
    if v_p.status <> 'aguardando_pagamento' then
      return query select false, 'nao_esta_aguardando', v_p.status, v_p.pago_em, v_p.retirado_em;
      return;
    end if;
    update public.pedidos p
       set status      = 'pago',
           pago_em     = now(),
           -- quem paga na retirada esta retirando: os dois de uma vez
           retirado_em = case when coalesce(p.pagamento_modo, 'link') = 'na_retirada'
                              then now() else p.retirado_em end,
           atualizado_em = now()
     where p.id = v_p.id;
    -- cobrancas abertas deste pedido deixam de ser "a encerrar": o dono
    -- recebeu no balcao, o cliente nao pode ouvir que o link expirou
    update public.pedido_cobrancas c
       set encerrada_em = now(),
           encerramento_detalhe = 'pago no painel (69)'
     where c.pedido_id = v_p.id
       and c.tenant_id = v_p.tenant_id
       and c.pago_em is null and c.falhou_em is null and c.encerrada_em is null;
  else
    if v_p.status <> 'pago' then
      return query select false, 'nao_esta_pago', v_p.status, v_p.pago_em, v_p.retirado_em;
      return;
    end if;
    if v_p.retirado_em is not null then
      return query select false, 'ja_retirado', v_p.status, v_p.pago_em, v_p.retirado_em;
      return;
    end if;
    update public.pedidos p
       set retirado_em = now(), atualizado_em = now()
     where p.id = v_p.id;
  end if;

  return query
    select true, p_acao, p.status, p.pago_em, p.retirado_em
      from public.pedidos p where p.id = v_p.id;
end;
$fn$;

-- `conversa_historico` continua `language sql STABLE` — trocar para plpgsql
-- mudaria o plano sem necessidade. A capacidade entra como mais um `and` do
-- `where`: sem ela, zero linhas, que é o mesmo que a função já faz para quem
-- não é do tenant.
create or replace function public.conversa_historico(p_conversation_id bigint)
returns table(direcao text, conteudo text, criado_em timestamptz)
language sql
stable
security definer
set search_path = public
as $fn$
  select m.direcao, m.conteudo, m.criado_em
  from public.mensagens_log m
  where m.tenant_id = public.auth_tenant_id()
    and m.conversation_id = p_conversation_id
    and public.auth_pode('ver_conversas')
  order by m.criado_em asc;
$fn$;

commit;
