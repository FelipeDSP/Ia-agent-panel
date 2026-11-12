-- =============================================================================
-- 90 — A ABERTURA QUE VEM DE FORA DEIXA DE SER "UM ATENDENTE ASSUMIU"
-- =============================================================================
--
-- O PROBLEMA, medido em produção. Um sistema de prospecção fria (projeto do
-- Felipe, fora deste repo) manda a PRIMEIRA mensagem pelo WhatsApp Web, no
-- mesmo número do cliente. O eco dessa mensagem chega ao serviço como
-- `outgoing` de um atendente, cai no ramo `humano` (`classificar.ts:29`) e:
--
--   1. PAUSA a conversa (`pausa_expira_minutos`, 30 por padrão);
--   2. DESCARTA o que estiver na fila daquela conversa
--      (`api_agente_descartar_pendentes`).
--
-- Resultado observado no `uau-foods` em 11/11 às 15:20: três linhas
-- `pausada_na_entrada / mensagem_humana` — a resposta do lead chegando dentro
-- da janela e morrendo no portão de entrada. O agente fica mudo exatamente
-- quando o lead responde, e quando volta não tem o texto da pergunta que foi
-- feita.
--
-- A REGRA DE PAUSA CONTINUA, e tem de continuar: quando o operador digita pelo
-- celular, o agente deve mesmo se calar. O que falta é o sistema externo poder
-- DIZER, antes de enviar, que a próxima saída é dele.
--
-- -----------------------------------------------------------------------------
-- POR QUE UMA RESERVA, E NÃO UM MARCADOR NO TEXTO
-- -----------------------------------------------------------------------------
-- Três razões, nesta ordem de peso:
--
--   - NO MOMENTO DA CHAMADA A CONVERSA NÃO EXISTE. Quem a cria é o eco, via
--     `api_n8n_conversa_sync`. Não há `conversation_id` para carimbar. A chave
--     que existe antes do envio é o TELEFONE;
--   - O ECO PODE CHEGAR SEM O TEXTO. Gravar a partir dele seria depender de um
--     campo que já suspeitamos vir vazio; o texto da reserva é o que o sistema
--     externo DIZ que enviou, e é o que o agente precisa ler;
--   - A ABERTURA VAI EM DUAS PARTES. Casar reserva com UMA mensagem faria a
--     primeira parte consumir a reserva e a SEGUNDA pausar. Por isso a reserva
--     vale por uma JANELA de minutos, não por uma mensagem.
--
-- -----------------------------------------------------------------------------
-- O QUE A RESERVA NÃO É
-- -----------------------------------------------------------------------------
-- Não é opt-in por tenant e não precisa ser: reserva só nasce por chamada
-- autenticada com o segredo do serviço (`ABERTURA_SECRET`, no Coolify). Sem
-- chamada, nenhuma linha existe e o ramo `humano` se comporta exatamente como
-- hoje — byte a byte, para `emporio`, `ceejaar`, `acqua` e qualquer outro.
--
-- E o lado do serviço consulta isto dentro de try/catch: QUALQUER falha aqui
-- cai no comportamento de hoje (pausar). Falhar fechado, não aberto.
--
-- -----------------------------------------------------------------------------
-- `fonte = 'abertura'`, NUNCA `'humano'`
-- -----------------------------------------------------------------------------
-- `api_agente_aprendizado_pendentes` (78) seleciona candidatos por
-- `fonte_tokens = 'humano'`. Gravar a abertura como `'humano'` faria o pitch de
-- prospecção virar base de conhecimento sozinho em todo tenant com
-- `aprendizado_auto` ligado. Com a fonte nova ela fica de fora de graça — e o
-- teste afirma isso, porque "de graça" é exatamente o tipo de coisa que para de
-- valer quando alguém mexe no filtro.
--
-- -----------------------------------------------------------------------------
-- ACESSOS
-- -----------------------------------------------------------------------------
-- Tabela nova em `public` nasce com `arwdDxtm` para `anon` por
-- `ALTER DEFAULT PRIVILEGES` deste projeto (CLAUDE.md). Por isso o `revoke`
-- vem ANTES do `grant`, e o `grant` é o mínimo: o painel LÊ (para a agência
-- poder conferir), o serviço escreve pelas funções `SECURITY DEFINER`.
--
-- ROLLBACK: 20261112140000_90_abertura_externa_rollback.sql — dropa as duas
-- funções e a tabela. É reversível de verdade: a tabela só guarda reservas de
-- prospecção, nada que o painel ou o agente precisem para atender.
-- REEXECUTÁVEL.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. A TABELA
-- -----------------------------------------------------------------------------
create table if not exists public.aberturas_externas (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  telefone        text not null,
  texto           text not null,
  contexto        jsonb,
  conversation_id bigint,
  criado_em       timestamptz not null default now(),
  registrada_em   timestamptz,
  constraint aberturas_externas_telefone_check check (telefone ~ '^[0-9]{8,15}$'),
  constraint aberturas_externas_texto_check    check (length(btrim(texto)) between 1 and 4000)
);

comment on table public.aberturas_externas is
  'Reservas de abertura de prospecção (90). Um sistema externo avisa, ANTES de '
  'enviar pelo WhatsApp, que a proxima saida para aquele telefone e dele — para '
  'o eco nao ser tratado como "um atendente assumiu". Sem reserva, nada muda.';
comment on column public.aberturas_externas.telefone is
  'So digitos, com DDI. E a chave que existe ANTES de a conversa ser criada.';
comment on column public.aberturas_externas.registrada_em is
  'Quando o texto virou linha de `mensagens_log`. Nulo = ainda nao virou. A '
  'reserva continua valendo na janela depois disso (a abertura vai em 2 partes).';

-- `tenant_id` primeiro: regra 3 do CLAUDE.md. Serve para "reservas do tenant X"
-- e para a busca real, que é (tenant, telefone, recente primeiro).
create index if not exists idx_aberturas_externas_busca
  on public.aberturas_externas (tenant_id, telefone, criado_em desc);

-- IDEMPOTÊNCIA. O job do outro lado tem retry com backoff: a mesma chamada não
-- pode criar duas reservas. A chave é (tenant, telefone, texto) e só vale
-- enquanto a reserva não foi registrada — depois disso uma abertura NOVA para o
-- mesmo lead com o mesmo texto é legítima.
create unique index if not exists uq_aberturas_externas_pendente
  on public.aberturas_externas (tenant_id, telefone, md5(texto))
  where registrada_em is null;

alter table public.aberturas_externas enable row level security;

drop policy if exists p_aberturas_externas_select on public.aberturas_externas;
create policy p_aberturas_externas_select on public.aberturas_externas
  for select using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

revoke all on public.aberturas_externas from public;
revoke all on public.aberturas_externas from anon;
revoke all on public.aberturas_externas from authenticated;
revoke all on public.aberturas_externas from service_role;
grant select on public.aberturas_externas to authenticated;
grant select on public.aberturas_externas to service_role;

-- -----------------------------------------------------------------------------
-- 2. REGISTRAR A RESERVA (o sistema externo, ANTES de enviar)
-- -----------------------------------------------------------------------------
drop function if exists public.api_agente_abertura_reservar(uuid, text, text, jsonb);
create or replace function public.api_agente_abertura_reservar(
  p_tenant_id uuid,
  p_telefone  text,
  p_texto     text,
  p_contexto  jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_id  uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if v_tel = '' then
    raise exception 'api_agente: telefone sem digitos' using errcode = '22023';
  end if;
  if coalesce(btrim(p_texto), '') = '' then
    raise exception 'api_agente: texto vazio' using errcode = '22023';
  end if;

  insert into public.aberturas_externas (tenant_id, telefone, texto, contexto)
  values (p_tenant_id, v_tel, p_texto, p_contexto)
  on conflict (tenant_id, telefone, md5(texto)) where registrada_em is null
  do nothing
  returning id into v_id;

  -- Conflito: devolve a reserva que já existe, para o retry ser idempotente de
  -- verdade. Devolver NULL faria o chamador achar que falhou e tentar de novo.
  if v_id is null then
    select a.id into v_id
      from public.aberturas_externas a
     where a.tenant_id = p_tenant_id
       and a.telefone = v_tel
       and md5(a.texto) = md5(p_texto)
       and a.registrada_em is null
     order by a.criado_em desc
     limit 1;
  end if;

  return v_id;
end;
$function$;

comment on function public.api_agente_abertura_reservar(uuid, text, text, jsonb) is
  'Cria (ou devolve, se ja existe) a reserva de abertura externa. Idempotente '
  'por (tenant, telefone, texto) enquanto nao registrada.';

revoke all on function public.api_agente_abertura_reservar(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.api_agente_abertura_reservar(uuid, text, text, jsonb) to service_role;
grant execute on function public.api_agente_abertura_reservar(uuid, text, text, jsonb) to n8n_agent;

-- -----------------------------------------------------------------------------
-- 3. CONSUMIR (o serviço, quando o eco chega)
-- -----------------------------------------------------------------------------
-- Devolve `achou` para o serviço saber que NÃO deve pausar, e `texto` apenas na
-- PRIMEIRA vez — a segunda parte da abertura não grava de novo.
drop function if exists public.api_agente_abertura_consumir(uuid, text, bigint, integer);
create or replace function public.api_agente_abertura_consumir(
  p_tenant_id       uuid,
  p_telefone        text,
  p_conversation_id bigint,
  p_janela_min      integer default 10
)
returns table (id uuid, texto text, contexto jsonb)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tel    text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_janela interval := make_interval(mins => greatest(coalesce(p_janela_min, 10), 1));
  v_id     uuid;
  v_texto  text;
  v_ctx    jsonb;
  v_nova   boolean;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if v_tel = '' then
    return;
  end if;

  -- A mais recente dentro da janela, registrada ou não: enquanto a janela vale,
  -- toda saída nossa para aquele lead é abertura e não "atendente assumiu".
  select a.id, a.texto, a.contexto, (a.registrada_em is null)
    into v_id, v_texto, v_ctx, v_nova
    from public.aberturas_externas a
   where a.tenant_id = p_tenant_id
     and a.telefone = v_tel
     and a.criado_em > now() - v_janela
   order by a.criado_em desc
   limit 1
     for update;

  if v_id is null then
    return;
  end if;

  update public.aberturas_externas a
     set conversation_id = coalesce(a.conversation_id, p_conversation_id),
         registrada_em   = coalesce(a.registrada_em, now())
   where a.id = v_id;

  -- `texto` só na primeira: quem já gravou não grava de novo.
  return query select v_id, case when v_nova then v_texto else null end, v_ctx;
end;
$function$;

comment on function public.api_agente_abertura_consumir(uuid, text, bigint, integer) is
  'Diz ao servico que a saida para este telefone e uma abertura externa (logo: '
  'NAO pausar). Devolve o texto so na primeira chamada da janela.';

revoke all on function public.api_agente_abertura_consumir(uuid, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.api_agente_abertura_consumir(uuid, text, bigint, integer) to service_role;
grant execute on function public.api_agente_abertura_consumir(uuid, text, bigint, integer) to n8n_agent;

commit;
