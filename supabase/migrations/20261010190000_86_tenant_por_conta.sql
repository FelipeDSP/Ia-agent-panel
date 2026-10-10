-- =============================================================================
-- 86 — O AGENTE ATENDE A CONTA, NÃO UMA CAIXA
-- =============================================================================
--
-- 10/10, Felipe, olhando a Acqua: "a IA tem que responder em toda e qualquer
-- caixa de entrada presente na conta à qual aquele robô está aplicado — o robô
-- da Acqua tá nas 2 caixas".
--
-- Ele está certo, e o modelo de hoje não suporta isso. `api_n8n_tenant_por_chatwoot`
-- (migração 54) casa o PAR:
--
--     where t.chatwoot_account_id = p_account_id
--       and t.chatwoot_inbox_id  = p_inbox_id
--
-- Mensagem vinda da SEGUNDA caixa da conta não casa linha nenhuma. O serviço
-- devolve `tenant_desconhecido`, responde 200 e descarta. O cliente escreve e
-- não recebe nada, e não há erro em lugar nenhum — nem no log do serviço, que
-- considera isso um webhook de tenant que não é nosso.
--
-- POR QUE A CAIXA NÃO DEVIA FILTRAR, e esta é a parte que importa: quem decide
-- em quais caixas o robô atende é o CHATWOOT, quando alguém anexa o Agent Bot
-- à caixa. Só chega webhook de caixa onde o bot está aplicado. Nosso filtro de
-- caixa duplicava uma decisão que já foi tomada lá fora — e, duplicando, dava
-- uma resposta diferente dela.
--
-- A CAIXA CONTINUA NA TABELA, e não é vestígio: `api_n8n_credencial_chatwoot` e
-- o envio proativo (`agente/src/chatwoot/enviar.ts`) precisam de UMA caixa para
-- criar contato e conversa quando o agente fala primeiro — o aviso de venda ao
-- dono. Ela deixa de ser "a caixa que o agente atende" e passa a ser "a caixa
-- por onde o agente fala primeiro".
--
-- FUNÇÃO NOVA, não assinatura trocada: a 54 continua viva e com a mesma
-- aridade. Trocá-la quebraria o serviço no ar entre a migração e o deploy.
--
-- ROLLBACK: ao final do arquivo.
-- =============================================================================

-- ---- 1. uma conta pertence a UM tenant -------------------------------------
-- Sem isto, resolver por conta seria ambíguo, e ambiguidade em resolução de
-- tenant é a pior classe de defeito deste sistema: responder o cliente de A
-- com a base de B. Medido antes de escrever: nenhuma conta se repete hoje.
--
-- Os dois índices antigos saem. `idx_tenants_chatwoot_caixa` (único por conta
-- +caixa) fica subsumido por este; `idx_tenants_chatwoot_sem_caixa` nunca teve
-- linha nenhuma — ele é único por conta QUANDO a caixa é nula, e o CHECK
-- `tenants_chatwoot_par_check` proíbe exatamente esse estado desde sempre.
create unique index if not exists idx_tenants_chatwoot_conta
  on public.tenants (chatwoot_account_id)
  where chatwoot_account_id is not null and deletado_em is null;

drop index if exists public.idx_tenants_chatwoot_caixa;
drop index if exists public.idx_tenants_chatwoot_sem_caixa;

-- ---- 2. a resolução por conta ----------------------------------------------
drop function if exists public.api_agente_tenant_por_conta(bigint);

create or replace function public.api_agente_tenant_por_conta(p_account_id bigint)
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
begin
  -- Conta nula estoura, como a 54 faz com a caixa: valor de reserva aqui seria
  -- o serviço escolhendo um tenant qualquer para uma mensagem sem dono.
  if p_account_id is null then
    raise exception 'api_agente: p_account_id e obrigatorio — o webhook traz em '
                    'body.account.id / body.conversation.account_id'
      using errcode = '22023';
  end if;

  return query
    select t.id, t.slug, t.nome, t.agente_ativo, t.system_prompt, t.modelo,
           t.temperatura, t.debounce_segundos, t.msg_midia_nao_suportada,
           t.msg_fora_escopo, t.chatwoot_url
      from public.tenants t
     where t.chatwoot_account_id = p_account_id
       and t.ativo
       and t.deletado_em is null;
end;
$$;

comment on function public.api_agente_tenant_por_conta(bigint) is
  '86: resolve o tenant pela CONTA do Chatwoot, sem olhar a caixa. Quem decide em quais caixas o robo atende '
  'e o Chatwoot, ao anexar o Agent Bot — so chega webhook de caixa onde ele esta aplicado. A 54 '
  '(api_n8n_tenant_por_chatwoot) continua viva e casa o par; esta e a que o servico usa desde 10/10.';

-- ---- grants ----------------------------------------------------------------
-- `revoke` antes do `grant`, sempre: objeto novo nasce com EXECUTE para PUBLIC,
-- `anon` e `authenticated` pelas ALTER DEFAULT PRIVILEGES deste projeto.
revoke all on function public.api_agente_tenant_por_conta(bigint) from public;
revoke all on function public.api_agente_tenant_por_conta(bigint) from anon;
revoke all on function public.api_agente_tenant_por_conta(bigint) from authenticated;

grant execute on function public.api_agente_tenant_por_conta(bigint) to service_role;
grant execute on function public.api_agente_tenant_por_conta(bigint) to n8n_agent;

-- =============================================================================
-- ROLLBACK (rodar à mão, na ordem inversa)
-- =============================================================================
-- drop function if exists public.api_agente_tenant_por_conta(bigint);
-- create unique index if not exists idx_tenants_chatwoot_caixa
--   on public.tenants (chatwoot_account_id, chatwoot_inbox_id)
--   where chatwoot_account_id is not null and chatwoot_inbox_id is not null;
-- create unique index if not exists idx_tenants_chatwoot_sem_caixa
--   on public.tenants (chatwoot_account_id)
--   where chatwoot_account_id is not null and chatwoot_inbox_id is null;
-- drop index if exists public.idx_tenants_chatwoot_conta;
-- =============================================================================
