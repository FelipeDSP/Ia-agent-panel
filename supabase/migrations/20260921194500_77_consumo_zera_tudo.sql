-- =====================================================================
-- Migração 77 — o consumo conta de 21/09/2026 19:45 UTC (Felipe, 21/09)
-- =====================================================================
-- A 76 cortou à meia-noite UTC e sobraram as 53 respostas de hoje (CEEJAAR e
-- sendbox). O Felipe quis TUDO zerado: o corte passa a ser o instante da
-- aplicação. Mesma mecânica da 76 (zera colunas, nunca apaga linha —
-- `mensagens_log` é memória; `uso_ingestao` é chave de idempotência), mesma
-- marca `zerado_76` para a aba não contar como real nem estimada.
--
-- O corte é FIXO no arquivo, não `now()`: reexecutar amanhã não pode zerar o
-- consumo de amanhã.
--
-- IRREVERSÍVEL como a 76. Rollback ao lado só documenta.

begin;

update public.mensagens_log
   set tokens_entrada = null,
       tokens_saida = null,
       tokens_entrada_cache = null,
       tokens_wrapper = null,
       tokens_system_prompt = null,
       tokens_schema_tools = null,
       tokens_mensagens = null,
       tokens_memoria = null,
       tokens_round_trip = null,
       fonte_tokens = 'zerado_76'
 where criado_em < '2026-09-21T19:45:00Z'
   and (tokens_entrada is not null or tokens_saida is not null or tokens_entrada_cache is not null
        or coalesce(fonte_tokens, '') <> 'zerado_76');

update public.uso_ingestao
   set tokens = 0
 where criado_em < '2026-09-21T19:45:00Z'
   and tokens <> 0;

commit;
