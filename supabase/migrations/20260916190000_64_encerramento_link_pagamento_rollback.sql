-- =====================================================================
-- ROLLBACK da 64 — tira o encerramento do link
-- =====================================================================
-- Dropar `encerrada_em` PERDE a informação de quais links já foram
-- fechados no Asaas: ao reaplicar a 64, a varredura tentaria fechá-los de
-- novo (desativar link já inativo é 2xx no Asaas; remover cobrança já
-- removida é 404 — a varredura registra e segue). Não é destrutivo para o
-- dinheiro, só repete trabalho. Por isso NÃO aborta.
-- Extensão: nenhuma. REEXECUTÁVEL.
-- =====================================================================

begin;

drop function if exists public.api_n8n_cobrancas_a_encerrar(integer);
drop function if exists public.api_n8n_confirmar_encerramento(uuid, uuid, boolean, text);
drop index if exists public.idx_pedido_cobrancas_a_encerrar;
alter table public.pedido_cobrancas
  drop column if exists encerrada_em,
  drop column if exists encerramento_detalhe;

commit;
