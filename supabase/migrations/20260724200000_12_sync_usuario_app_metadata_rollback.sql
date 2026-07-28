-- Rollback de 12_sync_usuario_app_metadata
--
-- ATENCAO: volta ao estado em que NENHUM usuario pode ser criado pelo GoTrue.
-- admin.createUser, inviteUserByEmail e o "Add user" do painel do Supabase
-- passam a retornar 500 de novo. So use se a migracao 12 causar algo pior.

drop trigger if exists trg_usuario_app_metadata on auth.users;

create or replace function public.handle_novo_usuario()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
DECLARE
    v_papel     TEXT;
    v_tenant_id UUID;
BEGIN
    v_papel := COALESCE(NEW.raw_app_meta_data ->> 'papel', 'tenant_admin');
    v_tenant_id := NULLIF(NEW.raw_app_meta_data ->> 'tenant_id', '')::uuid;

    IF v_papel = 'tenant_admin' AND v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'tenant_admin exige tenant_id no app_metadata do convite';
    END IF;

    INSERT INTO public.usuarios_painel (id, tenant_id, papel, nome, email)
    VALUES (
        NEW.id,
        v_tenant_id,
        v_papel,
        COALESCE(NEW.raw_user_meta_data ->> 'nome', NEW.email),
        NEW.email
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;
