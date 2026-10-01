-- =====================================================================
-- Migração 78 — aprendizado automático a partir do atendimento humano
-- =====================================================================
-- Decisão do Felipe (01/10): o agente aprende sozinho com o que o ATENDENTE
-- da empresa responde, sem pedir confirmação a ninguém. O consentimento é
-- dado uma vez, no botão do painel — não a cada frase. A informação continua
-- vindo da empresa; o que sai do caminho é o pedágio.
--
-- O que esta migração cria:
--
--   1. `tenants.aprendizado_auto` (boolean, default FALSE) — o botão. É do
--      CLIENTE: entra na whitelist de `tenants_guard_colunas`, porque a base
--      de conhecimento é dele. Nasce desligado: ligar é ato, não omissão;
--
--   2. `kb_aprendizado` — uma linha por par (pergunta do cliente, resposta do
--      atendente) que o ciclo considerou. Ela existe por três razões, e
--      nenhuma é enfeite:
--        - IDEMPOTÊNCIA: o varredor roda a cada poucos minutos e não pode
--          reprocessar a mesma conversa;
--        - AUDITORIA: o cliente ligou um botão e passou a ter conteúdo que
--          ele não escreveu. Ele tem de poder ver o que entrou, de onde veio
--          e apagar. Sem isto "silencioso" vira "invisível", que é outra coisa;
--        - MEDIÇÃO: quantas respostas viraram base, quantas foram descartadas
--          e por quê — é o que diz se o ciclo funciona.
--
--   3. `api_agente_aprendizado_pendentes` / `api_agente_aprendizado_concluir`
--      — a superfície do serviço, que não lê tabela nenhuma direto;
--   4. `painel_aprendizado_recente` — o que a tela do cliente mostra.
--
-- O FILTRO NÃO MORA AQUI. Descartar resposta com dado pessoal ou que só vale
-- para um cliente ("no seu caso são 30 dias") é decisão de conteúdo e fica no
-- serviço, com teste. O banco guarda o veredito (`status`, `motivo`), para a
-- decisão ser auditável depois.
--
-- Rollback: 20261001120000_78_aprendizado_automatico_rollback.sql
-- =====================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. O botão
-- ---------------------------------------------------------------------------
alter table public.tenants
  add column if not exists aprendizado_auto boolean not null default false;

comment on column public.tenants.aprendizado_auto is
  'Aprendizado automatico: o agente transforma a resposta do atendente humano em conteudo da base, sem confirmacao. Do CLIENTE (whitelist do guard). Nasce desligado.';

-- A whitelist do guard ganha a coluna nova. `create or replace` de mesma
-- assinatura: o ACL não é tocado (a armadilha das migrações 40/41 é o DROP).
CREATE OR REPLACE FUNCTION public.tenants_guard_colunas()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if public.auth_is_super_admin() then
    return new;
  end if;

  if (to_jsonb(new) - '{system_prompt,agente_ativo,debounce_segundos,msg_midia_nao_suportada,msg_fora_escopo,horario_agente,aprendizado_auto,atualizado_em}'::text[])
     is distinct from
     (to_jsonb(old) - '{system_prompt,agente_ativo,debounce_segundos,msg_midia_nao_suportada,msg_fora_escopo,horario_agente,aprendizado_auto,atualizado_em}'::text[])
  then
    raise exception
      'Sem permissao: tenant_admin so pode alterar prompt, mensagens, debounce, agente_ativo, horario_agente e aprendizado_auto. Modelo, temperatura, tokens, slug, status e nome sao da agencia.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$
;

-- ---------------------------------------------------------------------------
-- 2. O que o ciclo aprendeu (e o que recusou)
-- ---------------------------------------------------------------------------
create table if not exists public.kb_aprendizado (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  conversation_id bigint not null,
  -- A chave de idempotência: a mensagem do atendente que originou o par.
  -- Partial unique por tenant: o mesmo id de mensagem existe em outra conta.
  mensagem_id     uuid not null references public.mensagens_log(id) on delete cascade,
  pergunta        text not null,
  resposta        text not null,
  -- `publicado` = virou chunk; `descartado` = o filtro recusou; `erro` = a
  -- ingestão falhou e vale tentar de novo.
  status          text not null default 'publicado',
  motivo          text,
  origem          text,              -- `auto:<id>` em kb_documentos, quando publicado
  criado_em       timestamptz not null default now(),
  constraint kb_aprendizado_status_valido check (status in ('publicado', 'descartado', 'erro'))
);

create unique index if not exists uq_kb_aprendizado_mensagem
  on public.kb_aprendizado (tenant_id, mensagem_id);
-- tenant_id primeiro, como manda a regra 3.
create index if not exists idx_kb_aprendizado_tenant_data
  on public.kb_aprendizado (tenant_id, criado_em desc);

comment on table public.kb_aprendizado is
  'Pares (pergunta do cliente, resposta do atendente) que o aprendizado automatico considerou: o que virou base, o que foi descartado e por que. Idempotencia do varredor e auditoria do cliente.';

alter table public.kb_aprendizado enable row level security;

-- Tabela nova em `public` nasce com TUDO liberado para anon (ALTER DEFAULT
-- PRIVILEGES deste projeto). Revogar vem ANTES de conceder, senão o grant é
-- decoração sobre objeto já público.
revoke all on public.kb_aprendizado from public;
revoke all on public.kb_aprendizado from anon;
revoke all on public.kb_aprendizado from authenticated;
revoke all on public.kb_aprendizado from service_role;
grant select on public.kb_aprendizado to authenticated;   -- só leitura: quem escreve é o serviço
grant select, insert, update, delete on public.kb_aprendizado to service_role;

drop policy if exists p_kb_aprendizado_leitura on public.kb_aprendizado;
create policy p_kb_aprendizado_leitura on public.kb_aprendizado
  for select to authenticated
  using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

-- ---------------------------------------------------------------------------
-- 3. A superfície do serviço
-- ---------------------------------------------------------------------------
-- Os pares ainda não processados de tenants com o botão LIGADO.
--
-- O par é: a fala do atendente (`fonte_tokens = 'humano'`, migração do serviço
-- de 01/10) e a pergunta que o agente resumiu ao transferir, no mesmo turno
-- imediatamente anterior daquela conversa. Sem transferência não há pergunta
-- formulada, e um texto solto do atendente não vira base — é por isso que o
-- `join` com o passo é INNER.
--
-- `p_silencio_min`: só entra conversa parada há esse tempo. Enquanto o
-- atendente está escrevendo, a resposta pode continuar na próxima mensagem.
drop function if exists public.api_agente_aprendizado_pendentes(integer, integer);
create or replace function public.api_agente_aprendizado_pendentes(p_silencio_min integer default 15, p_limite integer default 20)
returns table (
  tenant_id uuid, conversation_id bigint, mensagem_id uuid,
  pergunta text, resposta text, criado_em timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $$
  with fala as (
    select l.id, l.tenant_id, l.conversation_id, l.conteudo, l.criado_em
      from public.mensagens_log l
      join public.tenants t on t.id = l.tenant_id
     where t.aprendizado_auto
       and t.deletado_em is null
       and l.fonte_tokens = 'humano'
       and l.criado_em < now() - make_interval(mins => greatest(coalesce(p_silencio_min, 15), 1))
       -- nada depois dela naquela conversa: é a última palavra do atendimento
       and not exists (
         select 1 from public.mensagens_log l2
          where l2.tenant_id = l.tenant_id and l2.conversation_id = l.conversation_id
            and l2.criado_em > l.criado_em)
       and not exists (
         select 1 from public.kb_aprendizado a
          where a.tenant_id = l.tenant_id and a.mensagem_id = l.id)
  )
  select f.tenant_id, f.conversation_id, f.id,
         (select p.entrada->>'resumo'
            from public.agente_passos p
            join public.agente_turnos tu on tu.id = p.turno_id
           where tu.tenant_id = f.tenant_id
             and tu.conversation_id = f.conversation_id
             and p.nome = 'transferir_humano'
             and p.criado_em < f.criado_em
           order by p.criado_em desc
           limit 1) as pergunta,
         f.conteudo, f.criado_em
    from fala f
   where (select p.entrada->>'resumo'
            from public.agente_passos p
            join public.agente_turnos tu on tu.id = p.turno_id
           where tu.tenant_id = f.tenant_id
             and tu.conversation_id = f.conversation_id
             and p.nome = 'transferir_humano'
             and p.criado_em < f.criado_em
           order by p.criado_em desc
           limit 1) is not null
   order by f.criado_em
   limit greatest(coalesce(p_limite, 20), 1);
$$;

comment on function public.api_agente_aprendizado_pendentes(integer, integer) is
  'Pares (pergunta resumida na transferencia, resposta do atendente) ainda nao processados, de tenants com aprendizado_auto ligado. So conversa parada ha p_silencio_min.';

revoke all on function public.api_agente_aprendizado_pendentes(integer, integer) from public, anon, authenticated;
grant execute on function public.api_agente_aprendizado_pendentes(integer, integer) to service_role;
grant execute on function public.api_agente_aprendizado_pendentes(integer, integer) to n8n_agent;

-- O veredito. `on conflict do nothing`: dois ciclos concorrentes não duplicam.
drop function if exists public.api_agente_aprendizado_concluir(uuid, bigint, uuid, text, text, text, text, text);
create or replace function public.api_agente_aprendizado_concluir(
  p_tenant_id uuid, p_conversation_id bigint, p_mensagem_id uuid,
  p_pergunta text, p_resposta text, p_status text, p_motivo text default null, p_origem text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare v_id uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  insert into public.kb_aprendizado (tenant_id, conversation_id, mensagem_id, pergunta, resposta, status, motivo, origem)
  values (p_tenant_id, p_conversation_id, p_mensagem_id, coalesce(p_pergunta, ''), coalesce(p_resposta, ''), p_status, p_motivo, p_origem)
  on conflict (tenant_id, mensagem_id) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.api_agente_aprendizado_concluir(uuid, bigint, uuid, text, text, text, text, text) is
  'Grava o veredito do aprendizado automatico para um par. Idempotente por (tenant, mensagem).';

revoke all on function public.api_agente_aprendizado_concluir(uuid, bigint, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.api_agente_aprendizado_concluir(uuid, bigint, uuid, text, text, text, text, text) to service_role;
grant execute on function public.api_agente_aprendizado_concluir(uuid, bigint, uuid, text, text, text, text, text) to n8n_agent;

-- O DIÁLOGO que o modelo vai ler: da transferência até a fala do atendente que
-- fechou o atendimento. `fonte_tokens = 'humano'` marca quem é atendente — o
-- modelo precisa saber quem falou, senão trata a resposta do próprio agente
-- como se fosse da empresa.
--
-- A JANELA É RESOLVIDA AQUI, a partir do id da mensagem — e não recebida em
-- dois timestamps. Motivo medido em 01/10: `timestamptz` tem microssegundo e
-- o `Date` do JavaScript tem milissegundo. Levar o instante até o serviço e
-- trazê-lo de volta TRUNCA, e a mensagem-âncora (que é exatamente o limite
-- superior) cai fora da própria janela — a função devolvia zero linhas e o
-- ciclo descartava tudo com "diálogo curto demais", em silêncio. Instante que
-- nasce no banco e volta para o banco não passeia por outra precisão.
--
-- Nada de antes da transferência: é a conversa com o bot, que não tem
-- autoridade nenhuma para afirmar fato da empresa.
drop function if exists public.api_agente_aprendizado_dialogo(uuid, bigint, timestamptz, timestamptz);
drop function if exists public.api_agente_aprendizado_dialogo(uuid, uuid);
create or replace function public.api_agente_aprendizado_dialogo(p_tenant_id uuid, p_mensagem_id uuid)
returns table (direcao text, conteudo text, humano boolean, criado_em timestamptz)
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $$
  with ancora as (
    select l.conversation_id, l.criado_em
      from public.mensagens_log l
     where l.tenant_id = p_tenant_id and l.id = p_mensagem_id
  ), inicio as (
    select coalesce(
      (select p.criado_em
         from public.agente_passos p
         join public.agente_turnos tu on tu.id = p.turno_id
        where tu.tenant_id = p_tenant_id
          and tu.conversation_id = (select conversation_id from ancora)
          and p.nome = 'transferir_humano'
          and p.criado_em <= (select criado_em from ancora)
        order by p.criado_em desc
        limit 1),
      (select criado_em - interval '2 hours' from ancora)
    ) as desde
  )
  select l.direcao, l.conteudo, (l.fonte_tokens = 'humano') as humano, l.criado_em
    from public.mensagens_log l
   where l.tenant_id = p_tenant_id
     and l.conversation_id = (select conversation_id from ancora)
     and l.criado_em >= (select desde from inicio)
     and l.criado_em <= (select criado_em from ancora)
     and coalesce(btrim(l.conteudo), '') <> ''
   order by l.criado_em
   limit 60;
$$;

comment on function public.api_agente_aprendizado_dialogo(uuid, uuid) is
  'As falas do atendimento que termina na mensagem dada: da transferencia ate ela, com a marca de quem e atendente humano. A janela e resolvida aqui — timestamp que passa pelo JS perde microssegundo.';

revoke all on function public.api_agente_aprendizado_dialogo(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_agente_aprendizado_dialogo(uuid, uuid) to service_role;
grant execute on function public.api_agente_aprendizado_dialogo(uuid, uuid) to n8n_agent;

-- O job de ingestão que o serviço cria para publicar uma entrada aprendida.
-- O serviço não escreve em tabela: entra por aqui. `criado_por` fica NULO —
-- não houve usuário, e inventar um seria mentir na auditoria. A Edge Function
-- grava os chunks com `origem = 'texto:<id do job>'`, então o id devolvido é o
-- que liga a entrada da base à linha de `kb_aprendizado`.
drop function if exists public.api_agente_kb_job_texto(uuid, text);
create or replace function public.api_agente_kb_job_texto(p_tenant_id uuid, p_titulo text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare v_id uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  if coalesce(btrim(p_titulo), '') = '' then
    raise exception 'api_agente_kb_job_texto: titulo vazio' using errcode = '22023';
  end if;
  insert into public.jobs_ingestao (tenant_id, arquivo_nome, arquivo_path, tipo, status, criado_por)
  values (p_tenant_id, left(btrim(p_titulo), 200), null, 'texto', 'pendente', null)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.api_agente_kb_job_texto(uuid, text) is
  'Job de ingestao de TEXTO criado pelo servico (aprendizado automatico). criado_por nulo: nao houve usuario.';

revoke all on function public.api_agente_kb_job_texto(uuid, text) from public, anon, authenticated;
grant execute on function public.api_agente_kb_job_texto(uuid, text) to service_role;
grant execute on function public.api_agente_kb_job_texto(uuid, text) to n8n_agent;

-- ---------------------------------------------------------------------------
-- 4. O que o cliente vê
-- ---------------------------------------------------------------------------
create or replace function public.painel_aprendizado_recente(p_limite integer default 50)
returns table (
  id uuid, conversation_id bigint, pergunta text, resposta text,
  status text, motivo text, origem text, criado_em timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $$
  select a.id, a.conversation_id, a.pergunta, a.resposta, a.status, a.motivo, a.origem, a.criado_em
    from public.kb_aprendizado a
   where a.tenant_id = public.auth_tenant_id()
   order by a.criado_em desc
   limit greatest(coalesce(p_limite, 50), 1);
$$;

comment on function public.painel_aprendizado_recente(integer) is
  'O que o aprendizado automatico guardou (e recusou) para o tenant do JWT. Leitura da tela do cliente.';

revoke all on function public.painel_aprendizado_recente(integer) from public, anon;
grant execute on function public.painel_aprendizado_recente(integer) to authenticated;
grant execute on function public.painel_aprendizado_recente(integer) to service_role;

commit;
