-- Rollback da migracao 48 — `api_n8n_conversa_pausada`
--
-- NAO RODE COM O PORTAO VIVO NO n8n. O `Consulta Pausa` do `agente-principal`
-- chama esta funcao a cada mensagem, ANTES do `Roteia Acao` — sem ela, TODA
-- mensagem de TODO cliente morre em `function api_n8n_conversa_pausada(uuid,
-- bigint) does not exist`. Nao e o ramo de midia: e o caminho inteiro.
--
-- ORDEM CORRETA para desfazer:
--
--   1. importe o workflow SEM o portao (o `agente-principal.json` anterior a
--      esta entrega, ou o gerador com a secao do portao removida);
--   2. so entao rode este arquivo.
--
-- Reverter o workflow devolve o vazamento que a 48 fecha — midia e bloqueado
-- voltam a falar por cima do atendimento humano. E o preco de desfazer, e esta
-- nota existe para que ele seja escolhido e nao descoberto.
--
-- NAO HA PERDA DE DADO. A funcao nao guarda nada: le `conversas` e `tenants` e
-- devolve booleano. `motivo_pausa`, `pausado_em` e `pausa_expira_minutos` sao da
-- 47 e nao sao tocados aqui.
--
-- `public.pausa_vigente` TAMBEM NAO E TOCADA, de proposito: ela e da 47 e tem
-- outros tres leitores (`api_n8n_conversa_sync`, `api_n8n_pode_transcrever` e a
-- view do painel quando chegar). Dropar a regra junto com um dos consumidores
-- derrubaria o agente inteiro. Se a intencao for desfazer a 47, use o rollback
-- DELA — e rode este antes, porque a 47 nao sabe que esta funcao existe.

begin;

drop function if exists public.api_n8n_conversa_pausada(uuid, bigint);

commit;
