-- =====================================================================
-- ROLLBACK da 54 — roteamento por (conta, caixa)
-- =====================================================================
--
-- >>> NAO RODE ISTO COM O WORKFLOW NOVO VIVO NO n8n. <<<
--
-- A ordem e o INVERSO da aplicacao, e o primeiro passo NAO e SQL:
--
--   1. reimporte o workflow ANTIGO no n8n (os dois nos de resolucao voltam a
--      mandar 1 argumento);
--   2. so entao rode este arquivo.
--
-- Na ordem errada, toda mensagem de todo tenant estoura
-- `42883: function api_n8n_tenant_por_chatwoot(bigint, bigint) does not exist`
-- — a resolucao do tenant e a primeira coisa depois do `Extrair e Filtrar`, e
-- nao ha degradacao parcial: o fluxo inteiro para.
--
-- ---------------------------------------------------------------------
-- O QUE ESTE ROLLBACK DESFAZ
--
--   - a funcao de 2 argumentos sai e a de 1 volta, COM os grants nos dois
--     roles. Restaurar a funcao sem `grant ... to n8n_agent` devolveria um
--     agente que resolve e nao pode chamar — trocar um rollback incompleto por
--     `permission denied for function` em todo cliente nao e conserto;
--   - o CHECK e os dois indices parciais;
--   - a conta 7 volta para o `ceejaar`;
--   - a coluna `chatwoot_inbox_id` (e com ela as caixas 279 e 189);
--   - o `tenants_chatwoot_account_id_key` volta.
--
-- A ORDEM DENTRO DO ARQUIVO TAMBEM IMPORTA, e por dois motivos concretos:
--
--   - o CHECK sai ANTES de religar o `ceejaar`. Na ordem inversa o update
--     bateria em `23514`, porque `(7, null)` e exatamente o par pela metade que
--     o CHECK proibe;
--   - o unico antigo volta DEPOIS de a coluna sair. Se voltasse antes, ele
--     valeria sobre um estado em que dois tenants ja podem dividir a conta.
--
-- ROUND-TRIP VERIFICADO. Em transacao abortada contra producao: retrato (linhas
-- de `tenants`, colunas, indices, constraints, corpo/volatilidade/ACL da funcao)
-- ANTES da migracao e DEPOIS deste rollback — identicos, byte a byte, nos cinco.
-- E reexecutavel: rodar duas vezes seguidas nao quebra.
--
-- ---------------------------------------------------------------------
-- O QUE ELE NAO DESFAZ
--
-- Um segundo tenant que voce tenha criado na conta 59 (a fatia funcionando).
-- Se existir, o `add constraint ... unique (chatwoot_account_id)` do fim FALHA
-- com `23505` — e falhar e o certo, porque a alternativa seria escolher
-- sozinho qual dos dois agentes perde a conta. Confira antes:
--
--   select slug, chatwoot_account_id, chatwoot_inbox_id
--     from public.tenants
--    where chatwoot_account_id is not null
--    order by chatwoot_account_id, chatwoot_inbox_id;
--
-- e desconecte a mao o que tiver de sair, antes de rodar isto.
-- =====================================================================

begin;

-- Mesmo motivo da migracao: `trg_tenants_guard_colunas` nao e RLS e dispara
-- para `postgres` tambem, que sem claim nenhum nao passa por
-- `auth_is_super_admin()`. Sem esta linha o update do `ceejaar` morre em 42501.
set local request.jwt.claims = '{"app_metadata":{"papel":"super_admin"}}';

-- ---------------------------------------------------------------------
-- 1. A funcao volta a ser de 1 argumento
-- ---------------------------------------------------------------------
drop function if exists public.api_n8n_tenant_por_chatwoot(bigint, bigint);

-- Corpo copiado de `pg_get_functiondef` da funcao viva em producao, e nao
-- reescrito de memoria — inclusive o `and t.ativo and t.deletado_em is null` na
-- mesma linha. O retrato do round-trip compara `prosrc`, entao reescrever com
-- outra quebra de linha reprovaria (e reprovou, na primeira versao deste
-- arquivo).
create or replace function public.api_n8n_tenant_por_chatwoot(p_account_id bigint)
returns table (
  tenant_id                uuid,
  slug                     text,
  nome                     text,
  agente_ativo             boolean,
  system_prompt            text,
  modelo                   text,
  temperatura              numeric,
  debounce_segundos        integer,
  msg_midia_nao_suportada  text,
  msg_fora_escopo          text,
  chatwoot_url             text
)
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $$
  select t.id, t.slug, t.nome, t.agente_ativo, t.system_prompt, t.modelo,
         t.temperatura, t.debounce_segundos, t.msg_midia_nao_suportada,
         t.msg_fora_escopo, t.chatwoot_url
  from public.tenants t
  where t.chatwoot_account_id = p_account_id
    and t.ativo and t.deletado_em is null;
$$;

comment on function public.api_n8n_tenant_por_chatwoot(bigint) is
  'Resolve account_id do Chatwoot -> config do agente. Nao retorna o token: '
  'ver api_n8n_credencial_chatwoot.';

revoke all on function public.api_n8n_tenant_por_chatwoot(bigint)
  from public, anon, authenticated;
grant execute on function public.api_n8n_tenant_por_chatwoot(bigint) to service_role;
grant execute on function public.api_n8n_tenant_por_chatwoot(bigint) to n8n_agent;

-- ---------------------------------------------------------------------
-- 2. CHECK e indices parciais saem (o CHECK primeiro — ver cabecalho)
-- ---------------------------------------------------------------------
alter table public.tenants drop constraint if exists tenants_chatwoot_par_check;
drop index if exists public.idx_tenants_chatwoot_caixa;
drop index if exists public.idx_tenants_chatwoot_sem_caixa;

-- ---------------------------------------------------------------------
-- 3. O `ceejaar` volta para a conta 7
-- ---------------------------------------------------------------------
-- A migracao soltou a conta dele de proposito (tenant de teste, caixa
-- desconhecida). Rollback que deixasse o cliente desconectado nao seria
-- rollback. Condicionado a `is null` para ser idempotente e para nao roubar a
-- conta de quem tenha assumido ela nesse meio-tempo.
update public.tenants set chatwoot_account_id = 7
 where slug = 'ceejaar' and chatwoot_account_id is null;

-- ---------------------------------------------------------------------
-- 4. A coluna sai e o unico antigo volta
-- ---------------------------------------------------------------------
alter table public.tenants drop column if exists chatwoot_inbox_id;

alter table public.tenants drop constraint if exists tenants_chatwoot_account_id_key;
alter table public.tenants add constraint tenants_chatwoot_account_id_key
  unique (chatwoot_account_id);

commit;
