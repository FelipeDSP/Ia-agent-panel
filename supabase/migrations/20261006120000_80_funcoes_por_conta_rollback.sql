-- =====================================================================
-- Rollback da migração 80 — funções por conta
-- =====================================================================
-- ESTA É UMA MIGRAÇÃO QUE AMPLIA O PERMITIDO, e por isso o rollback dela não
-- é replayável contra produção viva. A regra está no CLAUDE.md desde a 55:
--
--   > O rollback recria a restrição mais estreita, e qualquer estado criado
--   > legalmente depois da migração passa a impedi-lo. Quanto mais a migração
--   > funciona, menos o rollback dela roda.
--
-- Aqui o estado novo é gente: um `tenant_agente` é uma pessoa que o cliente
-- convidou e que usa o painel. O CHECK antigo de `papel` não a aceita. Apagar
-- essa pessoa para o rollback passar seria o rollback decidindo, sozinho, que
-- alguém perde o acesso — e quem roda rollback já está num momento ruim.
--
-- Então ele ABORTA com mensagem própria, e a saída é manual e consciente:
-- rebaixar ou remover as pessoas primeiro, conferir, depois rodar.
-- `tests/lib/agentes-vivos-80.mjs` faz esse arranjo dentro da transação
-- abortada, para os testes que replayam este rollback não ficarem reféns do
-- estado de produção (foi o que aconteceu com a 55 em 08/09).
-- =====================================================================

begin;

-- O rollback TEM de rodar também quando a 80 nunca foi aplicada: é assim que
-- o teste põe o banco no estado pré-migração sem precisar saber se ela já está
-- em produção (a regra do rollback-primeiro). Por isso os `to_regclass`: sem
-- eles este bloco estoura com `relation does not exist` no banco limpo, que é
-- justamente o caso em que não há nada para recusar.
do $$
declare
  v_pessoas int := 0;
  v_funcoes int := 0;
begin
  if to_regclass('public.tenant_funcoes') is not null then
    select count(*) into v_funcoes from public.tenant_funcoes;
  end if;
  select count(*) into v_pessoas from public.usuarios_painel where papel = 'tenant_agente';
  if v_pessoas > 0 then
    raise exception
      'rollback 80 abortado: % pessoa(s) com papel tenant_agente. Rebaixe ou remova antes (elas perderiam o acesso sem aviso).', v_pessoas
      using errcode = 'P0001';
  end if;
  if v_funcoes > 0 then
    raise exception
      'rollback 80 abortado: % funcao(oes) cadastrada(s) por clientes. Apague-as antes, de proposito.', v_funcoes
      using errcode = 'P0001';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. As policies voltam ao `for all` por tenant.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select unnest(array['categorias','produtos','kb_documentos','jobs_ingestao','prompt_versoes','conversas']) as tabela
  loop
    execute format('drop policy if exists p_%1$s_select on public.%1$I', r.tabela);
    execute format('drop policy if exists p_%1$s_ins on public.%1$I', r.tabela);
    execute format('drop policy if exists p_%1$s_upd on public.%1$I', r.tabela);
    execute format('drop policy if exists p_%1$s_del on public.%1$I', r.tabela);
  end loop;
end $$;

-- Os nomes originais, medidos em `pg_policy` antes da 80.
drop policy if exists p_categorias_all on public.categorias;
create policy p_categorias_all on public.categorias
  for all using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id()));

drop policy if exists p_produtos_all on public.produtos;
create policy p_produtos_all on public.produtos
  for all using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id()));

drop policy if exists p_kb_all on public.kb_documentos;
create policy p_kb_all on public.kb_documentos
  for all using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id()));

drop policy if exists p_jobs_all on public.jobs_ingestao;
create policy p_jobs_all on public.jobs_ingestao
  for all using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id()));

drop policy if exists p_prompt_versoes_all on public.prompt_versoes;
create policy p_prompt_versoes_all on public.prompt_versoes
  for all using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id()));

drop policy if exists p_conversas_all on public.conversas;
create policy p_conversas_all on public.conversas
  for all using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id()));

drop policy if exists p_tenant_times_select on public.tenant_times;
drop policy if exists p_tenant_times_write on public.tenant_times;
drop policy if exists p_tenant_times_all on public.tenant_times;
create policy p_tenant_times_all on public.tenant_times
  for all using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id()));

drop policy if exists p_tools_update on public.tenant_tools;
create policy p_tools_update on public.tenant_tools
  for update using (public.auth_is_super_admin() or (tenant_id = public.auth_tenant_id()));

drop policy if exists p_usuarios_insert on public.usuarios_painel;
drop policy if exists p_usuarios_update on public.usuarios_painel;
drop policy if exists p_usuarios_delete on public.usuarios_painel;
create policy p_usuarios_insert on public.usuarios_painel
  for insert with check (public.auth_is_super_admin());
create policy p_usuarios_update on public.usuarios_painel
  for update using (public.auth_is_super_admin() or (id = auth.uid()))
  with check (public.auth_is_super_admin() or (id = auth.uid()));
create policy p_usuarios_delete on public.usuarios_painel
  for delete using (public.auth_is_super_admin());

-- ---------------------------------------------------------------------
-- 2. As SECURITY DEFINER voltam ao corpo de antes da 80 — verbatim.
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
           retirado_em = case when coalesce(p.pagamento_modo, 'link') = 'na_retirada'
                              then now() else p.retirado_em end,
           atualizado_em = now()
     where p.id = v_p.id;
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
  order by m.criado_em asc;
$fn$;

-- ---------------------------------------------------------------------
-- 3. Guard e trigger de criação voltam ao de antes.
-- ---------------------------------------------------------------------
create or replace function public.usuarios_painel_guard_colunas()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if public.auth_is_super_admin() then
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
$fn$;

create or replace function public.handle_novo_usuario()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
    v_papel     TEXT;
    v_tenant_id UUID;
BEGIN
    v_papel     := NEW.raw_app_meta_data ->> 'papel';
    v_tenant_id := NULLIF(NEW.raw_app_meta_data ->> 'tenant_id', '')::uuid;

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
$fn$;

-- ---------------------------------------------------------------------
-- 4. Coluna, CHECKs e tabela.
-- ---------------------------------------------------------------------
drop trigger if exists trg_usuarios_painel_funcao on public.usuarios_painel;
drop function if exists public.usuarios_painel_funcao_do_tenant();

drop index if exists public.idx_usuarios_painel_funcao;
alter table public.usuarios_painel drop column if exists funcao_id;

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
  check (papel = any (array['super_admin','tenant_admin']));
alter table public.usuarios_painel
  add constraint chk_papel_tenant
  check (
       (papel = 'super_admin'  and tenant_id is null)
    or (papel = 'tenant_admin' and tenant_id is not null)
  );

drop table if exists public.tenant_funcoes;

drop function if exists public.auth_pode(text);
drop function if exists public.auth_capacidades();
drop function if exists public.auth_e_admin();
drop function if exists public.auth_papel();
drop function if exists public.capacidades_conhecidas();

commit;
