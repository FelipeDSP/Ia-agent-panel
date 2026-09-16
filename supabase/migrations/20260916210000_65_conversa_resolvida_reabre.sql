-- =====================================================================
-- 65. `conversas.status = 'resolvido'` passa a existir de verdade
-- =====================================================================
--
-- docs/PENDENCIA-STATUS-CONVERSA.md (19/08): o CHECK aceita `resolvido`, o
-- painel tem badge para ele, e NINGUÉM nunca o escreveu — 0 linhas. O painel
-- mostra como `ativo` conversa encerrada há meses.
--
-- Agora o `resolver_conversa` é código (`agente/src/tools/resolver-conversa.ts`)
-- e passa a chamar `api_n8n_definir_status_conversa(t, conv, 'resolvido')`
-- depois de resolver no Chatwoot — a função já aceitava o valor. O que falta
-- no banco é a VOLTA: conversa resolvida em que o cliente escreve de novo tem
-- de reabrir, porque o Chatwoot reabre (status `open` na mensagem nova) e o
-- painel não pode mostrar `resolvido` para uma conversa em andamento.
--
-- Onde reabrir: em `api_n8n_conversa_sync`, que é a primeira coisa que todo
-- turno faz com a conversa. `resolvido` -> `ativo` no `on conflict`. Nada
-- muda para `ativo`/`pausado` (a pausa continua sendo do `pausa_vigente`).
-- O n8n (congelado, ainda atendendo emporio/ceejaar) chama esta mesma
-- função: para ele nada muda, porque nenhuma conversa dele tem `resolvido`.
--
-- `create or replace` com a MESMA assinatura: sem drop, sem mexer em grants
-- (conferido no teste por diff de ACL). Extensão: nenhuma. REEXECUTÁVEL.
-- Rollback ao lado: devolve o corpo da 56.
-- =====================================================================

begin;

create or replace function public.api_n8n_conversa_sync(p_tenant_id uuid, p_conversation_id bigint, p_contact_name text default null::text, p_phone text default null::text)
 returns table(status text, pausado_em timestamp with time zone, historico_chars integer)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_historico integer;
  v_janela    integer;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_conversation_id is null then
    raise exception 'api_n8n: p_conversation_id e obrigatorio' using errcode = '22023';
  end if;

  -- A janela e DO TENANT desta chamada. `conversation_id` nao e unico entre
  -- tenants — dois clientes tem conversa 6 — entao ler a janela de qualquer
  -- outro lugar cruzaria os fios.
  select t.pausa_expira_minutos
    into v_janela
    from public.tenants t
   where t.id = p_tenant_id;

  -- Calculado ANTES do insert: o registro da mensagem atual so acontece depois
  -- da resposta, entao aqui o historico e exatamente o dos turnos anteriores.
  select coalesce(sum(length(m.conteudo)), 0)::integer
    into v_historico
  from (
    select l.conteudo
    from public.mensagens_log l
    where l.tenant_id = p_tenant_id
      and l.conversation_id = p_conversation_id
    order by l.criado_em desc
    limit 20
  ) m;

  return query
  insert into public.conversas as c (tenant_id, conversation_id, contact_name, phone)
  values (p_tenant_id, p_conversation_id, p_contact_name, p_phone)
  on conflict (tenant_id, conversation_id) do update
    set contact_name  = coalesce(excluded.contact_name, c.contact_name),
        phone         = coalesce(excluded.phone, c.phone),
        -- 65: mensagem nova em conversa RESOLVIDA reabre (o Chatwoot tambem
        -- reabre). `ativo` e `pausado` ficam como estao.
        status        = case when c.status = 'resolvido' then 'ativo' else c.status end,
        atualizado_em = now()
  returning public.conversa_status_efetivo(c.status, c.pausado_em, c.motivo_pausa, v_janela),
            -- `pausado_em` CRU de proposito: e diagnostico, e mentir aqui
            -- esconderia justamente o carimbo que explica a decisao.
            c.pausado_em,
            v_historico;
end;
$function$;

commit;
