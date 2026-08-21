-- Migracao 47 — retomada da pausa: janela por ultima fala do humano
--
-- NAO APLICADA EM PRODUCAO. Ao aplicar fora do CLI, confira a versao gravada em
-- `supabase_migrations.schema_migrations` e renomeie ESTE arquivo e o rollback
-- para bater com ela (ver CLAUDE.md, secao Migracoes). A 46 ficou em
-- `20260820160000`.
--
-- ============================== O QUE ELA FAZ ==============================
--
-- Hoje nada devolve uma conversa pausada ao agente a nao ser o toggle do painel,
-- e o dono trabalha no WhatsApp, nao no painel. O conserto da pausa (2026-08-20)
-- trocou um bug visivel — a IA falando por cima do dono — por um silencioso: em
-- 2026-08-21 havia ONZE conversas paradas, dez do `emporio` e uma do
-- `fortalize`, a mais antiga de 20/08 14:16Z, e nenhuma sairia dali sozinha.
--
-- A regra:
--
--   - pausa por MENSAGEM HUMANA caduca `tenants.pausa_expira_minutos` depois da
--     ULTIMA fala do humano;
--   - pausa MANUAL (toggle do painel) NAO caduca. So sai no clique.
--
-- ===================== POR QUE A ULTIMA FALA, E NAO A INATIVIDADE ==========
--
-- Contar a partir de `conversas.atualizado_em` (que a mensagem do cliente
-- tambem empurra) nao interrompe atendimento em curso, e foi descartado assim
-- mesmo. As duas falhas nao tem o mesmo peso, porque uma se corrige sozinha:
--
--   - por ultima fala do humano: se o dono demorar mais que a janela, o bot
--     volta e fala. O dono ve, escreve de novo, e a mensagem dele RE-PAUSA na
--     hora — o caminho de pausa dispara em TODA mensagem humana, nao so na
--     primeira. Falha barulhenta, resolvida no turno seguinte;
--   - por inatividade: se o dono sumir e o cliente continuar escrevendo,
--     `atualizado_em` nunca envelhece e o bot NUNCA volta. Cliente falando
--     sozinho, sem bot e sem gente, sem limite e sem sintoma.
--
-- E a mesma regra do `Mensagem Pronta` e do `Perfil Nao Resolvido`: falha alta
-- ganha de falha calada. Ela tambem dispensa o teto de horas que o desenho
-- anterior previa — o teto existia so para tapar a brecha do cliente abandonado.
--
-- ===================== EXPIRACAO PREGUICOSA, SEM JOB =======================
--
-- A pausa nao e desfeita por ninguem: ela DEIXA DE VALER quando lida. Predicado
-- unico, avaliado pelos leitores que ja existem. Nada de cron, nada de trigger
-- de agendamento, nada de infra nova.
--
-- O detalhe que decide o desenho: `api_n8n_pode_transcrever` e STABLE e portanto
-- nao pode escrever. Uma expiracao que fizesse `UPDATE` obrigaria a torna-la
-- VOLATILE; um predicado puro nao obriga nada.
--
-- ===================== POR QUE A ASSINATURA NAO MUDA (DE NOVO) =============
--
-- Tres funcoes mudam de CORPO e nenhuma de ASSINATURA. Isso e escolha, nao
-- sorte, e e a mesma da 46:
--
--   - nao ha `drop function`, entao nao ha aridade ambigua (28, 32, 37);
--   - nao ha `drop function`, entao NENHUM grant e apagado e nao ha nada para
--     reconceder (40, 41). O ACL de hoje — postgres, service_role, n8n_agent —
--     atravessa esta migracao intacto, e `npm run teste:retomada-pausa` confere
--     isso por DIFF do ACL antes/depois, nao contra a lista que eu escrevi, que
--     foi exatamente como a 41 passou verde sem `n8n_agent`;
--   - `create or replace` de mesma aridade e reexecutavel, entao a migracao roda
--     duas vezes sem quebrar.
--
-- O caso que EXIGIRIA assinatura nova ficou de fora de proposito: distinguir a
-- pausa da `Tool - Transferir para Humano` (o bot escalando) da pausa por fala
-- do dono precisaria de um parametro em `api_n8n_definir_status_conversa`, com
-- `drop function` pela lista completa de tipos e os dois grants restaurados. Vai
-- em migracao propria, junto com a mudanca do no do n8n. Ate la a transferencia
-- cai em `mensagem_humana`, e o rotulo de tela ("em atendimento humano") e
-- honesto para os dois casos.
--
-- ===================== O QUE NAO ESTA AQUI: A VIEW DO PAINEL ===============
--
-- A view `conversas_painel` (com `security_invoker`) e os cinco call sites do
-- painel ficam para a 48, pelo mesmo motivo que a `transferencia` ficou de fora
-- desta: `security_invoker` e a linha mais perigosa daquele desenho — sem ela a
-- view roda como dona e IGNORA a RLS de `conversas`, o que e vazamento entre
-- clientes por uma porta nova, com a policy `p_conversas_all` intacta e inutil.
-- Risco alto merece deploy proprio e teste dedicado.
--
-- CUSTO ACEITO DE OLHO ABERTO, entre a 47 e a 48: o painel continua lendo
-- `conversas.status` cru, entao mostra `pausado` em conversa que ja caducou e a
-- contagem da Visao geral nao drena. O bot volta a funcionar (que e o que
-- importa) e a tela mente por alguns dias. A 48 vem em seguida — isto nao pode
-- virar semanas.
--
-- ===================== O TOGGLE DO PAINEL ENTRA COM ESTA ===================
--
-- `src/app/(app)/painel/conversas/acoes.ts` passa a escrever
-- `motivo_pausa: 'manual'`. Nao e cosmetico: sem ele a constraint
-- `conversas_pausa_tem_motivo` recusa o toggle.
--
-- ORDEM DE IMPLANTACAO — e aqui ela IMPORTA, ao contrario da 46:
--
--   1. este SQL;
--   2. o deploy do codigo.
--
-- Entre os dois o toggle do painel fica quebrado, porque o codigo velho omite
-- `motivo_pausa` e a constraint recusa. E minutos, e a mensagem se explica
-- sozinha na tela. A ordem inversa (codigo antes) estoura em `column
-- motivo_pausa does not exist` no cache do PostgREST, que e opaco, e dura o
-- tempo do atraso da migracao — e deploy de codigo ja derivou antes neste
-- projeto.
--
-- NAO USE O TOGGLE DE PAUSA ENTRE APLICAR ESTE SQL E O DEPLOY DO CODIGO.
--
-- ===================== A LAPIDE, QUE E DELIBERADA ==========================
--
-- Com expiracao preguicosa a linha caducada continua `status = 'pausado'` na
-- tabela indefinidamente, ate a proxima escrita. `api_n8n_conversa_sync` PODERIA
-- limpa-la de graca (ja faz `UPDATE` no mesmo statement) e nao limpa: seriam
-- duas fontes para o mesmo fato, e `api_n8n_pode_transcrever` precisaria do
-- predicado de qualquer jeito, porque pode rodar antes do sync.
--
-- O preco e que `conversas.status` deixa de responder sozinho a "o agente esta
-- pausado?" para TODO consumidor, inclusive futuro. Por isso o
-- `comment on column` da secao 6 — a alternativa e alguem descobrir isso pelo
-- comportamento daqui a seis meses.

begin;

-- ---------------------------------------------------------------------------
-- 1. A janela, por tenant.
--
--    `debounce_segundos` e o precedente: numero de comportamento do agente mora
--    em `tenants`, nao em `tenant_tools` (pausa nao e tool vendida).
--
--    NOT NULL DEFAULT 30, e nao nullable. O desenho anterior previa
--    `null = so retomada manual`; com a regra nova esse `null` deixou de
--    governar a pausa manual (que ja nao caduca por construcao) e passou a
--    governar SO a automatica — ou seja, virou "o dono responde pelo celular e
--    a conversa fica muda para sempre". E a falha calada que esta migracao
--    existe para fechar, acessivel por configuracao. O que o `null` compraria
--    ja tem entrada propria e explicita: o toggle.
--
--    30 minutos e palpite inicial, nao medida. O ritmo de uma clinica nao e o
--    de um emporio; o numero muda depois de medir.
--
--    ===================== SEM `UPDATE` AQUI, E NAO E ESTILO ================
--
--    A forma obvia seria `add column integer` + `update ... set 30 where null` +
--    `set not null`. Ela NAO FUNCIONA nesta tabela: `tenants` tem
--    `trg_tenants_guard_colunas`, um BEFORE UPDATE FOR EACH ROW que levanta
--    `42501` para qualquer coluna fora da lista branca (prompt, agente_ativo,
--    debounce, as duas msg_) a menos que `auth_is_super_admin()` seja
--    verdadeiro. Coluna nova nasce FORA da lista branca, entao o `update`
--    derruba a migracao inteira num apply por psql/MCP, onde nao ha claim de JWT
--    nenhuma.
--
--    Isto foi descoberto por medicao, e a primeira versao do TESTE mascarava:
--    ela setava `request.jwt.claims` de super_admin antes de aplicar (para criar
--    os tenants efemeros) e por isso a migracao passava verde numa condicao que
--    o apply real nao tem. `npm run teste:retomada-pausa` agora aplica com as
--    claims RESETADAS e ainda prova, por contraprova, que o trigger esta vivo —
--    senao a assercao seria verdadeira por vacuidade.
--
--    `add column ... not null default 30` resolve sem tocar no trigger: no
--    PG 11+ e mudanca so de catalogo (o default fica em `atthasmissing`, sem
--    rewrite da tabela) e DDL nao dispara trigger de DML. Uma linha, e o tenant
--    que ja existia nasce com 30 sem ninguem escrever nele.
--
--    CONSEQUENCIA QUE FICA: com `pausa_expira_minutos` fora da lista branca do
--    guard, a janela e **da agencia**, nao do cliente — o painel do cliente nao
--    consegue altera-la nem que a tela ofereca. E o default certo enquanto o
--    numero for palpite; se um dia o cliente for regula-lo, a coluna precisa
--    entrar na lista branca de `tenants_guard_colunas`, em migracao propria.
-- ---------------------------------------------------------------------------
alter table public.tenants
  add column if not exists pausa_expira_minutos integer not null default 30;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.tenants'::regclass
       and conname  = 'tenants_pausa_expira_positiva'
  ) then
    alter table public.tenants
      add constraint tenants_pausa_expira_positiva
      check (pausa_expira_minutos > 0);
  end if;
end $$;

comment on column public.tenants.pausa_expira_minutos is
  'Minutos apos a ULTIMA fala do humano em que a pausa por mensagem humana ainda '
  'vale. NAO se aplica a pausa manual (motivo_pausa = manual), que nunca caduca. '
  'NOT NULL de proposito: janela nula seria "o dono responde pelo celular e a '
  'conversa fica muda para sempre". Ver docs/PAUSA-AUTOMATICA.md.';

-- ---------------------------------------------------------------------------
-- 2. O motivo da pausa.
--
--    Coluna simples com check proprio; `conversas_status_check` nao e tocado.
--    Os dois sao independentes de proposito — ver a secao 4 para por que o
--    bicondicional (`status = pausado` SE E SOMENTE SE motivo preenchido) ficou
--    de fora.
-- ---------------------------------------------------------------------------
alter table public.conversas
  add column if not exists motivo_pausa text;

-- ---------------------------------------------------------------------------
-- 3. Backfill das que ja estao pausadas.
--
--    MEDICAO (consulta direta via `pg`, 2026-08-21, SEM filtro de tenant —
--    `select t.slug, count(*) from conversas cv join tenants t on t.id =
--    cv.tenant_id where cv.status = 'pausado' group by 1`): 11 linhas, 10 do
--    `emporio` e 1 do `fortalize`, num universo de 88 conversas (77 `ativo`).
--    Nao ha tenant fora dessa conta.
--
--    Quase todas sao efeito do conserto da pausa e nao foram decisao de
--    ninguem, entao viram `mensagem_humana` e destravam sozinhas no primeiro
--    deploy — sem clique nenhum. UMA nao e.
--
--    A EXCECAO: `emporio` conversa 6 ("Karen Ceejaar", 20/08 14:16:21.355Z).
--    Foi pausada pelo TOGGLE DO PAINEL, confirmado pelo autor do clique. A
--    forense que apontou para ela ANTES da confirmacao fica registrada porque a
--    proxima vez nao tera quem lembre:
--
--      (a) o milissegundo e REDONDO (`.355000`). `new Date().toISOString()` do
--          painel tem precisao de milissegundo; `now()` do Postgres tem
--          microssegundo. Controles de origem SQL comprovada:
--          `mensagens_log.criado_em` 0/344 redondos, `conversas.atualizado_em`
--          (trigger `set_atualizado_em`) 0/88, `conversas.criado_em` de agosto
--          0/19. Zero em 451. Os redondos de maio-julho em `criado_em` sao
--          contaminacao do `scripts/import-producao.mjs`, que carimbou do JS —
--          o controle so se separa quebrando por mes, e a primeira leitura
--          (66/88 redondos) quase derrubou a heuristica que estava certa;
--      (b) os dois carimbos se SEPARAM. `api_n8n_definir_status_conversa`
--          escreve `pausado_em` e `atualizado_em` no mesmo UPDATE com um `now()`
--          so, entao ficam identicos ao microssegundo (7 das 11 linhas sao).
--          O painel manda so `pausado_em`; `atualizado_em` vem do trigger,
--          depois. A conversa 6: `.355000` contra `.367225`, 11,9 ms. As outras
--          que diferem (2, 10, 13) diferem por 17 s, 9,5 min e 12 min — sao
--          bumps posteriores do `conversa_sync` — e nenhuma tem o ms redondo.
--
--    Se ela fosse backfillada como `mensagem_humana`, a janela de 30 min
--    contaria de 20/08 14:16 — JA VENCIDA — e ela retomaria no primeiro deploy:
--    o bot voltando a falar numa conversa que alguem pausou de proposito. Seria
--    esta migracao causando exatamente a surpresa que a regra existe para
--    impedir.
--
--    A HEURISTICA DO MILISSEGUNDO NAO ESTA CODIFICADA AQUI, de proposito. Ela e
--    evidencia para decidir uma vez, nao regra: reexecutada classificaria linha
--    nova errado, e ninguem entenderia o `case` daqui a seis meses. O que fica e
--    a LISTA, declarada e versionada — precedente `PEDIDOS_HISTORICOS` em
--    `tests/trava-vendas.mjs`, que e o que CLAUDE.md manda fazer quando o estado
--    do mundo importa de verdade.
--
--    Os dois `update` filtram `motivo_pausa is null`, entao sao inertes na
--    segunda execucao e nao alcancam linha nascida depois desta migracao.
-- ---------------------------------------------------------------------------
with excecao(slug, conversation_id) as (
  values ('emporio'::text, 6::bigint)
)
update public.conversas cv
   set motivo_pausa = 'manual'
  from public.tenants t
       join excecao e on e.slug = t.slug
 where cv.tenant_id       = t.id
   and cv.conversation_id = e.conversation_id
   and cv.status          = 'pausado'
   and cv.motivo_pausa is null;

update public.conversas
   set motivo_pausa = 'mensagem_humana'
 where status = 'pausado'
   and motivo_pausa is null;

-- ---------------------------------------------------------------------------
-- 4. As constraints de `motivo_pausa`.
--
--    A segunda proibe a UNICA combinacao que o predicado nao consegue
--    classificar: pausa sem motivo. Ela vai DEPOIS do backfill — na ordem
--    inversa as 11 linhas de hoje a violariam.
--
--    NAO e o bicondicional (`(status = 'pausado') = (motivo_pausa is not
--    null)`). Aquele enuncia melhor o invariante e cobra caro: todo UPDATE que
--    toque `status` sozinho passa a estourar. O preco real nao e o toggle (que
--    muda junto com esta migracao) — e o caminho futuro que ninguem lembrou,
--    quebrando em runtime em producao em vez de degradar.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.conversas'::regclass
       and conname  = 'conversas_motivo_pausa_check'
  ) then
    alter table public.conversas
      add constraint conversas_motivo_pausa_check
      check (motivo_pausa is null or motivo_pausa in ('manual', 'mensagem_humana'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.conversas'::regclass
       and conname  = 'conversas_pausa_tem_motivo'
  ) then
    alter table public.conversas
      add constraint conversas_pausa_tem_motivo
      check (status <> 'pausado' or motivo_pausa is not null);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. O predicado, em UM lugar.
--
--    ARGUMENTOS ESCALARES, e nao `(tenant_id, conversation_id)`. Os leitores ja
--    tem a linha na mao — o RETURNING do `conversa_sync`, o join do
--    `pode_transcrever`, a linha da view da 48. Uma versao que buscasse no banco
--    faria uma segunda leitura por chamada, e no `conversa_sync` leria a linha
--    que o proprio statement acabou de escrever. Escalar tambem a mantem STABLE
--    sem SECURITY DEFINER: e aritmetica sobre os argumentos e `now()`, sem
--    acesso a tabela, entao nao ha RLS nem tenant a considerar aqui dentro.
--
--    STABLE, e nao VOLATILE: `now()` e stable e a funcao nao le tabela. E isso
--    que permite chama-la de dentro de `api_n8n_pode_transcrever`, que e STABLE
--    e precisa continuar sendo.
--
--    `set search_path` custa a INLINE do planner (funcao SQL com clausula SET
--    nao e inlineada). Fica assim mesmo: os chamadores rodam uma vez por
--    mensagem e a view da 48 le no maximo 200 linhas, entao o ganho seria ruido,
--    e sair da convencao do repo por ruido nao paga.
--
--    ONDE CADA DESCONHECIDO CAI. Todo caminho devolve `true` ou `false`, nunca
--    NULL — e SEM `coalesce` no fim de proposito: guarda inalcancavel e guarda
--    que ninguem consegue sabotar, e teste que nao pode falhar compra confianca
--    sem dar nada em troca.
--
--      status <> 'pausado'  -> false   (inclusive `status` nulo)
--      motivo 'manual'      -> true    NUNCA caduca, qualquer que seja a janela
--      motivo NULO          -> cai na janela, ou seja, CADUCA. Linha assim nao
--                              deveria existir (a constraint da secao 4 a
--                              impede), mas se existir o lado alto e o bot
--                              voltar a falar: o dono ve e re-pausa. Trata-la
--                              como manual deixaria a conversa muda para sempre
--      pausado_em NULO      -> false   sem relogio nao da para afirmar pausa
--      janela NULA          -> false   nao e modo suportado (a coluna e NOT
--                              NULL); se aparecer e defeito, e defeito grita
-- ---------------------------------------------------------------------------
create or replace function public.pausa_vigente(
  p_status         text,
  p_pausado_em     timestamptz,
  p_motivo_pausa   text,
  p_janela_minutos integer
) returns boolean
language sql
stable
set search_path to 'public', 'extensions'
as $function$
  select case
    when p_status is distinct from 'pausado' then false
    when p_motivo_pausa = 'manual'           then true
    -- `null = 'manual'` e NULL, entao motivo nulo NAO para aqui: segue para a
    -- janela e caduca. E deliberado; ver o cabecalho desta secao.
    when p_pausado_em is null                then false
    when p_janela_minutos is null            then false
    else p_pausado_em > now() - make_interval(mins => p_janela_minutos)
  end;
$function$;

comment on function public.pausa_vigente(text, timestamptz, text, integer) is
  'A pausa desta conversa ainda vale? Predicado puro (STABLE, sem acesso a tabela) '
  'chamado por api_n8n_conversa_sync, api_n8n_pode_transcrever e, a partir da 48, '
  'pela view do painel. Predicado duplicado diverge, e diverge exatamente entre '
  '"o painel diz pausada" e "o bot ja respondeu".';

create or replace function public.conversa_status_efetivo(
  p_status         text,
  p_pausado_em     timestamptz,
  p_motivo_pausa   text,
  p_janela_minutos integer
) returns text
language sql
stable
set search_path to 'public', 'extensions'
as $function$
  select case
    when p_status is distinct from 'pausado' then p_status
    when public.pausa_vigente(p_status, p_pausado_em, p_motivo_pausa, p_janela_minutos)
      then p_status
    else 'ativo'
  end;
$function$;

comment on function public.conversa_status_efetivo(text, timestamptz, text, integer) is
  'O status que vale AGORA: ativo quando a pausa caducou, mesmo com '
  'conversas.status ainda em pausado (a lapide da expiracao preguicosa). '
  'Involucro de uma linha sobre pausa_vigente — nao replica a regra.';

-- Por padrao o Postgres da EXECUTE a PUBLIC em toda funcao nova (ver a nota da
-- 09). `anon` fora, pela convencao do repo. `authenticated` DENTRO de proposito:
-- a view da 48 e `security_invoker`, entao ela executa estas funcoes COMO o
-- usuario logado, e sem o grant a view morre em `permission denied for function`
-- — que e o modo de falha das migracoes 40 e 41, so que agendado para a proxima.
-- O grant nao abre nada: sao funcoes puras, sem acesso a tabela, e quem chama so
-- recebe de volta o que ele mesmo passou.
--
-- `n8n_agent` NAO precisa e por isso nao esta aqui: as tres `api_n8n_*` que
-- chamam estas funcoes sao SECURITY DEFINER de dono `postgres`, entao a chamada
-- interna corre como `postgres`, que e o dono destas duas.
revoke all on function public.pausa_vigente(text, timestamptz, text, integer) from public;
revoke all on function public.pausa_vigente(text, timestamptz, text, integer) from anon;
grant execute on function public.pausa_vigente(text, timestamptz, text, integer) to service_role;
grant execute on function public.pausa_vigente(text, timestamptz, text, integer) to authenticated;

revoke all on function public.conversa_status_efetivo(text, timestamptz, text, integer) from public;
revoke all on function public.conversa_status_efetivo(text, timestamptz, text, integer) from anon;
grant execute on function public.conversa_status_efetivo(text, timestamptz, text, integer) to service_role;
grant execute on function public.conversa_status_efetivo(text, timestamptz, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. `conversas.status` deixa de ser a resposta. Escrito na COLUNA, nao so aqui.
-- ---------------------------------------------------------------------------
comment on column public.conversas.status is
  'Estado BRUTO. A partir da migracao 47 ele NAO responde sozinho a "o agente esta '
  'pausado?": a expiracao e preguicosa, entao uma pausa vencida continua gravada '
  'como pausado ate a proxima escrita (a "lapide"). Quem quer a resposta chama '
  'public.pausa_vigente(...) ou public.conversa_status_efetivo(...). '
  'Ver docs/PAUSA-AUTOMATICA.md.';

comment on column public.conversas.motivo_pausa is
  'Quem pausou: manual (toggle do painel — NUNCA caduca) ou mensagem_humana (o '
  'caminho do n8n — caduca por tenants.pausa_expira_minutos). NULL so quando '
  'status <> pausado (constraint conversas_pausa_tem_motivo). A pausa da '
  'Tool - Transferir para Humano cai hoje em mensagem_humana; separa-la exige '
  'assinatura nova em api_n8n_definir_status_conversa.';

-- ---------------------------------------------------------------------------
-- 7. `api_n8n_definir_status_conversa` — MESMA assinatura, escreve o motivo.
--
--    Nao da para deduzir o motivo aqui dentro: os dois chamadores do n8n
--    (`agente-principal` no `Pausa Conversa`, e a `Tool - Transferir para
--    Humano`) passam 'pausado' fixo e sao indistinguiveis em SQL. Ambos sao
--    caminho de maquina, nenhum e clique de gente — entao 'mensagem_humana' e
--    correto para os dois hoje. O painel nao passa por aqui: faz UPDATE direto
--    na tabela e escreve 'manual'.
--
--    Sem esta secao a constraint `conversas_pausa_tem_motivo` derruba a pausa do
--    n8n na primeira mensagem humana depois de aplicada a migracao.
-- ---------------------------------------------------------------------------
create or replace function public.api_n8n_definir_status_conversa(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_status          text
) returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_status text;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_status not in ('ativo', 'pausado', 'resolvido') then
    raise exception 'api_n8n: status invalido: %', p_status using errcode = '22023';
  end if;

  update public.conversas
     set status        = p_status,
         -- Sem `case when ja estava pausado`: reescrever a cada chamada e o que
         -- faz `pausado_em` ser o carimbo da ULTIMA fala do humano, que e a
         -- premissa da janela inteira.
         pausado_em    = case when p_status = 'pausado' then now() else null end,
         motivo_pausa  = case when p_status = 'pausado' then 'mensagem_humana' else null end,
         atualizado_em = now()
   where tenant_id = p_tenant_id and conversation_id = p_conversation_id
  returning status into v_status;

  if v_status is null then
    raise exception 'api_n8n: conversa % nao encontrada no tenant', p_conversation_id
      using errcode = '02000';
  end if;

  return v_status;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 8. `api_n8n_conversa_sync` — MESMA assinatura, devolve o status EFETIVO.
--
--    E ISTO que deixa o `Nao Pausado?` do n8n intacto: aquele no le
--    `{{ $json.status }}` do `Sync Conversa`, que e o SELECT desta funcao.
--    Nenhum no muda; a resposta e que passa a ser honesta.
--
--    A janela vem para uma variavel antes do statement. Subquery em RETURNING
--    funciona no PG 17.6 (testado), mas variavel le melhor e nao depende disso.
--    O custo e uma leitura por PK em `tenants`, na chamada que ja faz outras.
-- ---------------------------------------------------------------------------
create or replace function public.api_n8n_conversa_sync(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_contact_name    text default null,
  p_phone           text default null
) returns table(status text, pausado_em timestamptz, historico_chars integer)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_historico integer;
  v_janela    integer;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_conversation_id is null then
    raise exception 'api_n8n: p_conversation_id e obrigatorio' using errcode = '22023';
  end if;

  -- A janela e DO TENANT desta chamada. `conversation_id` nao e unico entre
  -- tenants — dois clientes tem conversa 6 — entao ler a janela de qualquer
  -- outro lugar cruzaria os fios.
  select t.pausa_expira_minutos
    into v_janela
    from public.tenants t
   where t.id = p_tenant_id;

  -- Calculado ANTES do insert: o registro da mensagem atual so acontece depois
  -- da resposta, entao aqui o historico e exatamente o dos turnos anteriores.
  select coalesce(sum(length(m.conteudo)), 0)::integer
    into v_historico
  from (
    select l.conteudo
    from public.mensagens_log l
    where l.tenant_id = p_tenant_id
      and l.conversation_id = p_conversation_id
    order by l.criado_em desc
    limit 20
  ) m;

  return query
  insert into public.conversas as c (tenant_id, conversation_id, contact_name, phone)
  values (p_tenant_id, p_conversation_id, p_contact_name, p_phone)
  on conflict (tenant_id, conversation_id) do update
    set contact_name  = coalesce(excluded.contact_name, c.contact_name),
        phone         = coalesce(excluded.phone, c.phone),
        atualizado_em = now()
  returning public.conversa_status_efetivo(c.status, c.pausado_em, c.motivo_pausa, v_janela),
            -- `pausado_em` CRU de proposito: e diagnostico, e mentir aqui
            -- esconderia justamente o carimbo que explica a decisao.
            c.pausado_em,
            v_historico;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 9. `api_n8n_pode_transcrever` — MESMA assinatura, MESMO volatility (STABLE),
--    o predicado no lugar da comparacao crua.
--
--    `cv` e LEFT JOIN: conversa inexistente da `cv.status` nulo, o predicado
--    devolve false, e o comportamento e o mesmo do `coalesce(cv.status, 'ativo')
--    = 'pausado'` de antes.
-- ---------------------------------------------------------------------------
create or replace function public.api_n8n_pode_transcrever(
  p_tenant_id       uuid,
  p_conversation_id bigint
) returns table(
  tool_ativa       boolean,
  conversa_pausada boolean,
  chatwoot_url     text,
  chatwoot_token   text,
  limite_bytes     integer,
  msg_audio_longo  text,
  msg_audio_falhou text
)
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  return query
  select
    -- Mesma regra das outras portas: contratado E ativo. A migracao 30 existiu
    -- porque `api_n8n_config_tool` discordava disso.
    coalesce(tt.ativo and tt.contratado, false),
    -- MESMO predicado do `conversa_sync`. Duplicar a regra aqui produziria a
    -- divergencia exata que a 47 existe para impedir: o audio recusado por uma
    -- pausa que o bot ja considera vencida.
    public.pausa_vigente(cv.status, cv.pausado_em, cv.motivo_pausa, t.pausa_expira_minutos),
    t.chatwoot_url,
    c.chatwoot_token,
    -- ~270 KB ~= 3 min de nota de voz do WhatsApp (Opus ~1,5 KB/s). E PROXY, nao
    -- medida: a duracao exata so existe depois de transcrever.
    coalesce((tt.config ->> 'limite_bytes')::integer, 270000),
    coalesce(tt.config ->> 'msg_audio_longo',
             'Seu áudio é longo demais para eu ouvir. Pode resumir por escrito?'),
    coalesce(tt.config ->> 'msg_audio_falhou',
             'Não consegui entender seu áudio. Pode repetir ou escrever?')
  from public.tenants t
  left join public.tenant_credenciais c
         on c.tenant_id = t.id
  left join public.tenant_tools tt
         on tt.tenant_id = t.id and tt.tool_nome = 'transcricao_audio'
  left join public.conversas cv
         on cv.tenant_id = t.id and cv.conversation_id = p_conversation_id
  where t.id = p_tenant_id;
end;
$function$;

-- Sem `drop function` nas secoes 7, 8 e 9, o ACL das tres nunca foi apagado e
-- nao ha nada para reconceder. As linhas ficam aqui mesmo assim, e sao
-- inofensivas por serem idempotentes: se um dia alguem acrescentar um `drop` a
-- esta migracao, elas evitam que a 47 vire a sexta da familia 28/32/37/40/41.
-- `n8n_agent` e o role pelo qual o agente conecta — nao e `service_role`, e era
-- essa a linha que faltava na 40 e na 41.
grant execute on function public.api_n8n_definir_status_conversa(uuid, bigint, text) to service_role;
grant execute on function public.api_n8n_definir_status_conversa(uuid, bigint, text) to n8n_agent;
grant execute on function public.api_n8n_conversa_sync(uuid, bigint, text, text) to service_role;
grant execute on function public.api_n8n_conversa_sync(uuid, bigint, text, text) to n8n_agent;
grant execute on function public.api_n8n_pode_transcrever(uuid, bigint) to service_role;
grant execute on function public.api_n8n_pode_transcrever(uuid, bigint) to n8n_agent;

commit;
