-- Rollback da migracao 39 (indice do historico de conversa)
--
-- Derruba o indice. Nenhum dado e perdido e nenhum comportamento muda:
-- conversa_historico() volta a ser servida por idx_log_tenant_data, varrendo as
-- mensagens do tenant e filtrando conversation_id na saida. Correto, so mais
-- lento — proporcional ao volume de mensagens daquele cliente.

drop index if exists public.idx_log_conversa;
