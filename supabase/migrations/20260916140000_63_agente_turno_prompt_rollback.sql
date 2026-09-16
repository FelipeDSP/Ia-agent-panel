-- =====================================================================
-- ROLLBACK da 63 — tira `api_agente_turno_prompt`
-- =====================================================================
-- Não destrói dado: os `perfil`/`prompt_hash` já gravados nos turnos ficam
-- (são colunas da 62). Só o serviço deixa de conseguir gravá-los — o código
-- trata a falha como trace ausente (log), não como turno perdido.
-- Extensão: nenhuma. REEXECUTÁVEL.
-- =====================================================================

begin;

drop function if exists public.api_agente_turno_prompt(uuid, uuid, text, text);

commit;
