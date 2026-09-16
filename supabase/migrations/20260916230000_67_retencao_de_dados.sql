-- =====================================================================
-- 67. Retenção de dados — o agente não guarda conversa para sempre
-- =====================================================================
--
-- Decisão do Felipe (16/09/2026): "não temos infra para guardar tanto";
-- política GLOBAL, texto de conversa por 45 dias. docs/POLITICA-RETENCAO.md
-- é a política escrita; esta migração é o mecanismo.
--
-- O que `api_agente_retencao` faz, em quatro cortes, todos por data:
--
--   1. TEXTO das mensagens (`mensagens_log.conteudo`, `portao`, `saida_cortes`)
--      com mais de `p_texto_dias`: vira NULO. A linha FICA, porque a contagem
--      de tokens dela é o consumo do mês (cobrança). O texto é dado pessoal
--      (LGPD) e nada o lê depois de 40 min (memória) além de auditoria;
--   2. LINHAS de `mensagens_log` com mais de `p_contagem_dias`: apagadas. O
--      mês já foi faturado (13 meses cobrem qualquer conferência anual);
--   3. TRACE: `agente_turnos` (e `agente_passos` por CASCADE) com mais de
--      `p_turnos_dias` e não `aberto`; `agente_fila` concluída/descartada/
--      falhada com mais de `p_turnos_dias`. `api_agente_varrer_passos` (62)
--      continua cortando os passos mais cedo (30 dias);
--   4. IDENTIDADE em `conversas` (`contact_name`, `phone`) sem mensagem há
--      mais de `p_conversas_dias`: NULO. A linha fica — é a chave da pausa e
--      do corte de memória.
--
-- O que NÃO toca, de propósito: `pedidos`, itens, `pedido_cobrancas`,
-- `pagamento_eventos` (registro financeiro), `kb_documentos`, `prompt_versoes`,
-- `produtos` (conteúdo que o cliente administra).
--
-- Devolve uma linha por corte com a contagem: apagar tem de ser VISÍVEL — o
-- serviço registra no log a cada passada diária. Global (sem tenant), como a
-- varredura de passos; roda como `n8n_agent`. Grants: revoke antes, os DOIS.
-- Extensão: nenhuma. REEXECUTÁVEL. Rollback ao lado (só a função: os dados
-- apagados não voltam — é a natureza da retenção).
-- =====================================================================

begin;

drop function if exists public.api_agente_retencao(integer, integer, integer, integer);
create or replace function public.api_agente_retencao(
  p_texto_dias integer default 45,
  p_turnos_dias integer default 45,
  p_contagem_dias integer default 400,
  p_conversas_dias integer default 180)
returns table(alvo text, linhas bigint)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_n bigint;
  v_texto     interval := make_interval(days => greatest(coalesce(p_texto_dias, 45), 1));
  v_turnos    interval := make_interval(days => greatest(coalesce(p_turnos_dias, 45), 1));
  v_contagem  interval := make_interval(days => greatest(coalesce(p_contagem_dias, 400), 1));
  v_conversas interval := make_interval(days => greatest(coalesce(p_conversas_dias, 180), 1));
begin
  -- A contagem nunca pode ser mais curta que o texto: apagaria linha antes de
  -- ter tirado o texto dela — e o consumo do mês corrente sumiria.
  if v_contagem < v_texto then
    raise exception 'api_agente_retencao: p_contagem_dias (%) menor que p_texto_dias (%)', p_contagem_dias, p_texto_dias using errcode = '22023';
  end if;

  -- 1. texto
  update public.mensagens_log m
     set conteudo = null, portao = null, saida_cortes = null
   where m.criado_em < now() - v_texto
     and (m.conteudo is not null or m.portao is not null or m.saida_cortes is not null);
  get diagnostics v_n = row_count;
  alvo := 'mensagens_log.texto'; linhas := v_n; return next;

  -- 2. contagem
  delete from public.mensagens_log m where m.criado_em < now() - v_contagem;
  get diagnostics v_n = row_count;
  alvo := 'mensagens_log.linhas'; linhas := v_n; return next;

  -- 3. trace (passos vão por cascade) e fila
  delete from public.agente_turnos t where t.iniciado_em < now() - v_turnos and t.status <> 'aberto';
  get diagnostics v_n = row_count;
  alvo := 'agente_turnos'; linhas := v_n; return next;
  delete from public.agente_fila f where f.criado_em < now() - v_turnos and f.estado in ('concluida', 'descartada', 'falhou');
  get diagnostics v_n = row_count;
  alvo := 'agente_fila'; linhas := v_n; return next;

  -- 4. identidade
  update public.conversas c
     set contact_name = null, phone = null
   where c.atualizado_em < now() - v_conversas
     and (c.contact_name is not null or c.phone is not null);
  get diagnostics v_n = row_count;
  alvo := 'conversas.identidade'; linhas := v_n; return next;
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array['public.api_agente_retencao(integer, integer, integer, integer)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
    execute format('grant execute on function %s to n8n_agent', f);
  end loop;
end $$;

commit;
