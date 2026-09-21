-- =====================================================================
-- Migração 75 — `codigo` é o default de `tenants.agente_runtime` (21/09/2026)
-- =====================================================================
-- O n8n foi desligado em 21/09: todo cliente com tráfego já é atendido pelo
-- serviço `agente/` (emporio e ceejaar desde 18/09; sendbox desde 16/09), e o
-- painel deixou de expor "quem atende". A coluna FICA — o serviço descarta
-- com 200 o webhook de tenant fora de `codigo`, e é essa guarda que impede
-- resposta dupla se alguém religar algo por engano —, mas o default `'n8n'`
-- (migração 62) virou armadilha: um tenant criado fora do painel (script,
-- SQL, teste) nasceria mudo, sem tela onde virar a chave.
--
-- Faz duas coisas:
--   1. default 'codigo' — a partir daqui, quem nasce é atendido;
--   2. os tenants ainda em 'n8n' passam a 'codigo'. Hoje são só os três
--      seeds de teste (restaurante-teste, sandbox-de-testes, clinica-teste),
--      sem conta no Chatwoot; a migração não distingue por slug de propósito
--      (o teste cria os próprios tenants e a regra vale para qualquer um).
--
-- O CHECK continua aceitando 'n8n': testes o usam como arranjo para provar
-- o descarte, e trocar a restrição não compra nada.
--
-- Rollback: `20260921190000_75_codigo_e_o_default_rollback.sql` (volta o
-- default para 'n8n'; NÃO devolve os tenants — não há como saber quais eram).

begin;

alter table public.tenants
  alter column agente_runtime set default 'codigo';

-- O guard `trg_tenants_guard_colunas` barra QUALQUER update fora da lista
-- branca sem claim de super_admin — inclusive o de uma migração rodando como
-- postgres (medido: 42501). Desliga só ele, só aqui, e religa na linha
-- seguinte; nada mais desta transação toca em `tenants`.
alter table public.tenants disable trigger trg_tenants_guard_colunas;

update public.tenants
   set agente_runtime = 'codigo'
 where agente_runtime <> 'codigo';

alter table public.tenants enable trigger trg_tenants_guard_colunas;

comment on column public.tenants.agente_runtime is
  'Quem atende as mensagens deste tenant. Desde 21/09/2026 so existe o servico agente/ (codigo); o valor n8n sobrevive no CHECK para arranjo de teste. O servico descarta webhook de tenant fora de codigo. Agencia-only pelo guard.';

commit;
