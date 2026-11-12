-- =============================================================================
-- ROLLBACK DA 90 — abertura externa
-- =============================================================================
--
-- Reversível de verdade, e isto é afirmação medida, não esperança: a tabela só
-- guarda reservas de prospecção. Nada no painel a lê para atender, nada no
-- agente depende dela para responder, e o ramo `humano` volta a pausar sempre —
-- que é o comportamento de antes da migração.
--
-- NÃO é o caso da nota do CLAUDE.md sobre "migração que amplia o permitido":
-- aqui não há restrição antiga a recriar. Dropar a tabela não esbarra em estado
-- criado legalmente depois.
--
-- A ORDEM IMPORTA: funções primeiro, tabela depois. `drop table` com as funções
-- vivas as deixaria existindo e quebrando por dentro na primeira chamada
-- (42P01), que é a mesma classe da nota sobre `DROP EXTENSION` — o corpo de uma
-- plpgsql é texto, resolvido na execução, e nada avisa.
--
-- REEXECUTÁVEL.
-- =============================================================================

begin;

drop function if exists public.api_agente_abertura_consumir(uuid, text, bigint, integer);
drop function if exists public.api_agente_abertura_reservar(uuid, text, text, jsonb);

-- SEM `drop policy if exists` ANTES: o `IF EXISTS` ali é da POLICY, não da
-- tabela — `drop policy if exists p on public.t` com `t` inexistente levanta
-- 42P01 e aborta. Este rollback roda ANTES da migração nos testes (a regra do
-- rollback-primeiro), ou seja, justamente quando a tabela ainda não existe.
-- Medido: foi assim que ele falhou na primeira execução. `drop table` leva as
-- policies junto, então a linha não fazia falta nenhuma.
drop table if exists public.aberturas_externas;

commit;
