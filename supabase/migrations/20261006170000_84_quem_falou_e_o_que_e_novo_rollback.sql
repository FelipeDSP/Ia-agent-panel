-- =====================================================================
-- Rollback da migração 84
-- =====================================================================
-- Sempre replayável: a 84 acrescenta uma função e uma coluna de conveniência.
-- Nada que ela permite impede o rollback de rodar.
--
-- Perde-se `pedidos_vistos_em` de cada pessoa — o efeito é que, na volta, tudo
-- parece novo uma vez. É um incômodo de um clique, não perda de trabalho.
-- =====================================================================

begin;

drop function if exists public.painel_conversa_mensagens(bigint);

alter table public.usuarios_painel drop column if exists pedidos_vistos_em;

-- O guard volta ao corpo da 80 (sem `pedidos_vistos_em` nas listas).
create or replace function public.usuarios_painel_guard_colunas()
returns trigger
language plpgsql
set search_path = public
as $fn$
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
$fn$;

commit;
