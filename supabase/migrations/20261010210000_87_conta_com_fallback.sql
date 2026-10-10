-- =============================================================================
-- 87 — CONSERTA A 86: a conta resolve, mas sem matar "dois agentes na mesma conta"
-- =============================================================================
--
-- A 86 (hoje, algumas horas atrás) resolveu o caso da Acqua — robô em duas
-- caixas da mesma conta — criando índice ÚNICO por conta. Isso proibiu uma
-- capacidade que a migração 54 construiu de propósito, e cujo teste diz com
-- todas as letras: "dois agentes cabem na mesma conta — que é a fatia inteira".
--
-- `teste:roteamento-caixa` e `teste:desconectar-chatwoot` ficaram vermelhos, e
-- estavam certos: eram a guarda daquele desenho fazendo o trabalho dela. Nenhum
-- cliente usa a capacidade hoje, mas tirá-la não era o pedido e não era preciso.
--
-- O DESENHO QUE ATENDE OS DOIS, e é melhor que qualquer um sozinho:
--
--   1. casa ESTRITO por (conta, caixa) — é a 54, intacta;
--   2. se não achou, cai para a CONTA — e só quando aquela conta tem UM tenant.
--
-- Acqua: um tenant na conta 56, robô em duas caixas. A caixa 255 casa estrito;
-- a outra cai no fallback e resolve igual.
--
-- Dois agentes numa conta: cada um fixado na sua caixa, o estrito ganha. Uma
-- caixa de terceira, que não é de nenhum dos dois, não cai no fallback porque a
-- conta tem dois donos — e a resposta vira zero linhas. Ambiguidade na
-- resolução de tenant é responder o cliente de A com a base de B; silêncio é
-- ruim, mas é MUITO melhor.
--
-- POR QUE `drop function` ANTES do create: a 86 criou a função com UM argumento
-- e aqui ela passa a ter dois (o segundo com DEFAULT). `or replace` só
-- substitui a de mesma aridade — sem o drop, as duas ficariam vivas e a chamada
-- com UM argumento viraria AMBÍGUA. É a armadilha das migrações 28, 32 e 37, e
-- o drop é pela lista completa de tipos, nunca pelo nome.
--
-- ROLLBACK: ao final do arquivo.
-- =============================================================================

-- ---- 1. os índices da 54 voltam, o meu sai -----------------------------------
create unique index if not exists idx_tenants_chatwoot_caixa
  on public.tenants (chatwoot_account_id, chatwoot_inbox_id)
  where chatwoot_account_id is not null and chatwoot_inbox_id is not null;

create unique index if not exists idx_tenants_chatwoot_sem_caixa
  on public.tenants (chatwoot_account_id)
  where chatwoot_account_id is not null and chatwoot_inbox_id is null;

drop index if exists public.idx_tenants_chatwoot_conta;

-- ---- 2. a resolução: estrito primeiro, conta depois --------------------------
drop function if exists public.api_agente_tenant_por_conta(bigint);
drop function if exists public.api_agente_tenant_por_conta(bigint, bigint);

create or replace function public.api_agente_tenant_por_conta(
  p_account_id bigint,
  p_inbox_id   bigint default null
)
returns table(
  tenant_id                uuid,
  slug                     text,
  nome                     text,
  agente_ativo             boolean,
  system_prompt            text,
  modelo                   text,
  temperatura              numeric,
  debounce_segundos        integer,
  msg_midia_nao_suportada  text,
  msg_fora_escopo          text,
  chatwoot_url             text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_donos integer;
begin
  if p_account_id is null then
    raise exception 'api_agente: p_account_id e obrigatorio — o webhook traz em '
                    'body.account.id / body.conversation.account_id'
      using errcode = '22023';
  end if;

  -- (1) ESTRITO. É a 54, e ela ganha sempre que casar: numa conta com dois
  -- agentes, cada um fixado na sua caixa, é isto que mantém cada um no lugar.
  if p_inbox_id is not null then
    return query
      select t.id, t.slug, t.nome, t.agente_ativo, t.system_prompt, t.modelo,
             t.temperatura, t.debounce_segundos, t.msg_midia_nao_suportada,
             t.msg_fora_escopo, t.chatwoot_url
        from public.tenants t
       where t.chatwoot_account_id = p_account_id
         and t.chatwoot_inbox_id  = p_inbox_id
         and t.ativo
         and t.deletado_em is null;
    if found then
      return;
    end if;
  end if;

  -- (2) FALLBACK PELA CONTA, e só com UM dono. A contagem é o que torna isto
  -- seguro: com dois agentes na conta não há resposta certa, e devolver
  -- qualquer um seria sorteio — o defeito que a 54 chama de "não dá erro: dá
  -- sorteio".
  select count(*) into v_donos
    from public.tenants t
   where t.chatwoot_account_id = p_account_id
     and t.ativo
     and t.deletado_em is null;

  if v_donos = 1 then
    return query
      select t.id, t.slug, t.nome, t.agente_ativo, t.system_prompt, t.modelo,
             t.temperatura, t.debounce_segundos, t.msg_midia_nao_suportada,
             t.msg_fora_escopo, t.chatwoot_url
        from public.tenants t
       where t.chatwoot_account_id = p_account_id
         and t.ativo
         and t.deletado_em is null;
  end if;
end;
$$;

comment on function public.api_agente_tenant_por_conta(bigint, bigint) is
  '87: resolve o tenant por (conta, caixa) e, se nao casar, pela CONTA — mas so quando a conta tem UM tenant. '
  'Atende o robo em varias caixas da mesma conta (Acqua, 10/10) sem matar "dois agentes na mesma conta" (migracao 54). '
  'Conta com dois donos e caixa desconhecida devolve ZERO linhas: silencio e melhor que sorteio.';

-- ---- grants ----------------------------------------------------------------
-- `drop function` apaga TODOS os grants; recriar restaura so o que o script
-- listar. E `revoke` antes do `grant`, porque o objeto nasce aberto a PUBLIC,
-- `anon` e `authenticated` pelas ALTER DEFAULT PRIVILEGES deste projeto.
revoke all on function public.api_agente_tenant_por_conta(bigint, bigint) from public;
revoke all on function public.api_agente_tenant_por_conta(bigint, bigint) from anon;
revoke all on function public.api_agente_tenant_por_conta(bigint, bigint) from authenticated;

grant execute on function public.api_agente_tenant_por_conta(bigint, bigint) to service_role;
grant execute on function public.api_agente_tenant_por_conta(bigint, bigint) to n8n_agent;

-- =============================================================================
-- ROLLBACK (rodar à mão, na ordem inversa) — volta ao estado da 86
-- =============================================================================
-- drop function if exists public.api_agente_tenant_por_conta(bigint, bigint);
-- create unique index if not exists idx_tenants_chatwoot_conta
--   on public.tenants (chatwoot_account_id)
--   where chatwoot_account_id is not null and deletado_em is null;
-- drop index if exists public.idx_tenants_chatwoot_caixa;
-- drop index if exists public.idx_tenants_chatwoot_sem_caixa;
-- =============================================================================
