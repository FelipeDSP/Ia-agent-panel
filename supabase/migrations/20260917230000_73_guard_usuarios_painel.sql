-- =====================================================================
-- 73 — Guarda de colunas em usuarios_painel
-- =====================================================================
-- Análise de segurança de 17/09/2026, achado 2 (medido): com o JWT de um
-- tenant_admin, `update usuarios_painel set papel='super_admin',
-- tenant_id=null where id=<eu>` afetava 1 linha, e `tenant_id` de outro
-- tenant também. A policy `p_usuarios_update` permite `id = auth.uid()` sem
-- dizer QUAIS colunas; o `chk_papel_tenant` só exige coerência.
--
-- Não era escalada viva: a autorização vem do JWT (`app_metadata`), que só
-- o service_role grava, e a tabela é projeção. Mas ela é lida pela agência e
-- vai receber `permissoes` (DESENHO-USUARIOS-POR-CONTA) — no dia em que
-- alguma checagem ler a tabela, isso vira escalada real. Fecha-se agora.
--
-- Mesmo desenho do `tenants_guard_colunas` (13): whitelist por diff de
-- jsonb, então coluna NOVA nasce protegida. Quem não é super_admin só muda
-- `nome` (e `atualizado_em`, que o trigger set_atualizado_em sempre toca).
-- `email` fica de fora: é projeção do auth.users, mudar aqui só desalinharia.
--
-- Trigger não tem ACL. Extensão: nenhuma. REEXECUTÁVEL.
-- =====================================================================

begin;

create or replace function public.usuarios_painel_guard_colunas()
returns trigger
language plpgsql
set search_path = public
as $$
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
$$;

comment on function public.usuarios_painel_guard_colunas() is
  '73: barra quem nao e super_admin de alterar papel/tenant_id/email/ativo na propria linha. '
  'Whitelist por diff de jsonb: coluna nova (ex.: permissoes) nasce protegida.';

drop trigger if exists trg_usuarios_painel_guard_colunas on public.usuarios_painel;

create trigger trg_usuarios_painel_guard_colunas
  before update on public.usuarios_painel
  for each row
  execute function public.usuarios_painel_guard_colunas();

commit;
