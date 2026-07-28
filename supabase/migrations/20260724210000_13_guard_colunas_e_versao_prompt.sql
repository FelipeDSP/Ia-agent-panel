-- 13_guard_colunas_e_versao_prompt
--
-- Dois triggers em public.tenants, para a Fase 3.
--
-- 1. GUARD DE COLUNA POR PAPEL (before update)
--
--    A policy p_tenants_update deixa o tenant_admin editar a propria linha
--    INTEIRA — inclusive modelo, temperatura e tokens, que controlam custo de
--    API e credencial. A §6.2 da especificacao reserva isso para a agencia.
--
--    RLS sozinha nao resolve: WITH CHECK so enxerga a linha nova, nao a antiga,
--    entao nao da para exigir "modelo novo = modelo antigo". E GRANT por coluna
--    nao distingue papel, porque no Supabase todo usuario logado e o mesmo role
--    `authenticated` — o papel vive no JWT. Comparacao old/new por papel exige
--    trigger.
--
--    Whitelist por diff de jsonb: para quem nao e super_admin, so as colunas
--    listadas podem mudar. Qualquer outra que mude — inclusive coluna nova
--    adicionada no futuro — levanta excecao. O default seguro e "protegido".
--
-- 2. VERSAO DE PROMPT (after update of system_prompt)
--
--    A cada mudanca de system_prompt, grava a versao ANTERIOR em prompt_versoes.
--    Trigger e nao Server Action porque tres caminhos mexem no prompt (edit do
--    super, edit do tenant, rollback) e um trigger cobre os tres sem duplicar.
--
--    Modelo "guarda o anterior": prompt_versoes acumula os prompts substituidos;
--    o atual vive em tenants.system_prompt. Rollback = copiar um conteudo antigo
--    de volta, o que grava o prompt vigente como nova versao. Nada se perde.
--    criado_por = quem SUBSTITUIU aquele conteudo (auth.uid() do editor atual).
--
-- Nenhuma das funcoes api_n8n_* e tocada. Nada destrutivo: cria duas funcoes e
-- dois triggers, sem alterar dado.
--
-- Rollback: 20260724210000_13_guard_colunas_e_versao_prompt_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Guard de coluna
-- ---------------------------------------------------------------------------

create or replace function public.tenants_guard_colunas()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Super admin pode tudo.
  if public.auth_is_super_admin() then
    return new;
  end if;

  -- Para os demais: so as colunas da whitelist podem diferir. atualizado_em
  -- entra na lista porque o trigger set_atualizado_em sempre a altera.
  if (to_jsonb(new) - '{system_prompt,agente_ativo,debounce_segundos,msg_midia_nao_suportada,msg_fora_escopo,atualizado_em}'::text[])
     is distinct from
     (to_jsonb(old) - '{system_prompt,agente_ativo,debounce_segundos,msg_midia_nao_suportada,msg_fora_escopo,atualizado_em}'::text[])
  then
    raise exception
      'Sem permissao: tenant_admin so pode alterar prompt, mensagens, debounce e agente_ativo. Modelo, temperatura, tokens, slug, status e nome sao da agencia.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.tenants_guard_colunas() is
  'Barra tenant_admin de alterar colunas de custo/credencial em tenants. '
  'Whitelist por diff de jsonb: coluna nova e protegida por padrao.';

drop trigger if exists trg_tenants_guard_colunas on public.tenants;

create trigger trg_tenants_guard_colunas
  before update on public.tenants
  for each row
  execute function public.tenants_guard_colunas();

-- ---------------------------------------------------------------------------
-- 2. Versao de prompt
-- ---------------------------------------------------------------------------

create or replace function public.tenants_versionar_prompt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Guarda o conteudo que acabou de ser substituido. Ignora quando o prompt
  -- anterior era vazio (tenant recem-criado que ainda nao tinha prompt).
  if old.system_prompt is null or old.system_prompt = '' then
    return null;
  end if;

  insert into public.prompt_versoes (tenant_id, conteudo, criado_por)
  values (old.id, old.system_prompt, auth.uid());

  return null; -- AFTER trigger: retorno ignorado
end;
$$;

comment on function public.tenants_versionar_prompt() is
  'Grava o system_prompt anterior em prompt_versoes a cada mudanca. '
  'criado_por = quem substituiu.';

drop trigger if exists trg_tenants_versionar_prompt on public.tenants;

create trigger trg_tenants_versionar_prompt
  after update of system_prompt on public.tenants
  for each row
  when (new.system_prompt is distinct from old.system_prompt)
  execute function public.tenants_versionar_prompt();
