-- =====================================================================
-- ROLLBACK da 62 — tira o lado do banco da fatia 1 do agente em código
-- =====================================================================
--
-- ELE ABORTA em dois casos, e os dois sao o comportamento certo:
--
--   1. algum tenant com `agente_runtime = 'codigo'`: dropar a coluna faria
--      esse tenant "voltar" ao n8n sem ninguem ter reapontado o bot no
--      Chatwoot — o servico continuaria recebendo as mensagens e nao teria
--      mais como saber que e dele. Quem quiser desfazer decide o roteamento
--      primeiro;
--   2. algum turno gravado em `agente_turnos`: e auditoria (§6 do desenho) e
--      some com a tabela. Exporte antes, ou decida que pode sumir.
--
-- E a forma da nota do CLAUDE.md sobre a 55: rollback obrigatorio, abortando
-- com mensagem propria quando desfazer destroi dado que so existe depois da
-- migracao. Os testes que replayam este rollback ARRANJAM o estado (nenhum
-- tenant em 'codigo', nenhum turno) na transacao abortada.
--
-- Extensao: nenhuma foi criada, nenhuma e dropada.
-- REEXECUTAVEL: `drop ... if exists` em tudo.
-- =====================================================================

begin;

do $$
declare
  v_em_codigo integer;
  v_turnos    integer;
begin
  -- SQL dinamico: a coluna pode nao existir (rollback replayado sobre um banco
  -- pre-62), e plpgsql resolve o nome da coluna ao executar o comando.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'tenants' and column_name = 'agente_runtime') then
    execute 'select count(*) from public.tenants where agente_runtime = ''codigo''' into v_em_codigo;
    if v_em_codigo > 0 then
      raise exception 'rollback da 62 ABORTADO: % tenant(s) com agente_runtime = ''codigo''. Reaponte o bot no Chatwoot e volte-os para ''n8n'' antes.', v_em_codigo;
    end if;
  end if;
  if to_regclass('public.agente_turnos') is not null then
    execute 'select count(*) from public.agente_turnos' into v_turnos;
    if v_turnos > 0 then
      raise exception 'rollback da 62 ABORTADO: % turno(s) em agente_turnos (auditoria). Exporte antes de apagar.', v_turnos;
    end if;
  end if;
end $$;

drop function if exists public.api_agente_varrer_passos(integer);
drop function if exists public.api_agente_memoria_cortar(uuid, bigint);
drop function if exists public.api_agente_memoria(uuid, bigint, integer, integer);
drop function if exists public.agente_texto_entrada(text);
drop function if exists public.api_agente_turno_fechar(uuid, uuid, text, integer, integer, integer, integer, text, uuid, text);
drop function if exists public.api_agente_passo(uuid, uuid, integer, text, text, jsonb, jsonb, text, integer);
drop function if exists public.api_agente_turno_abrir(uuid, bigint, uuid, text, text, text, text);
drop function if exists public.api_agente_prompt_registrar(uuid, text, text, text);
drop function if exists public.api_agente_concluir(uuid, uuid[], text, uuid, text);
drop function if exists public.api_agente_turno_da_conversa(uuid, bigint, uuid, text, integer);
drop function if exists public.api_agente_reivindicar(text, integer, integer);
drop function if exists public.api_agente_enfileirar(uuid, bigint, jsonb, integer);
drop function if exists public.api_agente_runtime(uuid);

drop table if exists public.agente_passos;
drop table if exists public.agente_turnos;
drop table if exists public.agente_prompts;
drop table if exists public.agente_fila;

alter table public.conversas drop column if exists memoria_cortada_em;

alter table public.tenants drop constraint if exists tenants_agente_runtime_valido;
alter table public.tenants drop column if exists agente_runtime;

commit;
