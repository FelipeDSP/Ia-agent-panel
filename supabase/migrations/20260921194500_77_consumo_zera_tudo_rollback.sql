-- Rollback da 77: NÃO EXISTE.
--
-- A 77 zera colunas de token em `mensagens_log` e `uso_ingestao` para linhas
-- anteriores a 2026-09-21T19:45Z e não guarda os valores em lugar nenhum —
-- decisão do Felipe (21/09): o consumo passa a contar de hoje; o que havia
-- antes era misto (estimativa do n8n + usage) e não interessa. Reverter
-- exigiria um backup do banco anterior à aplicação.
--
-- Este arquivo existe para a cadeia de migrações continuar tendo um rollback
-- por número; rodá-lo não faz nada.

begin;
select 1;
commit;
