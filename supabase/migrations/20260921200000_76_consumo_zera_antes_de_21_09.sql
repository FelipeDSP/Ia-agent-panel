-- =====================================================================
-- Migração 76 — o consumo passa a contar de 21/09/2026 (Felipe, 21/09)
-- =====================================================================
-- Até 17/09 o Empório e o CEEJAAR eram atendidos pelo n8n, que gravava tokens
-- por ESTIMATIVA (fórmula, 23–29% acima do real); desde 18/09 tudo é `usage`
-- da OpenAI. Setembro ficou misto e o Felipe decidiu: a aba de consumo mostra
-- só o que foi medido a partir de hoje.
--
-- O dado de consumo mora DENTRO de `mensagens_log`, que é também a MEMÓRIA do
-- agente — apagar linha é apagar contexto de conversa. Então não se apaga
-- linha: ZERAM-SE as colunas de token das linhas anteriores ao corte e a
-- `fonte_tokens` vira 'zerado_76' (não é 'openai_usage' nem 'estimativa%',
-- então `billing_consumo_mensal` não a conta nem como real nem como
-- estimada; com token nulo o custo dá zero). `modelo` fica — é histórico do
-- turno, não consumo.
--
-- `uso_ingestao` (embeddings): as linhas anteriores ao corte ficam com
-- `tokens = 0` em vez de serem apagadas — a tabela é a chave de idempotência
-- da ingestão (migração 36), e apagar deixaria um job antigo recontar.
--
-- O único outro leitor de token em `mensagens_log` é o teto diário de
-- `api_n8n_portao_mensagem`, que soma só `criado_em >= hoje` — não vê o que
-- esta migração toca (conferido em 21/09).
--
-- IRREVERSÍVEL: os valores anteriores não são guardados em lugar nenhum. O
-- rollback ao lado só documenta isso. Reexecutável (a segunda vez não acha
-- linha). Corte em UTC — o mês da aba também é UTC.

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
 where criado_em < '2026-09-21T00:00:00Z'
   and (tokens_entrada is not null or tokens_saida is not null or tokens_entrada_cache is not null
        or coalesce(fonte_tokens, '') <> 'zerado_76');

update public.uso_ingestao
   set tokens = 0
 where criado_em < '2026-09-21T00:00:00Z'
   and tokens <> 0;

commit;
