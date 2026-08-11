-- Rollback de 25_pedidos
--
-- Remove `pedidos`, `pedido_itens` e os triggers/funcoes de apoio.
--
-- ATENCAO — ISTO APAGA PEDIDO DE CLIENTE FINAL. Diferente do catalogo, que o
-- lojista pode redigitar, pedido e registro de uma transacao que aconteceu: o
-- cliente pediu, o valor foi acordado. Nao ha de onde reconstruir.
--
-- Antes de rodar, se houver qualquer pedido, exporte os dois lados:
--
--   \copy (select * from public.pedidos)      to 'pedidos_backup.csv'      csv header
--   \copy (select * from public.pedido_itens) to 'pedido_itens_backup.csv' csv header
--
-- O bloco 1 recusa o rollback se houver pedido — inclusive cancelado ou
-- expirado, que tambem sao historico. Para forcar, apague o bloco e assuma a
-- perda.
--
-- Rodar ANTES o rollback da 26: as funcoes api_n8n_* de la referenciam estas
-- tabelas, e plpgsql nao valida referencia no momento do drop — elas ficariam
-- apontando para relacao inexistente e so estourariam em runtime, no meio de
-- uma conversa com cliente.
--
-- O deploy do painel sai junto: /painel/pedidos erroraria sem as tabelas.

begin;

-- ---------------------------------------------------------------------------
-- 1. Trava: nao apagar historico de transacao sem decisao explicita
-- ---------------------------------------------------------------------------

do $$
declare
  v_pedidos integer;
  v_itens   integer;
  v_abertos integer;
begin
  select count(*), count(*) filter (where status in ('rascunho','aguardando_pagamento'))
    into v_pedidos, v_abertos
  from public.pedidos;
  select count(*) into v_itens from public.pedido_itens;

  if v_pedidos > 0 then
    raise exception
      'Abortado: existem % pedido(s) (% aberto(s)) e % item(ns). Pedido e registro '
      'de transacao que aconteceu e nao se reconstroi. Exporte antes '
      '(\copy ... csv header) e remova este bloco se a perda for aceita.',
      v_pedidos, v_abertos, v_itens
      using errcode = 'data_exception';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Tabelas (levam junto policies, indices e triggers)
-- ---------------------------------------------------------------------------
-- pedido_itens primeiro: a FK para pedidos e ON DELETE CASCADE, mas dropar na
-- ordem certa evita depender disso.

drop table if exists public.pedido_itens;
drop table if exists public.pedidos;

-- ---------------------------------------------------------------------------
-- 3. Funcoes de trigger
-- ---------------------------------------------------------------------------
-- So a 25 as criou e so estas tabelas as usavam.

drop function if exists public.pedidos_recalcula_total();
drop function if exists public.pedido_itens_herda_tenant();

commit;
