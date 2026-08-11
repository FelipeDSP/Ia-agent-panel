-- Rollback de 21b_credencial_chatwoot_contract
--
-- Recria `tenants.chatwoot_token` e repopula a partir de `tenant_credenciais`.
-- Reverte SO a fase contract: as funcoes do n8n continuam lendo de
-- `tenant_credenciais` (isso e trabalho da 21a) e a tabela segregada continua
-- existindo. Depois deste rollback o estado e exatamente o de "21a aplicada,
-- 21b nao" — o painel antigo volta a funcionar.
--
-- ATENCAO: reverter REABRE a exposicao do token ao tenant_admin, porque a coluna
-- volta a existir na linha que ele le via PostgREST. So use se o deploy do
-- painel novo tambem estiver sendo revertido.
--
-- Para desfazer TUDO, rode este arquivo e depois o rollback da 21a, nessa ordem.

begin;

-- 1. Recria a coluna.
alter table public.tenants
  add column if not exists chatwoot_token text;

-- 2. Repopula a partir da tabela segregada.
--
-- POR QUE session_replication_role: o guard de coluna da migracao 13
-- (trg_tenants_guard_colunas) dispara em TODO update de `tenants` e so libera
-- cedo quando `auth_is_super_admin()` e verdadeiro. Numa conexao de migracao nao
-- existe JWT, entao a funcao devolve falso e o guard levanta 42501 mesmo rodando
-- como owner do banco — sem isto o rollback aborta no meio, deixando a coluna
-- recriada e vazia. Verificado em 2026-08-11 contra producao em transacao
-- abortada.
--
-- `set local` em vez de `alter table ... disable trigger`: fica restrito a esta
-- sessao (o guard segue valendo para os demais), reverte sozinho no fim da
-- transacao e nao pega ACCESS EXCLUSIVE em `tenants` — lock que bloquearia ate
-- as leituras do n8n. E se este arquivo rodar fora de transacao, o `set local`
-- so emite warning e o update falha alto, em vez de deixar o guard desligado em
-- producao sem ninguem perceber.
--
-- Efeito colateral aceito: `replica` suspende os demais triggers de usuario
-- nesta sessao, incluindo set_atualizado_em — num rollback e desejavel nao
-- carimbar `atualizado_em`. Nao ha FK envolvida neste update.

set local session_replication_role = replica;

update public.tenants t
set chatwoot_token = c.chatwoot_token
from public.tenant_credenciais c
where c.tenant_id = t.id;

commit;
