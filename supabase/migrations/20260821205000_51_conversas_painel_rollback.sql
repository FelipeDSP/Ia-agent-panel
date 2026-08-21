-- Rollback da migracao 51 — remove a view `conversas_painel`
--
-- ##########################################################################
-- ##  RODE O DEPLOY DO CODIGO ANTES. A ORDEM AQUI E A INVERSA DA APLICACAO.##
-- ##########################################################################
--
-- Cinco call sites do painel leem esta view depois da 51:
--
--   src/app/(app)/painel/conversas/page.tsx
--   src/app/(app)/painel/conversas/[conversationId]/page.tsx
--   src/app/(app)/painel/page.tsx
--   src/app/(app)/painel/relatorios/page.tsx
--   src/app/(app)/admin/tenants/[id]/page.tsx
--
-- Dropar a view com esse codigo no ar nao degrada: derruba as paginas, com
-- `relation "public.conversas_painel" does not exist` em cada uma. A ordem
-- correta para desfazer e:
--
--   1. suba o codigo que le `conversas` direto (o anterior a 51);
--   2. so entao rode este arquivo.
--
-- E VALE SABER O QUE VOLTA: sem a view, o painel volta a ler `conversas.status`
-- cru, que e LAPIDE — pausa vencida segue gravada como 'pausado'. Em 21/08 isso
-- eram 9 conversas do `emporio` mostradas como pausadas com o bot atendendo
-- nelas. O rollback devolve exatamente essa mentira.
--
-- SEM PERDA DE DADO. View nao guarda nada; `conversas`, `tenants` e os
-- predicados da 47 nao sao tocados. A escrita nunca passou por aqui — o toggle
-- sempre atualizou a tabela.
--
-- OS PREDICADOS DA 47 NAO SAO DROPADOS, de proposito: `pausa_vigente` e
-- `conversa_status_efetivo` tem outros tres leitores em SQL
-- (`api_n8n_conversa_sync`, `api_n8n_pode_transcrever`,
-- `api_n8n_conversa_pausada`). Dropar a regra junto com um consumidor derrubaria
-- o agente inteiro. Se a intencao for desfazer a 47, use o rollback DELA.
--
-- E o `grant execute` daqueles predicados para `authenticated` TAMBEM fica: ele
-- foi escrito na 47, nao aqui, e revoga-lo neste arquivo apagaria uma linha de
-- outra migracao — o tipo de sobra que ninguem encontra depois.

begin;

drop view if exists public.conversas_painel;

commit;
