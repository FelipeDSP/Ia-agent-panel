-- =====================================================================
-- 54. Roteamento por (conta, caixa de entrada) do Chatwoot
-- =====================================================================
--
-- >>> O NOME DO ARQUIVO E PROVISORIO. <<<
--
-- O briefing pedia `20260824180000`, mas essa versao ESTA OCUPADA pela 53
-- (`53_anti_loop`) no ledger. Conferido:
--
--   select version, name from supabase_migrations.schema_migrations
--    order by version desc limit 3;
--   -- 20260824180000  53_anti_loop
--   -- 20260824120000  52_notificar_venda
--
-- Duas migracoes com a mesma versao e pior do que nome errado: o `db push`
-- passa a nao saber qual delas o ledger registrou. Entao este arquivo nasce com
-- a data de hoje. Como a aplicacao vai ser fora do CLI (editor/MCP), o ledger
-- vai gravar o timestamp DELE, nao este — depois de aplicar, confira e renomeie
-- o par (migracao + rollback) para a versao registrada, que e a regra do
-- CLAUDE.md.
--
-- ---------------------------------------------------------------------
-- O PROBLEMA
--
-- Um cliente com dois agentes de IA precisa hoje de duas CONTAS no Chatwoot. O
-- bot do Chatwoot e ligado a uma INBOX, nao a conta — dois agentes com funcoes
-- diferentes cabem em duas caixas da mesma conta. O que impede e o
-- `tenants_chatwoot_account_id_key` mais o `where chatwoot_account_id =
-- p_account_id` da `api_n8n_tenant_por_chatwoot`.
--
-- E TIRAR A TRAVA SOZINHA PIORA, o que foi MEDIDO e nao suposto. Com o unico
-- trocado por `unique (chatwoot_account_id, chatwoot_inbox_id)`:
--
--   insert (59, null) -> ok        <- e o emporio ja e (59, null)
--   insert (59, null) -> ok        <- TRES tenants na conta 59
--   insert (59, 12)   -> ok
--   api_n8n_tenant_por_chatwoot(59) -> 4 LINHAS
--
-- NULL nao colide com NULL. O `Tenant Valido?` le a primeira linha sem ordenacao
-- garantida, e qual agente responde vira sorteio que pode alternar entre
-- execucoes.
--
-- ---------------------------------------------------------------------
-- POR QUE DOIS INDICES PARCIAIS, E NAO UM UNICO COMPOSTO
--
-- O composto simples derruba um teste que hoje esta verde. Medido, a asserçao 1
-- de `tests/desconectar-chatwoot.mjs` ("B NAO consegue tomar a conta enquanto A
-- a tem") sob cada desenho — A e B nascem os dois com caixa nula:
--
--   UNIQUE(account) — hoje          -> OK (23505)
--   UNIQUE(account, inbox) composto -> FALHA (sem erro nenhum)
--   dois unicos PARCIAIS            -> OK (23505)
--
-- E `NULLS NOT DISTINCT` (PG 15+, e o banco e 17.6) NAO E OPCAO: sete tenants
-- tem `chatwoot_account_id` nulo hoje — desconectar zera a conta, e a exclusao
-- tambem — entao `(null, null)` colidiria com `(null, null)` e o indice **nem
-- chega a ser criado**:
--
--   alter table ... unique nulls not distinct (chatwoot_account_id, chatwoot_inbox_id)
--   -> 23505 could not create unique index
--
-- Nao e contornavel: e o estado normal do banco, nao sujeira.
--
-- Os dois parciais dizem duas coisas diferentes:
--
--   idx_tenants_chatwoot_caixa      uma CAIXA nao se repete dentro da conta;
--   idx_tenants_chatwoot_sem_caixa  uma conta SEM caixa e exclusiva da conta
--                                   inteira.
--
-- E AQUI VAI UMA CORRECAO DO MEU PROPRIO ARGUMENTO, que so apareceu quando a
-- sabotagem S1 do teste rodou. Com o `tenants_chatwoot_par_check` da secao 4
-- VALIDADO, `(conta, null)` e impossivel — entao o unico composto simples
-- passaria a ser EQUIVALENTE aos dois parciais, e a tabela de medicao acima
-- deixa de ser argumento contra ele. A primeira versao da S1 esperava vermelho
-- e ficou verde exatamente por isso.
--
-- O `idx_tenants_chatwoot_sem_caixa` fica assim mesmo, mas com o papel certo
-- escrito: SEGUNDA CAMADA. Ele nunca e acionado enquanto o CHECK estiver de pe,
-- e passa a ser o que segura se alguem afrouxar o CHECK um dia — que e uma
-- linha de SQL. `npm run teste:roteamento-caixa` mede as duas separadas: o
-- CHECK barrando o par pela metade, e o indice barrando o segundo coringa COM
-- o CHECK derrubado.
--
-- ---------------------------------------------------------------------
-- CASAMENTO ESTRITO, E POR QUE NAO O CORINGA
--
-- Medi os tres corpos possiveis no cenario `emporio(59,null)` + `novo(59,12)`:
--
--                        inbox 12        inbox 77 (desconhecida)  inbox NULL
--   ESTRITO   = $2       [novo]          []                       []
--   CORINGA   null or =  [novo,emporio]  [emporio]                [emporio]
--   PREFERE   + limit 1  [novo]          [emporio]                [emporio]
--
-- O CORINGA e o bug de cima reintroduzido um nivel abaixo: DUAS linhas, e o
-- `Tenant Valido?` le a primeira. O PREFERE devolve sempre uma — e e pior,
-- porque webhook de uma caixa DESCONHECIDA cai calado no `emporio`. E a mesma
-- forma do `hnsw.iterative_scan = off` que o CLAUDE.md descreve: responde,
-- responde errado, e nao ha linha de log dizendo que faltou.
--
-- Fica o ESTRITO. O preco e que tenant de caixa nula fica IRRESOLVIVEL — e e
-- por isso que o backfill (secao 2) e o CHECK (secao 4) sao parte da migracao e
-- nao higiene posterior.
--
-- ---------------------------------------------------------------------
-- ARIDADE: SEM DEFAULT. E o que o DEFAULT compraria e ruim.
--
-- Medido com funcao de brinquedo, a familia 28/32/37 confirmada ao pe da letra:
--
--   create f(bigint); create or replace f(bigint, bigint default null);
--   -> as DUAS vivas
--   select f(59::bigint) -> 42725  function public.probe_f(bigint) is not unique
--
-- Com DEFAULT + drop da 1-aria a chamada de 1 argumento passa a resolver na
-- 2-aria. Isso parece rede de seguranca para a janela de implantacao e NAO E:
-- sob casamento estrito ela resolve com `p_inbox_id` nulo, devolve ZERO linhas,
-- e o `Tenant Valido?` corta o fluxo. O cliente simplesmente para de receber
-- resposta, sem erro em lugar nenhum. Sem DEFAULT, o no antigo leva `42883` e
-- alguem ve. Prefira a falha barulhenta.
--
-- ---------------------------------------------------------------------
-- GRANTS — E UMA CORRECAO DO QUE O REPO ACHAVA (ver CLAUDE.md)
--
-- `drop function` apaga o ACL inteiro, isso continua verdade. Mas o que ele
-- produz na recriacao SEM bloco de grants NAO e `permission denied` — e funcao
-- ABERTA. Medido:
--
--   drop function f(bigint,bigint); create f(bigint,bigint);   -- sem grant nenhum
--   acl -> =X/postgres | postgres=X | anon=X | authenticated=X | service_role=X
--   has_function_privilege('n8n_agent', ...) -> TRUE   (herda por PUBLIC)
--
-- Ou seja: quem esquece o bloco INTEIRO escancara a funcao para `anon` e a
-- pergunta "o n8n_agent consegue chamar?" responde SIM. O sintoma das 40/41
-- (`permission denied`) so aparece para quem REVOGA e esquece um role.
--
-- A conferencia que vale e o diff de ACL contra as IRMAS, nao contra a lista que
-- eu espero. As 22 `api_n8n_*` estao todas em:
--
--   postgres=X/postgres | service_role=X/postgres | n8n_agent=X/postgres
--
-- e a secao 6 deixa esta identica — verificado byte a byte contra
-- `api_n8n_portao_mensagem` em transacao abortada.
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRACAO NAO FAZ, DE PROPOSITO
--
-- `conversas` e `mensagens_log` NAO ganham `inbox_id`. Nesta fatia todo tenant
-- tem no maximo uma caixa, entao a coluna seria funcionalmente dependente de
-- `tenant_id`: repetiria o que o join ja diz. So carrega informacao quando a
-- modelagem separar cliente de agente, e ai nasce com o desenho daquela fatia.
-- O custo de trazer agora seria mudar a aridade de `api_n8n_conversa_sync` E de
-- `api_n8n_registrar_mensagem` — as duas no caminho de toda mensagem, e a
-- segunda e a assinatura com pior historico do repo (32 e 37).
--
-- E `idx_tenants_chatwoot` (nao-unico, parcial em `chatwoot_account_id`) FICA.
-- Ele ficou redundante com os dois parciais novos, mas dropar indice e decisao
-- propria, com rollback proprio, e nao e roteamento.
--
-- ---------------------------------------------------------------------
-- CUSTO, medido com `explain (analyze, buffers)` contra producao
--
--   corpo da funcao, cru : 0,039 ms  (Seq Scan em 10 linhas — o planner ignora
--                                     o indice e esta certo neste tamanho)
--   a funcao inteira     : 0,49 ms
--   30 idas e voltas     : 1.025 ms  (~34 ms cada, dominado por rede)
--
-- Igual ao que a 48 mediu para a versao de 1 argumento (33,6 ms). O parametro a
-- mais nao custa nada.
--
-- ORDEM DE IMPLANTACAO: este SQL PRIMEIRO, o import do workflow DEPOIS, na
-- mesma sessao. Entre os dois existe janela de quebra e ela e inevitavel (a
-- assinatura antiga morre aqui); ela e curta e barulhenta — `42883` — de
-- proposito. A ordem inversa e pior: o no novo manda 2 argumentos para a 1-aria
-- e da o mesmo `42883`, so que sem rota de volta a nao ser reimportar.
--
-- ROLLBACK: 20260828120000_54_roteamento_por_caixa_rollback.sql
--           (e o rollback do n8n vem ANTES dele — ver o cabecalho de la)
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. A coluna
-- ---------------------------------------------------------------------
-- Nullable, e vai continuar nullable: `(null, null)` e o estado "desconectado",
-- que sete tenants tem hoje e que a exclusao e o botao de desconectar produzem.
-- O que a secao 4 proibe nao e o nulo, e o par PELA METADE.
--
-- Nao precisa mexer em `trg_tenants_guard_colunas`: ele e lista de PERMISSAO
-- (`to_jsonb(new) - '{system_prompt,agente_ativo,debounce_segundos,...}'`),
-- entao coluna nova nasce agencia-only sozinha. Verificado no corpo do trigger.
alter table public.tenants add column if not exists chatwoot_inbox_id bigint;

comment on column public.tenants.chatwoot_inbox_id is
  'Caixa de entrada do Chatwoot. Com chatwoot_account_id forma o par de roteamento: '
  'o webhook traz os dois (body.account.id e body.conversation.inbox_id) e a '
  'api_n8n_tenant_por_chatwoot casa pelos DOIS. Ou os dois sao nulos (desconectado) '
  'ou os dois estao preenchidos — ver tenants_chatwoot_par_check.';

-- ---------------------------------------------------------------------
-- 2. Backfill
-- ---------------------------------------------------------------------
-- O `set local` NAO E ZELO, e obrigatorio, e isso foi medido: a migracao roda
-- como `postgres`, que tem BYPASSRLS mas NAO passa pelo
-- `trg_tenants_guard_colunas` — o trigger nao e RLS, dispara igual, e
-- `auth_is_super_admin()` sem claim nenhum devolve `false`. Sem esta linha os
-- tres UPDATEs abaixo morrem com:
--
--   42501 Sem permissao: tenant_admin so pode alterar prompt, mensagens, ...
--
-- `set local` e escopado a transacao e some no commit. E o mesmo contexto que
-- `tests/desconectar-chatwoot.mjs` monta para mexer nesta mesma coluna.
set local request.jwt.claims = '{"app_metadata":{"papel":"super_admin"}}';

-- DE ONDE SAEM ESTES DOIS NUMEROS. Nao saem do banco: `conversas` nao guarda
-- inbox (10 colunas) e `mensagens_log` tambem nao (20 colunas). E nao saem da
-- API do Chatwoot com a credencial do painel — os tres tokens guardados sao de
-- Agent Bot, e a API recusa:
--
--   GET /api/v1/accounts/{1,7,59}/inboxes       -> 401
--   {"error":"Access to this endpoint is not authorized for bots"}
--
--   279 = emporio.  Duas fontes: a URL /app/accounts/59/settings/inboxes/279 e
--         um payload real de webhook, "inbox": { "id": 279, "name": "WA - Emporio" }.
--   189 = estudyou-sendbox.  Payload real em `agente ia workflow.txt`:
--         "account": { "id": 1 }, "inbox": { "id": 189, "name": "WA - Testes" }.
--
-- O `and chatwoot_account_id = <n>` nao e enfeite: se o slug tiver sido religado
-- a outra conta, o update nao pega nada e a secao 3 reprova em vez de gravar a
-- caixa de um cliente no cadastro de outro.
update public.tenants set chatwoot_inbox_id = 279
 where slug = 'emporio'          and chatwoot_account_id = 59;
update public.tenants set chatwoot_inbox_id = 189
 where slug = 'estudyou-sendbox' and chatwoot_account_id = 1;

-- O QUE SOBRA E SOLTO — E ISSO E DECISAO CONSCIENTE, TOMADA AQUI.
--
-- Hoje isto atinge exatamente UM tenant: `ceejaar`, conta 7, que e tenant de
-- TESTE e cuja caixa ninguem levantou. Sob casamento estrito, `(7, null)` ja
-- seria irresolvivel — o agente dele para de responder de qualquer forma. A
-- diferenca e so se a tela CONTINUA DIZENDO "Conectado a conta 7" enquanto o
-- agente esta mudo. Soltar a conta faz o cadastro dizer a verdade: "nao
-- conectado".
--
-- >>> SE VOCE ESTA INVESTIGANDO "POR QUE O CEEJAAR PAROU DE RESPONDER": foi
-- >>> aqui, foi de proposito, e o conserto e reconectar pelo painel informando
-- >>> a caixa. O token dele NAO foi apagado (`tenant_credenciais` nao e tocada),
-- >>> entao reconectar nao exige token novo. Ele tinha trafego real em
-- >>> 2026-08-28 12:39 — tres turnos — entao nao suponha que estava parado.
--
-- A caixa dele da para descobrir sem entrar no Chatwoot: `mensagens_log` guarda
-- `execucao_id` (4044208 / 4044228 / 4044276, do dia 28/08), e a execucao do
-- n8n tem o payload com `body.inbox.id`.
--
-- A regra e geral de proposito (nao cita slug): "conta sem caixa nao e conexao
-- valida, solte a conta". Idempotente.
update public.tenants
   set chatwoot_account_id = null, chatwoot_inbox_id = null
 where chatwoot_account_id is not null
   and chatwoot_inbox_id is null;

-- ---------------------------------------------------------------------
-- 3. A migracao prova o proprio efeito antes de seguir
-- ---------------------------------------------------------------------
-- Sem isto, um erro de digitacao no backfill acima nao daria erro nenhum: o
-- update simplesmente nao casaria linha, o `emporio` cairia no soltador logo
-- abaixo, e a migracao aplicaria verde deixando o unico cliente em producao
-- desconectado. E o modo de falha exato que esta fatia existe para eliminar —
-- silencio no lugar de erro — e ele nao pode estar na propria migracao.
do $$
declare
  v_emporio bigint;
  v_sendbox bigint;
  v_orfaos  integer;
begin
  select chatwoot_inbox_id into v_emporio from public.tenants where slug = 'emporio';
  select chatwoot_inbox_id into v_sendbox from public.tenants where slug = 'estudyou-sendbox';
  select count(*) into v_orfaos
    from public.tenants
   where (chatwoot_account_id is null) <> (chatwoot_inbox_id is null);

  if v_emporio is distinct from 279 then
    raise exception 'backfill: emporio ficou com caixa %, esperava 279 (conta mudou?)', v_emporio;
  end if;
  if v_sendbox is distinct from 189 then
    raise exception 'backfill: estudyou-sendbox ficou com caixa %, esperava 189', v_sendbox;
  end if;
  if v_orfaos <> 0 then
    raise exception 'backfill: % tenant(s) com metade do par preenchida', v_orfaos;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. O unico antigo sai, os dois parciais entram, e o CHECK fecha o par
-- ---------------------------------------------------------------------
alter table public.tenants drop constraint if exists tenants_chatwoot_account_id_key;
drop index if exists public.tenants_chatwoot_account_id_key;

drop index if exists public.idx_tenants_chatwoot_caixa;
create unique index idx_tenants_chatwoot_caixa
  on public.tenants (chatwoot_account_id, chatwoot_inbox_id)
  where chatwoot_account_id is not null and chatwoot_inbox_id is not null;

comment on index public.idx_tenants_chatwoot_caixa is
  'Uma caixa nao se repete dentro da conta. Parcial porque UNIQUE comum nao ve '
  'NULL colidindo com NULL — medido: tres tenants entrando em (59, null).';

drop index if exists public.idx_tenants_chatwoot_sem_caixa;
create unique index idx_tenants_chatwoot_sem_caixa
  on public.tenants (chatwoot_account_id)
  where chatwoot_account_id is not null and chatwoot_inbox_id is null;

comment on index public.idx_tenants_chatwoot_sem_caixa is
  'Conta sem caixa e exclusiva da conta inteira. SEGUNDA CAMADA: com o '
  'tenants_chatwoot_par_check validado este estado nem existe. Ele so entra em '
  'acao se o CHECK for afrouxado — e ai e ele que impede voltar ao bug de tres '
  'tenants na mesma conta.';

-- O CHECK e BICONDICIONAL de proposito, e nao so "conta preenchida exige caixa".
-- A metade que falta na versao fraca — `(null, 279)` — e o que acontece se
-- `desconectarChatwoot` ou `excluirTenant` zerarem a conta e esquecerem a caixa.
-- Essa linha nao vaza nem roteia (as duas WHEREs dos indices a ignoram), mas
-- fica mentindo no cadastro. Com o bicondicional, esquecer vira 23514 na hora.
--
-- Ele e VALIDADO, nao `not valid`: contra os dados de hoje `not valid` seria a
-- unica forma de passar com o `ceejaar` ainda conectado — e um CHECK que o
-- catalogo declara e uma linha viola e exatamente a invariante que mente. A
-- secao 2 solta o `ceejaar` justamente para este `add constraint` poder validar.
alter table public.tenants drop constraint if exists tenants_chatwoot_par_check;
alter table public.tenants add constraint tenants_chatwoot_par_check
  check ((chatwoot_account_id is null) = (chatwoot_inbox_id is null));

-- ---------------------------------------------------------------------
-- 5. A funcao de resolucao
-- ---------------------------------------------------------------------
-- `drop function` pela lista COMPLETA de tipos, nao pelo nome: dropar pelo nome
-- com varias assinaturas vivas erra ou derruba a errada (CLAUDE.md).
drop function if exists public.api_n8n_tenant_por_chatwoot(bigint);

-- Vira `plpgsql` (era `sql`) por UM motivo, e vale o custo: parametro nulo
-- precisa ESTOURAR, e `language sql` nao tem como. Sem isso, `p_inbox_id` nulo
-- daria `= null`, que e NULL, que e zero linhas — e o `Tenant Valido?` corta em
-- silencio. Isto e a diferenca entre os dois casos, e eles sao mesmo diferentes:
--
--   p_inbox_id NULO      -> quem CHAMA esta quebrado (no antigo, ou payload sem
--                           inbox). Erro alto, 22023.
--   caixa DESCONHECIDA   -> caso de negocio (webhook de caixa nao cadastrada).
--                           Zero linhas, quieto, exatamente como conta
--                           desconhecida ja se comporta hoje.
--
-- `security definer` continua obrigatorio: `n8n_agent` nao tem privilegio de
-- TABELA nenhum desde a 09. `stable` porque le e nao escreve.
create or replace function public.api_n8n_tenant_por_chatwoot(
  p_account_id bigint,
  p_inbox_id   bigint
)
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
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $$
begin
  if p_account_id is null then
    raise exception 'api_n8n: p_account_id e obrigatorio' using errcode = '22023';
  end if;

  if p_inbox_id is null then
    raise exception 'api_n8n: p_inbox_id e obrigatorio — o webhook traz em '
                    'body.conversation.inbox_id / body.inbox.id'
      using errcode = '22023';
  end if;

  return query
  select t.id, t.slug, t.nome, t.agente_ativo, t.system_prompt, t.modelo,
         t.temperatura, t.debounce_segundos, t.msg_midia_nao_suportada,
         t.msg_fora_escopo, t.chatwoot_url
  from public.tenants t
  where t.chatwoot_account_id = p_account_id
    and t.chatwoot_inbox_id  = p_inbox_id
    and t.ativo
    and t.deletado_em is null;
end;
$$;

comment on function public.api_n8n_tenant_por_chatwoot(bigint, bigint) is
  'Resolve (account_id, inbox_id) do Chatwoot -> config do agente. Casamento ESTRITO '
  'nos dois: caixa desconhecida devolve zero linhas, caixa NULA estoura 22023. '
  'Nao retorna o token: ver api_n8n_credencial_chatwoot.';

-- ---------------------------------------------------------------------
-- 6. Grants — revoke ANTES do grant, e os DOIS roles
-- ---------------------------------------------------------------------
-- Sem o `revoke`, o `grant` e decoracao: as ALTER DEFAULT PRIVILEGES deste
-- projeto ja deram EXECUTE a PUBLIC, `anon` e `authenticated` no instante do
-- `create` (medido — ver o cabecalho). E `service_role` sozinho nao basta: o
-- n8n nao passa pelo PostgREST, ele conecta como `n8n_agent`, que foi a linha
-- que faltou nas migracoes 40 e 41.
revoke all on function public.api_n8n_tenant_por_chatwoot(bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.api_n8n_tenant_por_chatwoot(bigint, bigint) to service_role;
grant execute on function public.api_n8n_tenant_por_chatwoot(bigint, bigint) to n8n_agent;

commit;

-- ---------------------------------------------------------------------
-- DEPOIS DE APLICAR, e antes de importar o workflow:
--
--   -- 1. o ACL tem de ficar IDENTICO ao das irmas (nao a sua expectativa):
--   select proname, array_to_string(proacl, ' | ')
--     from pg_proc where proname in ('api_n8n_tenant_por_chatwoot',
--                                    'api_n8n_portao_mensagem');
--
--   -- 2. e chamar de verdade, que e outra coisa de ter grant:
--   set local role n8n_agent;
--   select slug from public.api_n8n_tenant_por_chatwoot(59, 279);  -- emporio
--   reset role;
--
--   -- 3. renomeie o par de arquivos para a versao que o ledger registrou:
--   select version, name from supabase_migrations.schema_migrations
--    order by version desc limit 1;
-- ---------------------------------------------------------------------
