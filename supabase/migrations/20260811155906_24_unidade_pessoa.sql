-- 24_unidade_pessoa
--
-- Acrescenta 'pessoa' a lista fechada de `produtos.unidade`.
--
-- MOTIVO, vindo de uso real. Cadastrando um cardapio de restaurante na tela da
-- fatia 1, o couvert nao tinha unidade correta: e cobrado POR PESSOA, nao por
-- unidade. Ficou como 'un', o que quebra na fatia 2 — o agente confirmaria
-- "sao 4 unidades de couvert" em vez de "couvert para 4 pessoas". O mesmo vale
-- para rodizio, buffet e bebida liberada, que sao o padrao do vertical.
--
-- 'g', 'ml', 'm' e 'm2' JA ESTAVAM na lista desde a migracao 23 — nao foram
-- usados no teste de cadastro, o que e diferente de nao existirem. Confirmado
-- em pg_constraint antes de escrever esta migracao. Nada a acrescentar ali.
--
-- Lista final (13): un, kg, g, l, ml, m, m2, peca, par, porcao, pessoa, hora,
-- servico. Espelhada em UNIDADES, src/lib/vendas/schema.ts — mexeu aqui, mexeu
-- la, senao o banco recusa com 23514 na cara do cliente.
--
-- DROP + ADD numa transacao: CHECK nao aceita alteracao no lugar. O ADD revalida
-- as linhas existentes, entao ele proprio garante que nenhuma unidade fora da
-- lista tenha entrado por outro caminho.
--
-- Rollback: 20260811155906_24_unidade_pessoa_rollback.sql

begin;

alter table public.produtos
  drop constraint if exists produtos_unidade_valida;

alter table public.produtos
  add constraint produtos_unidade_valida check (unidade in (
    'un', 'kg', 'g', 'l', 'ml', 'm', 'm2', 'peca', 'par', 'porcao', 'pessoa', 'hora', 'servico'
  ));

commit;
