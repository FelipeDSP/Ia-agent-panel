-- =====================================================================
-- ROLLBACK da 52 — notificacao de venda
-- =====================================================================
--
-- Volta ao estado anterior: as duas funcoes nao existiam, e nada mais foi
-- tocado. Nao ha coluna nova, nao ha tabela nova, nao ha extensao envolvida.
--
-- DROPE PELA LISTA COMPLETA DE TIPOS, nunca pelo nome. Dropar pelo nome com
-- varias assinaturas vivas erra ou derruba a errada — foi o que a familia
-- 28/32/37/40/41 ensinou.
--
-- O QUE ESTE ROLLBACK NAO DESFAZ, DE PROPOSITO: o `metadados.notificacao` ja
-- gravado nos pedidos. E rastro de fato acontecido — a mensagem foi enviada ou
-- falhou de verdade —, e apagar isso trocaria "rollback" por "perda de
-- historico". Reaplicar a 52 depois volta a enxergar as reservas antigas e
-- continua nao duplicando, que e o comportamento certo.
--
-- Depois de rodar isto, o no `Reivindica Notificacao` do
-- `tool-fechar-pedido.json` passa a estourar `42883` a cada venda. Reverta o
-- workflow no n8n ANTES, ou o pedido fecha e o agente responde com erro.
-- =====================================================================

begin;

drop function if exists public.api_n8n_notificar_venda(uuid, bigint, integer);
drop function if exists public.api_n8n_confirmar_notificacao(uuid, uuid, boolean, text);

-- `contato_exibivel` sai POR ULTIMO e so aqui: a migracao 53 tambem a usa. Se a
-- 53 estiver aplicada, este rollback quebra a pausa por anomalia -- rollback e
-- na ordem inversa, 53 antes de 52. O `drop` sem `cascade` recusa se houver
-- dependencia registrada; nao havera, porque plpgsql e late-binding e
-- `pg_depend` fica vazio (ver CLAUDE.md). Ou seja: NADA vai avisar. Confira com
--   select p.proname from pg_proc p where p.prosrc ilike '%contato_exibivel%';
-- antes de rodar.
drop function if exists public.contato_exibivel(text);

commit;
