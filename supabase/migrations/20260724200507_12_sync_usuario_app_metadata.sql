-- 12_sync_usuario_app_metadata
--
-- PROBLEMA
--
-- Hoje nenhum usuario pode ser criado por nenhum caminho do GoTrue. Nem
-- admin.createUser, nem inviteUserByEmail, nem o "Add user" do painel do
-- Supabase. Todos retornam 500:
--
--   500: Database error creating new user
--   ERROR: tenant_admin exige tenant_id no app_metadata do convite (P0001)
--
-- CAUSA
--
-- O GoTrue (v2.193.1) nao grava o app_metadata no INSERT. Ele insere o usuario
-- com raw_app_meta_data = {"provider":"email","providers":["email"]} e so
-- depois roda um UPDATE com o app_metadata informado — tudo dentro da mesma
-- transacao.
--
-- O trigger trg_novo_usuario e AFTER INSERT. Ele dispara no meio desse par,
-- quando 'papel' ainda nao existe, cai no COALESCE para 'tenant_admin', nao
-- encontra tenant_id e levanta excecao. A transacao inteira aborta.
--
-- Testar com INSERT direto em auth.users nao reproduz isso: o SQL manual grava
-- o metadata junto, que e exatamente o que o GoTrue nao faz.
--
-- CORRECAO
--
-- A funcao passa a ser idempotente e a rodar nos dois momentos:
--
--   AFTER INSERT                      -> sem papel, nao faz nada e deixa passar
--   AFTER UPDATE OF raw_app_meta_data -> com papel, cria ou atualiza o vinculo
--
-- A garantia original continua: nunca existe linha de tenant_admin sem
-- tenant_id. O que muda e o momento da validacao — quando o dado chega, nao
-- antes dele existir. Como o UPDATE do GoTrue esta na mesma transacao do
-- INSERT, nao ha janela com usuario sem vinculo: ou os dois acontecem, ou
-- nenhum.
--
-- Efeito colateral desejado: fecha a dessincronizacao em mudanca de papel ou
-- de tenant, que antes exigiria a aplicacao atualizar as duas pontas na mao.
--
-- Usuario criado sem app_metadata nenhum (ex.: painel do Supabase) fica em
-- auth.users sem linha em usuarios_painel. O app trata: obterUsuarioAtual()
-- devolve null para papel invalido e a acao de login encerra a sessao.
--
-- Rollback: 20260724200507_12_sync_usuario_app_metadata_rollback.sql

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
    -- UPDATE seguinte. Deixa passar; o trigger de UPDATE cria o vinculo.
    -- Sem COALESCE para 'tenant_admin' aqui: era o que derrubava a criacao.
    IF v_papel IS NULL THEN
        RETURN NEW;
    END IF;

    IF v_papel NOT IN ('super_admin', 'tenant_admin') THEN
        RAISE EXCEPTION 'papel invalido no app_metadata: %', v_papel;
    END IF;

    -- A regra que o adendo quis proteger, preservada.
    IF v_papel = 'tenant_admin' AND v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'tenant_admin exige tenant_id no app_metadata';
    END IF;

    -- super_admin nao pertence a tenant nenhum.
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

-- Trigger novo, para o momento em que o app_metadata realmente chega.
drop trigger if exists trg_usuario_app_metadata on auth.users;

create trigger trg_usuario_app_metadata
    after update of raw_app_meta_data on auth.users
    for each row
    when (NEW.raw_app_meta_data IS DISTINCT FROM OLD.raw_app_meta_data)
    execute function public.handle_novo_usuario();
