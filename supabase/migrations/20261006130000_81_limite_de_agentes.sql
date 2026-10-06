-- =====================================================================
-- Migração 81 — quantos agentes cada conta pode ter
-- =====================================================================
-- Pedido do Felipe, 06/10/2026: "pelo painel superadmin eu possa determinar
-- quantos agentes uma conta pode ter e gerenciar eles por lá — criar agente,
-- excluir, trocar nome, trocar senha".
--
-- Depende da 80 (o papel `tenant_agente` existe lá). Aplicar em ordem.
--
-- `max_agentes` é COLUNA DA AGÊNCIA, e não precisa de nada para ser: o
-- `tenants_guard_colunas` (migração 61) recusa qualquer coluna que não esteja
-- na lista branca do cliente, e esta não está. Medido antes de escrever —
-- acrescentar à lista é que seria o erro.
--
-- NASCE EM ZERO, de propósito. Agente é coisa que a agência vende: se o default
-- fosse 5, toda conta existente ganharia cinco assentos sem ninguém decidir, e
-- a decisão comercial viraria efeito colateral de uma migração. Zero é o
-- estado honesto — nenhuma conta muda de comportamento ao aplicar.
--
-- O LIMITE É DO BANCO, não da tela. A tela vai esconder o botão de convidar
-- quando o teto for atingido, mas a tela não é a porta: o convite nasce de um
-- `insert` em `auth.users`, e quem o faz é o `service_role`, que ignora RLS.
-- Por isso a contagem é um TRIGGER — a única camada que o `service_role` não
-- atravessa.
--
-- Conta só quem está ATIVO: desativar alguém devolve o assento. É a semântica
-- que o cliente espera ("tenho 3 assentos") e evita o chamado de "removi e não
-- consigo convidar".
--
-- Rollback: 20261006130000_81_limite_de_agentes_rollback.sql
-- (este rollback é sempre replayável — a 81 RESTRINGE, não amplia; tirar o
--  teto nunca esbarra em estado criado depois dela.)
-- =====================================================================

begin;

alter table public.tenants
  add column if not exists max_agentes integer not null default 0;

alter table public.tenants drop constraint if exists ck_tenants_max_agentes;
alter table public.tenants
  add constraint ck_tenants_max_agentes check (max_agentes >= 0 and max_agentes <= 200);

comment on column public.tenants.max_agentes is
  'Quantos usuarios com papel tenant_agente esta conta pode ter ATIVOS. Da agencia (fora da lista branca do guard). Nasce 0.';

create or replace function public.usuarios_painel_limite_agentes()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_teto  integer;
  v_atual integer;
begin
  -- Só interessa quem ocupa assento: agente ATIVO.
  if new.papel <> 'tenant_agente' or new.ativo is not true then
    return new;
  end if;

  -- UPDATE que não muda nada relevante não precisa recontar (e recontar faria
  -- uma edição de nome falhar numa conta que já estourou o teto por outro
  -- caminho — o que seria um beco sem saída para a agência consertar).
  if tg_op = 'UPDATE'
     and old.papel = 'tenant_agente'
     and old.ativo is true
     and old.tenant_id is not distinct from new.tenant_id
  then
    return new;
  end if;

  select t.max_agentes into v_teto from public.tenants t where t.id = new.tenant_id;
  if v_teto is null then
    return new; -- tenant sumiu: a FK reclama, não este trigger
  end if;

  select count(*) into v_atual
    from public.usuarios_painel u
   where u.tenant_id = new.tenant_id
     and u.papel = 'tenant_agente'
     and u.ativo is true
     and u.id <> new.id;

  if v_atual >= v_teto then
    raise exception
      'Limite de agentes da conta atingido: % de % em uso. Fale com a agencia para aumentar.',
      v_atual, v_teto
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_usuarios_painel_limite on public.usuarios_painel;
create trigger trg_usuarios_painel_limite
  before insert or update on public.usuarios_painel
  for each row execute function public.usuarios_painel_limite_agentes();

commit;
