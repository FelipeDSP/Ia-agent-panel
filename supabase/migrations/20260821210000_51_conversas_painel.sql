-- Migracao 51 — a view `conversas_painel`, e o fim da mentira da tela
--
-- NAO APLICADA EM PRODUCAO. Ao aplicar fora do CLI: escolha a versao ANTES,
-- renomeie ESTE arquivo e o rollback para ela, e grave a linha do ledger na
-- MESMA transacao — procedimento das 47, 48, 49 e 50. O topo do ledger e
-- `20260821200500` (50).
--
-- Numero pego LIVRE na hora de escrever, sem reserva: reservar a 48 para esta
-- view e o que produziu a disputa 48/49 e depois 49/50. Migracao nao escrita nao
-- tem numero.
--
-- ===================== O QUE ELA CONSERTA, MEDIDO ==========================
--
-- A 47 fez a pausa CADUCAR, mas o painel continua lendo `conversas.status` cru —
-- e `status` e LAPIDE desde entao: a expiracao e preguicosa, entao a linha
-- vencida segue gravada como 'pausado' ate a proxima escrita.
--
-- Medido em 2026-08-21 com as claims reais do `emporio`:
--
--   status_bruto   = 'pausado' em 10 conversas
--   status_efetivo = 'pausado' em  1
--   => 9 conversas em que o bot esta atendendo e a tela diz "pausado"
--
-- A unica realmente pausada e a da Karen, `motivo_pausa = 'manual'`, ~1800 min
-- sem caducar — comportamento correto, e a prova de que a regra funciona.
--
-- ===================== `security_invoker` NAO E ESTILO =====================
--
-- E a linha mais perigosa desta migracao, e o motivo foi MEDIDO, nao presumido.
-- Duas views identicas criadas em transacao abortada, lidas por `authenticated`
-- com claims de um tenant:
--
--   view SEM security_invoker  ->  89 linhas, 5 tenants distintos
--   view COM security_invoker  ->  16 linhas, 1 tenant
--   a tabela direta            ->  16 linhas
--
-- Sem a opcao, a view entrega o catalogo de conversas de TODOS os clientes a
-- qualquer usuario logado — nome do contato e telefone incluidos.
--
-- E O `FORCE ROW LEVEL SECURITY` NAO PROTEGE. `conversas` tem
-- `relforcerowsecurity = true`, e e tentador ler isso como rede de seguranca.
-- Nao e: FORCE sujeita o DONO da tabela a policy, e nao vence `BYPASSRLS`. O
-- dono e `postgres`, e `postgres` tem `rolbypassrls = true` (medido; ele NAO e
-- superusuario neste projeto, mas tem o atributo). View sem `security_invoker`
-- roda como o dono dela — `postgres` — e passa por cima de tudo.
--
-- A policy que a view passa a respeitar e `p_conversas_all`, PERMISSIVE, para
-- TODOS os comandos e TODOS os roles (`polroles` nulo):
--
--   using / with check: auth_is_super_admin() OR tenant_id = auth_tenant_id()
--
-- A view faz join em `tenants`, que tem RLS propria e mais granular
-- (`p_tenants_select`: super_admin OU `id = auth_tenant_id()`). Conferido que o
-- join NAO zera a view: `authenticated` tem SELECT em `tenants` e enxerga a
-- propria linha. Se um dia aquela policy apertar, esta view esvazia — e o
-- sintoma seria "sumiram minhas conversas", nao "vazou".
--
-- ===================== POR QUE NAO `cv.*`, E POR QUE `status_bruto` ========
--
-- A lista de colunas e EXPLICITA, e a coluna crua se chama `status_bruto`. As
-- duas escolhas sao contra a mesma armadilha, por caminhos diferentes.
--
-- Contra `cv.*`: uma view com `*` nao tem contrato proprio — ela e o que a
-- tabela por acaso tem. A 47 acrescentou `motivo_pausa` a `conversas`; se esta
-- view ja existisse com `cv.*`, teria mudado de forma sozinha, sem migracao e
-- sem revisao. Cinco call sites dependem dela; o contrato tem de estar escrito.
--
-- Contra manter o nome `status`: expor `status` e `status_efetivo` lado a lado
-- e convidar a ler o errado, e o erro seria SILENCIOSO — a tela voltaria a
-- mentir exatamente como mente hoje, so que com a view instalada e todo mundo
-- achando que o problema estava resolvido. Com o nome `status_bruto`, um
-- `.select('status')` na view **estoura** ("column does not exist") em vez de
-- devolver a resposta errada. Falha alta no lugar da calada, que e a escolha
-- que este projeto faz em todo lugar.
--
-- E o cru NAO e omitido, porque tem um leitor legitimo: quem investiga a lapide.
-- Ver `status_efetivo = 'ativo'` com `status_bruto = 'pausado'` e a unica forma
-- de reconhecer uma pausa vencida ainda gravada. Omitir tornaria isso invisivel.
--
-- A ESCRITA NAO PASSA POR AQUI. O toggle continua em
-- `.from('conversas').update({ status, pausado_em, motivo_pausa })`, na TABELA.
-- Esta view e so leitura, e por isso nao precisa ser atualizavel nem ter
-- `with check option`.
--
-- ===================== ORDEM DE IMPLANTACAO — SQL PRIMEIRO =================
--
-- E a escolha e explicita, nao herdada: esta migracao tem a forma da 48, nao a
-- da 47.
--
--   - na 47 havia janela nos DOIS sentidos (a constraint recusava o toggle
--     velho; o codigo novo estourava sem a coluna), e a ordem foi escolha do
--     menos pior;
--   - aqui NAO ha janela: a view nasce sem leitor nenhum e fica inerte ate o
--     codigo subir. SQL primeiro e estritamente seguro.
--
-- A ordem inversa (codigo antes) faz o painel de conversas inteiro estourar em
-- `relation "public.conversas_painel" does not exist` — nao e degradacao, e
-- pagina fora do ar.

begin;

-- ---------------------------------------------------------------------------
-- A view. `create or replace` NAO serve quando a lista de colunas muda, e como
-- esta view ainda nao existe o `drop ... if exists` deixa a migracao
-- reexecutavel sem depender disso.
-- ---------------------------------------------------------------------------
drop view if exists public.conversas_painel;

create view public.conversas_painel
with (security_invoker = true)
as
select
  cv.id,
  cv.tenant_id,
  cv.conversation_id,
  cv.contact_name,
  cv.phone,

  -- O CRU, com nome que avisa. Ver o cabecalho: `status` seria lido por engano.
  cv.status as status_bruto,
  cv.pausado_em,
  cv.motivo_pausa,
  cv.criado_em,
  cv.atualizado_em,

  -- O EFETIVO. A regra nao esta aqui: delega aos predicados da 47, que tem
  -- outros tres leitores (`api_n8n_conversa_sync`, `api_n8n_pode_transcrever` e
  -- `api_n8n_conversa_pausada`). Predicado duplicado diverge, e diverge
  -- exatamente entre "o painel diz pausada" e "o bot ja respondeu".
  public.conversa_status_efetivo(
    cv.status, cv.pausado_em, cv.motivo_pausa, t.pausa_expira_minutos) as status_efetivo,
  public.pausa_vigente(
    cv.status, cv.pausado_em, cv.motivo_pausa, t.pausa_expira_minutos) as pausa_vigente,

  -- QUANDO O AGENTE VOLTA. Nulo quando nao ha volta programada — e sao dois
  -- casos diferentes que colapsam no mesmo nulo de proposito, porque a tela nao
  -- tem o que dizer em nenhum deles: conversa nao pausada, e pausa MANUAL, que
  -- nao caduca (so sai no clique).
  case
    when cv.status = 'pausado' and cv.motivo_pausa = 'mensagem_humana' and cv.pausado_em is not null
    then cv.pausado_em + make_interval(mins => t.pausa_expira_minutos)
  end as pausa_expira_em

from public.conversas cv
join public.tenants t on t.id = cv.tenant_id;

comment on view public.conversas_painel is
  'Leitura do painel sobre conversas, com a pausa JA RESOLVIDA (migracao 51). '
  'security_invoker = true e obrigatorio: sem ele a view roda como postgres, que '
  'tem BYPASSRLS, e entrega as conversas de TODOS os clientes — medido, 89 linhas '
  'de 5 tenants contra 16 de 1. A escrita NAO passa por aqui: o toggle continua '
  'atualizando public.conversas.';

comment on column public.conversas_painel.status_bruto is
  'O `conversas.status` cru, e a lapide da expiracao preguicosa: uma pausa vencida '
  'segue gravada como ''pausado'' ate a proxima escrita. NAO use para decidir se o '
  'agente esta pausado — use `status_efetivo`. O nome e diferente de proposito, '
  'para que ler o errado estoure em vez de devolver resposta errada.';

comment on column public.conversas_painel.status_efetivo is
  'O status que vale AGORA: ''ativo'' quando a pausa caducou, mesmo com '
  'status_bruto = ''pausado''. E o que a tela deve mostrar.';

comment on column public.conversas_painel.pausa_expira_em is
  'Quando o agente volta sozinho. NULO quando nao ha volta programada: conversa '
  'nao pausada, ou pausa MANUAL — que nunca caduca e so sai no clique.';

-- ===================== O `revoke` NAO E ZELO: SEM ELE O `grant` E DECORATIVO =
--
-- Este projeto tem `ALTER DEFAULT PRIVILEGES` que concede **`arwdDxtm` (TUDO)**
-- a `anon`, `authenticated` e `service_role` em toda tabela e view nova em
-- `public`. Medido: uma view criada sem nenhum `grant` nasce com
--
--   {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
--    authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
--
-- Ou seja: escrever so `grant select to authenticated` nao restringe NADA — a
-- view ja nasceu legivel e gravavel por `anon`. A primeira versao desta migracao
-- fazia exatamente isso, e o teste pegou: `anon` leu a view.
--
-- O que segurava era so a RLS (`anon` sem JWT tem `auth_tenant_id()` nulo e ve
-- zero linhas). Isso e rede de seguranca funcionando, nao permissao correta — e
-- a regra 6 do CLAUDE.md e explicita: RLS e a segunda camada, nao a primeira.
--
-- Com o `revoke` abaixo, medido: `anon` passa a receber `42501 permission denied
-- for view`, e `authenticated` fica so-leitura (o `delete` tambem da 42501).
--
-- `authenticated` e `service_role` bastam, e com `security_invoker` o invocador
-- ainda precisa de SELECT nas tabelas de base — conferido que os dois ja tem, em
-- `conversas` e em `tenants`. Os predicados da 47 tambem ja estao concedidos a
-- `authenticated` (foi escrito la, antecipando esta view).
revoke all on public.conversas_painel from public;
revoke all on public.conversas_painel from anon;
revoke all on public.conversas_painel from authenticated;
revoke all on public.conversas_painel from service_role;

grant select on public.conversas_painel to authenticated;
grant select on public.conversas_painel to service_role;

commit;
