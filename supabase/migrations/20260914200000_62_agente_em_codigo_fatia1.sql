-- =====================================================================
-- 62. O agente em código — fatia 1, o lado do banco
-- =====================================================================
--
-- Desenho: docs/DESENHO-AGENTE-EM-CODIGO.md (§1 fila, §3b memória e debounce,
-- §6 trace com retenção, §3 `agente_runtime`). Esta migração NÃO liga nada:
-- todo tenant nasce com `agente_runtime = 'n8n'` (o teste conta antes x
-- depois), a fila fica vazia e o n8n continua atendendo exatamente como hoje.
-- O serviço em código, quando existir, só recebe uma caixa depois que o bot
-- daquela conta for apontado para ele — ato humano, fora desta migração.
--
-- ---------------------------------------------------------------------
-- A ÚNICA PORTA CONTINUA SENDO FUNÇÃO
-- ---------------------------------------------------------------------
-- `n8n_agent` não tem grant de tabela nenhum e não bypassa RLS (medido em
-- 14/09/2026): tudo que ele faz hoje passa por `api_n8n_*` SECURITY DEFINER.
-- O agente em código conecta com o MESMO role e segue o mesmo regime: as
-- tabelas novas nascem com RLS, `revoke all` de todo mundo, `select` para
-- `authenticated` (o painel lê) e `service_role`; a escrita é só por
-- `api_agente_*`. Cada função: `revoke` antes do `grant`, e os DOIS grants
-- (`service_role` E `n8n_agent`) — a armadilha das 40/41.
--
-- ---------------------------------------------------------------------
-- A FILA SUBSTITUI O REDIS DO DEBOUNCE (§3b)
-- ---------------------------------------------------------------------
-- Cada mensagem entra com `executar_em = now() + debounce`. Um worker
-- reivindica pela data (`for update skip locked`, global) e então pergunta à
-- conversa o que fazer — `api_agente_turno_da_conversa`, sob
-- `pg_advisory_xact_lock` da conversa:
--
--   'desistir'   há mensagem MAIS NOVA (por `seq`, a ordem de chegada)
--                pendente nesta conversa: a mais nova responde por todas (é
--                o `Ultima Mensagem?` do n8n, sem
--                GET/GET/DEL — e sem a brecha entre o GET e o LPOP, porque
--                não há pop: as linhas mudam de estado numa transação);
--   'adiar'      outro turno desta conversa está em andamento (linha
--                `processando` com lease viva): esta volta para a fila com
--                `executar_em` adiado. É o "um turno por vez por conversa"
--                que o n8n nunca deu;
--   'responder'  esta e TODAS as pendentes da conversa viram `processando`
--                deste worker; o turno responde por todas.
--
-- Lease: `processando` com `reivindicada_em` mais velha que o lease é de um
-- worker que morreu; `api_agente_reivindicar` a devolve à fila com
-- `tentativas + 1`. Restart no meio do debounce NÃO perde mensagem — a
-- linha está no Postgres, não num `setTimeout`.
--
-- ÍNDICE SEM `tenant_id` NA FRENTE, DE PROPÓSITO E DECLARADO: a reivindicação
-- é GLOBAL (um worker atende todos os tenants), então
-- `idx_agente_fila_pendente (executar_em) where estado = 'pendente'` não tem
-- tenant. A regra 3 do CLAUDE.md é sobre índice para consulta escopada por
-- tenant; esta consulta não é. Toda consulta escopada (por conversa) usa
-- `idx_agente_fila_tenant_conversa`, que tem.
--
-- ---------------------------------------------------------------------
-- A MEMÓRIA VEM DE `mensagens_log` (§3b), COM A REGRA DO INTERVALO
-- ---------------------------------------------------------------------
-- `api_agente_memoria` devolve as últimas `2 * p_janela_pares` mensagens da
-- conversa, depois do corte (`conversas.memoria_cortada_em`) e depois do
-- ÚLTIMO INTERVALO maior que `p_silencio_min` entre turnos consecutivos —
-- e vazia se o último turno for mais velho que o silêncio. É a reprodução
-- do TTL deslizante por escrita do Redis (commit 5e717f4), medida entre
-- turnos e não "agora − 40 min", que traria tudo de volta na mensagem que
-- acabou de chegar. O texto é o PÓS-portão (`conteudo`), nunca o bruto —
-- decisão da §3b, e o teste cruza a saída desta função com o modelo JS
-- (`tests/lib/memoria-modelo.mjs`) sobre o mesmo log.
--
-- `entrada` no log de hoje vem como literal de array do Postgres (`{oi}`,
-- `{"quero 2 bolos"}`) — é o driver do n8n serializando a lista do debounce.
-- `agente_texto_entrada` desfaz isso (junta com quebra de linha, que é o que
-- o agent recebe como prompt) e devolve o texto cru se não for array. O
-- código novo grava texto simples; a conversão existe para a transição.
--
-- ---------------------------------------------------------------------
-- TRACE COM RETENÇÃO DECIDIDA (§6)
-- ---------------------------------------------------------------------
--   agente_prompts   uma linha por (tenant, hash) — para sempre
--   agente_turnos    uma linha leve por turno — para sempre (auditoria)
--   agente_passos    cada chamada/tool/portão/envio — 30 dias; retorno de
--                    tool truncado a 16 KB e entrada a 4 KB NA ESCRITA
--                    (`api_agente_passo`); o bruto do modelo (`tipo =
--                    'modelo'`) NÃO é truncado: é a evidência da fabricação
--   api_agente_varrer_passos(dias)  quem limpa é o próprio agente, e a
--                    contagem volta para ele gravar num turno de manutenção
--
-- ---------------------------------------------------------------------
-- `tenants.agente_runtime` NASCE FORA DA LISTA BRANCA DO GUARD
-- ---------------------------------------------------------------------
-- `tenants_guard_colunas` compara `to_jsonb(new) - <lista branca>` com
-- `to_jsonb(old) - <lista branca>`; coluna fora da lista é imutável para
-- `tenant_admin` (`42501`). Esta migração NÃO toca na lista — o teste afirma
-- que a coluna não está nela e que o update sem claim leva 42501. Um cliente
-- não troca o próprio runtime.
--
-- ROLLBACK: 20260914200000_62_agente_em_codigo_fatia1_rollback.sql — aborta
-- se algum tenant estiver em 'codigo' ou se houver turno gravado.
-- =====================================================================

begin;

-- =====================================================================
-- 1. QUEM ATENDE O TENANT
-- =====================================================================
alter table public.tenants
  add column if not exists agente_runtime text not null default 'n8n';

alter table public.tenants
  drop constraint if exists tenants_agente_runtime_valido;
alter table public.tenants
  add constraint tenants_agente_runtime_valido
  check (agente_runtime in ('n8n', 'codigo'));

comment on column public.tenants.agente_runtime is
  'Quem atende as mensagens deste tenant: n8n (o workflow) ou codigo (o servico agente/). Agencia-only pelo guard; o painel usa para chamar o "limpar memoria" certo e o alarme de agente mudo usa para saber quem vigiar.';

-- =====================================================================
-- 2. O CORTE DA MEMÓRIA
-- =====================================================================
alter table public.conversas
  add column if not exists memoria_cortada_em timestamptz;

comment on column public.conversas.memoria_cortada_em is
  'Limpar memoria no agente em codigo: a memoria e montada de mensagens_log a partir deste instante. Nada e apagado.';

-- =====================================================================
-- 3. A FILA
-- =====================================================================
create table if not exists public.agente_fila (
  id               uuid primary key default gen_random_uuid(),
  -- ORDEM DE CHEGADA. "Mais nova" e por `seq`, nunca por `executar_em` (o
  -- 'adiar' empurra `executar_em` para o futuro e faria a mais VELHA parecer
  -- mais nova — o teste pegou isso na primeira execucao) nem por `criado_em`
  -- (duas mensagens na mesma transacao tem o mesmo now()).
  seq              bigint generated always as identity,
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  conversation_id  bigint not null,
  -- O que o turno precisa e NADA mais: texto/anexo/ids do Chatwoot, ja
  -- redigido pelo receptor (sem telefone, sem nome do contato).
  mensagem         jsonb not null,
  estado           text not null default 'pendente',
  executar_em      timestamptz not null,
  tentativas       integer not null default 0,
  reivindicada_por text,
  reivindicada_em  timestamptz,
  turno_id         uuid,
  erro             text,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  constraint agente_fila_estado_valido
    check (estado in ('pendente', 'processando', 'concluida', 'descartada', 'falhou'))
);

create index if not exists idx_agente_fila_tenant_conversa
  on public.agente_fila (tenant_id, conversation_id, criado_em);
-- GLOBAL, de proposito (ver cabecalho): a reivindicacao atende todos os tenants.
create index if not exists idx_agente_fila_pendente
  on public.agente_fila (executar_em) where estado = 'pendente';
create index if not exists idx_agente_fila_processando
  on public.agente_fila (reivindicada_em) where estado = 'processando';

drop trigger if exists trg_agente_fila_upd on public.agente_fila;
create trigger trg_agente_fila_upd
  before update on public.agente_fila
  for each row execute function public.set_atualizado_em();

alter table public.agente_fila enable row level security;
drop policy if exists p_agente_fila_leitura on public.agente_fila;
create policy p_agente_fila_leitura on public.agente_fila
  for select using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

revoke all on public.agente_fila from public;
revoke all on public.agente_fila from anon;
revoke all on public.agente_fila from authenticated;
revoke all on public.agente_fila from service_role;
grant select on public.agente_fila to authenticated;
grant select on public.agente_fila to service_role;

-- =====================================================================
-- 4. O TRACE
-- =====================================================================
create table if not exists public.agente_prompts (
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  hash          text not null,
  texto         text not null,
  versao_codigo text not null,
  criado_em     timestamptz not null default now(),
  primary key (tenant_id, hash)
);

create table if not exists public.agente_turnos (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants (id) on delete cascade,
  conversation_id         bigint not null,
  fila_id                 uuid,
  acao                    text,
  perfil                  text,
  modelo                  text,
  prompt_hash             text,
  status                  text not null default 'aberto',
  usage_entrada           integer,
  usage_saida             integer,
  chamadas_modelo         integer,
  tools_chamadas          integer,
  portao_veredito         text,
  mensagens_log_saida_id  uuid,
  erro                    text,
  iniciado_em             timestamptz not null default now(),
  concluido_em            timestamptz,
  constraint agente_turnos_status_valido
    check (status in ('aberto', 'ok', 'falhou', 'descartado', 'manutencao'))
);

create index if not exists idx_agente_turnos_tenant_data
  on public.agente_turnos (tenant_id, iniciado_em desc);
create index if not exists idx_agente_turnos_tenant_conversa
  on public.agente_turnos (tenant_id, conversation_id, iniciado_em desc);

create table if not exists public.agente_passos (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  turno_id    uuid not null references public.agente_turnos (id) on delete cascade,
  ordem       integer not null,
  tipo        text not null,
  nome        text not null,
  entrada     jsonb,
  saida       jsonb,
  erro        text,
  duracao_ms  integer,
  criado_em   timestamptz not null default now(),
  constraint agente_passos_tipo_valido
    check (tipo in ('entrada', 'memoria', 'modelo', 'tool', 'portao', 'envio', 'registro', 'falha')),
  constraint agente_passos_turno_ordem unique (turno_id, ordem)
);

create index if not exists idx_agente_passos_tenant_turno
  on public.agente_passos (tenant_id, turno_id, ordem);
-- A varredura de retencao e por data; tenant primeiro porque ela roda por tenant.
create index if not exists idx_agente_passos_tenant_data
  on public.agente_passos (tenant_id, criado_em);

do $$
declare t text;
begin
  foreach t in array array['agente_prompts', 'agente_turnos', 'agente_passos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists p_%s_leitura on public.%I', t, t);
    execute format('create policy p_%s_leitura on public.%I for select using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id())', t, t);
    execute format('revoke all on public.%I from public', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
    execute format('revoke all on public.%I from service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
end $$;

-- =====================================================================
-- 5. AS FUNÇÕES — a porta do agente em código
-- =====================================================================

-- ---------------------------------------------------------------------
-- 5.1 api_agente_runtime
-- ---------------------------------------------------------------------
drop function if exists public.api_agente_runtime(uuid);
create or replace function public.api_agente_runtime(p_tenant_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select t.agente_runtime from public.tenants t where t.id = p_tenant_id and t.deletado_em is null;
$function$;

-- ---------------------------------------------------------------------
-- 5.2 api_agente_enfileirar
-- ---------------------------------------------------------------------
drop function if exists public.api_agente_enfileirar(uuid, bigint, jsonb, integer);
create or replace function public.api_agente_enfileirar(
  p_tenant_id uuid, p_conversation_id bigint, p_mensagem jsonb, p_debounce_segundos integer)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  if p_conversation_id is null then
    raise exception 'api_agente: p_conversation_id e obrigatorio' using errcode = '22023';
  end if;
  if p_mensagem is null or jsonb_typeof(p_mensagem) <> 'object' then
    raise exception 'api_agente: p_mensagem tem de ser um objeto' using errcode = '22023';
  end if;

  insert into public.agente_fila (tenant_id, conversation_id, mensagem, executar_em)
  values (p_tenant_id, p_conversation_id, p_mensagem,
          now() + make_interval(secs => greatest(coalesce(p_debounce_segundos, 0), 0)))
  returning id into v_id;
  return v_id;
end;
$function$;

-- ---------------------------------------------------------------------
-- 5.3 api_agente_reivindicar — GLOBAL, por data, skip locked
-- ---------------------------------------------------------------------
-- Devolve linhas pendentes vencidas E linhas `processando` cujo lease venceu
-- (worker morto), estas com `tentativas + 1`. Quem reivindicou ainda nao
-- "tem" a conversa: isso e o passo seguinte.
drop function if exists public.api_agente_reivindicar(text, integer, integer);
create or replace function public.api_agente_reivindicar(
  p_worker text, p_limite integer default 10, p_lease_minutos integer default 5)
returns setof public.agente_fila
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(btrim(p_worker), '') = '' then
    raise exception 'api_agente: p_worker e obrigatorio' using errcode = '22023';
  end if;

  return query
  with alvo as (
    select f.id
      from public.agente_fila f
     where (f.estado = 'pendente' and f.executar_em <= now())
        or (f.estado = 'processando'
            and f.reivindicada_em < now() - make_interval(mins => greatest(coalesce(p_lease_minutos, 5), 1)))
     order by f.executar_em
     limit greatest(coalesce(p_limite, 10), 1)
       for update skip locked
  )
  update public.agente_fila f
     set estado          = 'processando',
         reivindicada_por = p_worker,
         reivindicada_em  = now(),
         tentativas       = case when f.estado = 'processando' then f.tentativas + 1 else f.tentativas end
    from alvo
   where f.id = alvo.id
  returning f.*;
end;
$function$;

-- ---------------------------------------------------------------------
-- 5.4 api_agente_turno_da_conversa — a decisao do debounce, sob lock
-- ---------------------------------------------------------------------
drop function if exists public.api_agente_turno_da_conversa(uuid, bigint, uuid, text, integer);
create or replace function public.api_agente_turno_da_conversa(
  p_tenant_id uuid, p_conversation_id bigint, p_fila_id uuid, p_worker text,
  p_lease_minutos integer default 5)
returns table(decisao text, fila_ids uuid[], mensagens jsonb)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_minha     public.agente_fila%rowtype;
  v_ids       uuid[];
  v_msgs      jsonb;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  -- UM TURNO POR VEZ POR CONVERSA: a decisao inteira roda sob o lock da
  -- conversa; outro worker na mesma conversa espera aqui.
  perform pg_advisory_xact_lock(hashtext(p_tenant_id::text || ':' || p_conversation_id::text));

  select * into v_minha from public.agente_fila f
   where f.id = p_fila_id and f.tenant_id = p_tenant_id and f.conversation_id = p_conversation_id
     for update;
  if v_minha.id is null then
    raise exception 'api_agente: fila % nao e desta conversa/tenant', p_fila_id using errcode = '22023';
  end if;
  if v_minha.estado <> 'processando' or v_minha.reivindicada_por is distinct from p_worker then
    raise exception 'api_agente: fila % nao esta reivindicada por %', p_fila_id, p_worker using errcode = '55P03';
  end if;

  -- 'desistir': ha mensagem MAIS NOVA (chegou depois: seq maior) pendente —
  -- ela responde por todas.
  if exists (select 1 from public.agente_fila f
              where f.tenant_id = p_tenant_id and f.conversation_id = p_conversation_id
                and f.estado = 'pendente' and f.seq > v_minha.seq) then
    update public.agente_fila f
       set estado = 'pendente', reivindicada_por = null, reivindicada_em = null
     where f.id = p_fila_id;
    return query select 'desistir'::text, array[]::uuid[], '[]'::jsonb;
    return;
  end if;

  -- 'adiar': outro turno desta conversa em andamento, com lease viva.
  if exists (select 1 from public.agente_fila f
              where f.tenant_id = p_tenant_id and f.conversation_id = p_conversation_id
                and f.estado = 'processando' and f.id <> p_fila_id
                and f.reivindicada_em >= now() - make_interval(mins => greatest(coalesce(p_lease_minutos, 5), 1))) then
    update public.agente_fila f
       set estado = 'pendente', reivindicada_por = null, reivindicada_em = null,
           executar_em = now() + interval '10 seconds'
     where f.id = p_fila_id;
    return query select 'adiar'::text, array[]::uuid[], '[]'::jsonb;
    return;
  end if;

  -- 'responder': esta e todas as pendentes da conversa, em ordem de chegada.
  with minhas as (
    update public.agente_fila f
       set estado = 'processando', reivindicada_por = p_worker, reivindicada_em = now()
     where f.tenant_id = p_tenant_id and f.conversation_id = p_conversation_id
       and (f.id = p_fila_id or f.estado = 'pendente')
    returning f.id, f.mensagem, f.seq
  )
  select array_agg(m.id order by m.seq), jsonb_agg(m.mensagem order by m.seq)
    into v_ids, v_msgs
    from minhas m;

  return query select 'responder'::text, coalesce(v_ids, array[]::uuid[]), coalesce(v_msgs, '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------
-- 5.5 api_agente_concluir
-- ---------------------------------------------------------------------
drop function if exists public.api_agente_concluir(uuid, uuid[], text, uuid, text);
create or replace function public.api_agente_concluir(
  p_tenant_id uuid, p_fila_ids uuid[], p_estado text, p_turno_id uuid default null, p_erro text default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_n integer;
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  if p_estado not in ('concluida', 'descartada', 'falhou') then
    raise exception 'api_agente: estado final invalido: %', p_estado using errcode = '22023';
  end if;
  update public.agente_fila f
     set estado = p_estado, turno_id = coalesce(p_turno_id, f.turno_id),
         erro = left(coalesce(p_erro, ''), 2000)
   where f.tenant_id = p_tenant_id and f.id = any(coalesce(p_fila_ids, array[]::uuid[]))
     and f.estado = 'processando';
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- ---------------------------------------------------------------------
-- 5.6 api_agente_prompt_registrar / turno_abrir / passo / turno_fechar
-- ---------------------------------------------------------------------
drop function if exists public.api_agente_prompt_registrar(uuid, text, text, text);
create or replace function public.api_agente_prompt_registrar(
  p_tenant_id uuid, p_hash text, p_texto text, p_versao_codigo text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  if coalesce(btrim(p_hash), '') = '' then
    raise exception 'api_agente: p_hash e obrigatorio' using errcode = '22023';
  end if;
  insert into public.agente_prompts (tenant_id, hash, texto, versao_codigo)
  values (p_tenant_id, p_hash, coalesce(p_texto, ''), coalesce(p_versao_codigo, ''))
  on conflict (tenant_id, hash) do nothing;
  return found;
end;
$function$;

drop function if exists public.api_agente_turno_abrir(uuid, bigint, uuid, text, text, text, text);
create or replace function public.api_agente_turno_abrir(
  p_tenant_id uuid, p_conversation_id bigint, p_fila_id uuid,
  p_acao text, p_perfil text, p_modelo text, p_prompt_hash text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  insert into public.agente_turnos (tenant_id, conversation_id, fila_id, acao, perfil, modelo, prompt_hash)
  values (p_tenant_id, p_conversation_id, p_fila_id, p_acao, p_perfil, p_modelo, p_prompt_hash)
  returning id into v_id;
  return v_id;
end;
$function$;

-- Truncamento NA ESCRITA (§6): saida a 16 KB e entrada a 4 KB, exceto o bruto
-- do modelo. Quando trunca, o jsonb vira { _truncado: true, texto: ... } para
-- ninguem ler um JSON pela metade como se fosse inteiro.
drop function if exists public.api_agente_passo(uuid, uuid, integer, text, text, jsonb, jsonb, text, integer);
create or replace function public.api_agente_passo(
  p_tenant_id uuid, p_turno_id uuid, p_ordem integer, p_tipo text, p_nome text,
  p_entrada jsonb default null, p_saida jsonb default null, p_erro text default null, p_duracao_ms integer default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id      uuid;
  v_entrada jsonb := p_entrada;
  v_saida   jsonb := p_saida;
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  if not exists (select 1 from public.agente_turnos t where t.id = p_turno_id and t.tenant_id = p_tenant_id) then
    raise exception 'api_agente: turno % nao e deste tenant', p_turno_id using errcode = '22023';
  end if;

  if v_entrada is not null and length(v_entrada::text) > 4096 then
    v_entrada := jsonb_build_object('_truncado', true, 'texto', left(v_entrada::text, 4096));
  end if;
  if p_tipo <> 'modelo' and v_saida is not null and length(v_saida::text) > 16384 then
    v_saida := jsonb_build_object('_truncado', true, 'texto', left(v_saida::text, 16384));
  end if;

  insert into public.agente_passos (tenant_id, turno_id, ordem, tipo, nome, entrada, saida, erro, duracao_ms)
  values (p_tenant_id, p_turno_id, p_ordem, p_tipo, p_nome, v_entrada, v_saida, left(p_erro, 2000), p_duracao_ms)
  returning id into v_id;
  return v_id;
end;
$function$;

drop function if exists public.api_agente_turno_fechar(uuid, uuid, text, integer, integer, integer, integer, text, uuid, text);
create or replace function public.api_agente_turno_fechar(
  p_tenant_id uuid, p_turno_id uuid, p_status text,
  p_usage_entrada integer default null, p_usage_saida integer default null,
  p_chamadas_modelo integer default null, p_tools_chamadas integer default null,
  p_portao_veredito text default null, p_mensagens_log_saida_id uuid default null,
  p_erro text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  if p_status not in ('ok', 'falhou', 'descartado', 'manutencao') then
    raise exception 'api_agente: status final invalido: %', p_status using errcode = '22023';
  end if;
  update public.agente_turnos t
     set status = p_status, usage_entrada = p_usage_entrada, usage_saida = p_usage_saida,
         chamadas_modelo = p_chamadas_modelo, tools_chamadas = p_tools_chamadas,
         portao_veredito = p_portao_veredito, mensagens_log_saida_id = p_mensagens_log_saida_id,
         erro = left(p_erro, 2000), concluido_em = now()
   where t.id = p_turno_id and t.tenant_id = p_tenant_id and t.status = 'aberto';
  return found;
end;
$function$;

-- ---------------------------------------------------------------------
-- 5.7 A memoria
-- ---------------------------------------------------------------------
-- Desfaz o literal de array do log de hoje (`{oi}` -> `oi`; varios -> um por
-- linha). Texto que nao e array volta cru. Pura e IMMUTABLE.
drop function if exists public.agente_texto_entrada(text);
create or replace function public.agente_texto_entrada(p_conteudo text)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
begin
  if p_conteudo is null then return null; end if;
  if p_conteudo ~ '^\{.*\}$' then
    begin
      return array_to_string(p_conteudo::text[], E'\n');
    exception when others then
      return p_conteudo;
    end;
  end if;
  return p_conteudo;
end;
$function$;

drop function if exists public.api_agente_memoria(uuid, bigint, integer, integer);
create or replace function public.api_agente_memoria(
  p_tenant_id uuid, p_conversation_id bigint,
  p_silencio_min integer default 40, p_janela_pares integer default 20)
returns table(papel text, texto text, criado_em timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_corte    timestamptz;
  v_inicio   timestamptz;
  v_ultimo   timestamptz;
  v_silencio interval := make_interval(mins => greatest(coalesce(p_silencio_min, 40), 1));
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  select c.memoria_cortada_em into v_corte
    from public.conversas c
   where c.tenant_id = p_tenant_id and c.conversation_id = p_conversation_id;

  -- Turnos = instantes distintos do log depois do corte. O inicio da memoria e
  -- o ultimo turno cuja distancia ao anterior passa do silencio; sem nenhum,
  -- e o primeiro turno.
  with turnos as (
    select distinct m.criado_em as t
      from public.mensagens_log m
     where m.tenant_id = p_tenant_id and m.conversation_id = p_conversation_id
       and (v_corte is null or m.criado_em > v_corte)
  ), lacunas as (
    select t, t - lag(t) over (order by t) as lacuna from turnos
  )
  select coalesce((select max(t) from lacunas where lacuna > v_silencio), (select min(t) from turnos)),
         (select max(t) from turnos)
    into v_inicio, v_ultimo;

  if v_ultimo is null or now() - v_ultimo > v_silencio then
    return;
  end if;

  return query
  with vivas as (
    select case when m.direcao = 'entrada' then 'human' else 'ai' end as papel,
           case when m.direcao = 'entrada' then public.agente_texto_entrada(m.conteudo) else m.conteudo end as texto,
           m.criado_em,
           case when m.direcao = 'entrada' then 0 else 1 end as ordem_no_turno
      from public.mensagens_log m
     where m.tenant_id = p_tenant_id and m.conversation_id = p_conversation_id
       and m.criado_em >= v_inicio
       and (v_corte is null or m.criado_em > v_corte)
       and m.direcao in ('entrada', 'saida')
  ), ultimas as (
    select v.* from vivas v
     order by v.criado_em desc, v.ordem_no_turno desc
     limit greatest(coalesce(p_janela_pares, 20), 1) * 2
  )
  select u.papel, u.texto, u.criado_em
    from ultimas u
   order by u.criado_em, u.ordem_no_turno;
end;
$function$;

drop function if exists public.api_agente_memoria_cortar(uuid, bigint);
create or replace function public.api_agente_memoria_cortar(p_tenant_id uuid, p_conversation_id bigint)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  insert into public.conversas (tenant_id, conversation_id, status, memoria_cortada_em)
  values (p_tenant_id, p_conversation_id, 'ativo', now())
  on conflict (tenant_id, conversation_id)
  do update set memoria_cortada_em = now();
  return true;
end;
$function$;

-- ---------------------------------------------------------------------
-- 5.8 api_agente_varrer_passos — a retencao (global; o agente chama 1x/dia)
-- ---------------------------------------------------------------------
drop function if exists public.api_agente_varrer_passos(integer);
create or replace function public.api_agente_varrer_passos(p_dias integer default 30)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_n integer;
begin
  delete from public.agente_passos p
   where p.criado_em < now() - make_interval(days => greatest(coalesce(p_dias, 30), 1));
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

-- =====================================================================
-- 6. GRANTS — revoke ANTES do grant, os DOIS roles, pela lista de tipos
-- =====================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.api_agente_runtime(uuid)',
    'public.api_agente_enfileirar(uuid, bigint, jsonb, integer)',
    'public.api_agente_reivindicar(text, integer, integer)',
    'public.api_agente_turno_da_conversa(uuid, bigint, uuid, text, integer)',
    'public.api_agente_concluir(uuid, uuid[], text, uuid, text)',
    'public.api_agente_prompt_registrar(uuid, text, text, text)',
    'public.api_agente_turno_abrir(uuid, bigint, uuid, text, text, text, text)',
    'public.api_agente_passo(uuid, uuid, integer, text, text, jsonb, jsonb, text, integer)',
    'public.api_agente_turno_fechar(uuid, uuid, text, integer, integer, integer, integer, text, uuid, text)',
    'public.api_agente_memoria(uuid, bigint, integer, integer)',
    'public.api_agente_memoria_cortar(uuid, bigint)',
    'public.api_agente_varrer_passos(integer)',
    'public.agente_texto_entrada(text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
    execute format('grant execute on function %s to n8n_agent', f);
  end loop;
end $$;

commit;
