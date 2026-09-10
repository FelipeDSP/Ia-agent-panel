-- =====================================================================
-- 61. Pagamento via Asaas — o esqueleto de banco (SANDBOX)
-- =====================================================================
--
-- O AGENTE NUNCA CONFIRMA PAGAMENTO. O webhook confirma; o agente comunica.
--
-- Nao existe funcao aqui que um modelo possa chamar para marcar `pago`. A
-- unica que escreve esse status e `api_n8n_pagamento_webhook`, que exige o
-- TOKEN do webhook — um segredo que o modelo nao tem e que nao viaja em
-- nenhuma tool. Isso nao e vocabulario: e a diferenca entre "o modelo nao
-- deveria" e "o modelo nao consegue", e este projeto ja mediu oito vezes que
-- a primeira forma nao segura.
--
-- ESCOPO: SANDBOX. Nada aqui contrata a tool para ninguem — aplicar esta
-- migracao nao liga pagamento em tenant nenhum (`teste:pagamento-asaas` afirma
-- isso contando antes x depois).
--
-- ---------------------------------------------------------------------
-- O QUE A DOCUMENTACAO DO ASAAS DIZ, E O QUE ELA NAO DIZ (lida em 10/09/2026)
-- ---------------------------------------------------------------------
-- MEDIDO NA DOCUMENTACAO, e cada um destes mudou alguma decisao abaixo:
--
--   1. `endDate` do link de pagamento e uma DATA, nao data-hora — o proprio
--      exemplo da referencia e "2024-09-05". **Uma janela de 30 minutos NAO
--      cabe nesse campo.** O enunciado pedia "vencimento alinhado a janela do
--      tenant, para que os dois expirem juntos"; com granularidade de dia isso
--      e impossivel pelo campo. Ver a secao ALINHAMENTO logo abaixo;
--   2. entrega e AT LEAST ONCE e a propria doc manda deduplicar: "O mesmo
--      evento pode ser enviado mais de uma vez"; "Use o campo `id` como chave
--      unica"; "Nao repita a regra de negocio quando o evento ja tiver sido
--      processado". O `id` tem a forma
--      `evt_05b708f961d739ea7eba7e4db318f621&368604920`;
--   3. o webhook autentica por header `asaas-access-token`, com token de 32 a
--      255 caracteres, "sem espacos, sem sequencias simples e NAO pode ser uma
--      API Key do Asaas" — dai o CHECK de tamanho e as colunas separadas;
--   4. **15 falhas consecutivas INTERROMPEM a fila** do webhook, e a
--      reativacao e manual. Nao e "perde um evento": e para de chegar tudo. Por
--      isso o processamento e curto e a funcao devolve estado em vez de
--      estourar — quem responde 500 quinze vezes fica sem webhook nenhum;
--   5. `PAYMENT_RECEIVED` e o evento de Pix e boleto; `PAYMENT_CONFIRMED` e
--      estado intermediario de cartao. **Os dois sao aceitos e sao eventos
--      DIFERENTES, com `id` diferente** — a deduplicacao por `id` NAO impede o
--      segundo de chegar, e e por isso que a idempotencia aqui tem duas
--      camadas (ver IDEMPOTENCIA);
--   6. base de sandbox: `https://api-sandbox.asaas.com`; header de
--      autenticacao da API: `access_token`.
--
-- A DOCUMENTACAO NAO DIZ — e isto e o que sobra em aberto:
--
--   **O QUE ACONTECE COM UMA TENTATIVA DE PAGAMENTO EM LINK EXPIRADO OU
--   DESATIVADO.** Foram lidas quatro paginas (criar, atualizar, remover, o guia
--   de links) e nenhuma descreve o comportamento da pagina de pagamento depois
--   de `endDate` ou de `active=false`. O enunciado mandava: "Se a documentacao
--   nao disser com clareza, teste no sandbox — nao assuma."
--
--   A SONDA RODOU EM 10/09/2026 e a resposta e PARCIAL, entao ela fica escrita
--   como parcial:
--
--     EXPIRADO   (a pergunta original) : NAO MEDIDO. Nao da para produzir um
--       link expirado sob demanda — o Asaas recusa `endDate` no passado tanto na
--       CRIACAO quanto no `PUT`. O caminho que resta e `endDate` = hoje e um
--       `GET` amanha, e ele nao cabe numa sonda que se roda para decidir agora.
--     DESATIVADO (`active=false`)      : a pagina publica RECUSA, com todas as
--       letras — "Seu fornecedor desabilitou esse link de pagamento".
--
--   Os dois NAO sao a mesma coisa e nao estao escritos como se fossem. Enquanto
--   `fora_do_prazo` continuar possivel, este schema o trata — e e por isso que
--   existe `fora_do_prazo_em`. Detalhe completo em
--   docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md §6.
--
--   E MEDIDO NA MESMA RODADA, pela recusa e nao pela doc:
--   **Pix e boleto tem VALOR MINIMO de R$ 5,00.** Ver a coluna
--   `tenants.pagamento_minimo_centavos` e o motivo `abaixo_do_minimo`.
--
-- ---------------------------------------------------------------------
-- ALINHAMENTO DA JANELA — o que da para fazer, ja que `endDate` nao serve
-- ---------------------------------------------------------------------
-- A autoridade sobre o prazo passa a ser NOSSA e fica em
-- `pedido_cobrancas.expira_em`, com precisao de segundo, calculada de
-- `tenants.pagamento_expira_minutos`. O `endDate` do Asaas vai para o DIA da
-- expiracao — e um teto grosseiro, nao o alinhamento.
--
-- O alinhamento fino, quando for preciso, e um `PUT /v3/paymentLinks/{id}`
-- com `active=false` na hora em que a nossa janela vence. Isso NAO esta nesta
-- migracao: e passo de fluxo, depende da sonda acima (desativar um link cujo
-- comportamento nao conhecemos e trocar um desconhecido por outro), e a
-- decisao de quando dispara-lo — preguicoso, como a expiracao de pedido, ou
-- agendado — nao esta tomada.
--
-- **CONSEQUENCIA QUE PRECISA ESTAR ESCRITA: enquanto isso, o link continua
-- pagavel depois de a nossa janela fechar.** Nao e defeito desta migracao, e o
-- estado de fato — e e exatamente o que o caminho `fora_do_prazo` trata. O
-- enunciado ja previa: "a expiracao e nossa, o dinheiro e do Asaas".
--
-- ---------------------------------------------------------------------
-- IDEMPOTENCIA EM DUAS CAMADAS, E UMA SO NAO BASTA
-- ---------------------------------------------------------------------
--   camada 1 — POR EVENTO: `uq_pagamento_eventos_evento` em
--     (tenant_id, evento_id). Reenvio do MESMO evento nao passa do insert.
--   camada 2 — POR ESTADO: `update pedidos set status='pago' where status =
--     'aguardando_pagamento'` e `update pedido_cobrancas ... where pago_em is
--     null`. Eventos DIFERENTES sobre o mesmo pagamento (CONFIRMED depois de
--     RECEIVED) passam pela camada 1 e morrem aqui.
--
-- Uma so seria falso conforto: a camada 1 sozinha deixa o par
-- CONFIRMED/RECEIVED aplicar duas vezes, e a camada 2 sozinha deixa dois
-- registros e duas notificacoes para o mesmo evento reenviado.
--
-- `aplicou` so e verdadeiro na transicao real, e e ele que autoriza a
-- notificacao. Duas confirmacoes NAO viram duas mensagens.
--
-- ---------------------------------------------------------------------
-- POR QUE DUAS COLUNAS DE CHAVE POR AMBIENTE, E NAO UMA
-- ---------------------------------------------------------------------
-- `asaas_api_key_sandbox` e `asaas_api_key_producao` convivem, e
-- `asaas_ambiente` diz qual vale. Migrar para producao vira VIRAR UM
-- ENUM — auditavel, reversivel, e a chave de sandbox continua la para testar.
-- Uma coluna so faria da migracao uma troca de string no escuro, que e
-- literalmente o que o enunciado proibiu.
--
-- **A URL BASE E DERIVADA, NUNCA GUARDADA.** Guardar a URL ao lado da chave
-- permite o estado impossivel "chave de sandbox apontando para producao", e
-- esse estado nao da erro: da cobranca de verdade com credencial de teste, ou
-- o contrario. `api_n8n_credencial_asaas` calcula a URL do ambiente.
--
-- E o TOKEN DO WEBHOOK segue o mesmo par, com uma consequencia que vale
-- escrever: **so o token do ambiente ATIVO autentica.** Um token de sandbox
-- esquecido para de valer no instante em que o tenant vira producao, sem
-- ninguem ter de lembrar de apaga-lo.
--
-- ---------------------------------------------------------------------
-- `api_n8n_estado_pedido` MUDA DE ASSINATURA -> `drop function` OBRIGATORIO
-- ---------------------------------------------------------------------
-- Ela ganha `pagamento_confirmado`. `create or replace` NAO troca o tipo de
-- retorno (`42P13`), entao aqui nao ha escolha: e `drop function` pela LISTA
-- COMPLETA DE TIPOS, e com ele vao TODOS os grants (a armadilha das 40 e 41).
-- O bloco de `revoke` + os DOIS `grant` (`service_role` E `n8n_agent`) esta
-- logo abaixo do recreate, e o teste confere o ACL por DIFF contra o de antes,
-- nao contra a lista que eu escrevi.
--
-- POR QUE UMA COLUNA NOVA, e nao ler `pedido_status = 'pago'`: `pedido_status`
-- e do pedido da JANELA (tocado no turno) ou do rascunho. O cliente que pagou e
-- volta a perguntar "caiu?" uma hora depois nao tem pedido na janela e nao tem
-- rascunho — `tem_pedido` seria falso e a regra 3 do portao barraria uma
-- resposta CORRETA, mandando "ainda nao tenho nenhum item anotado" para quem
-- acabou de pagar. `pagamento_confirmado` olha o pedido MAIS RECENTE da
-- conversa, fora da janela, e por isso responde essa pergunta.
--
-- E `escreveu_neste_turno` passa a contar `pedido_cobrancas` tambem: gerar o
-- link e escrita do turno. Sem isso a mensagem que ENTREGA o link ("Prontinho!
-- aqui esta o link") cairia na regra 1 — afirma efeito consumado, e nenhuma
-- linha de `pedidos` se mexeu.
--
-- ---------------------------------------------------------------------
-- DINHEIRO: integer em centavos em todo o caminho. O valor da cobranca sai de
-- `pedidos.total_centavos` DENTRO da funcao. Nao existe parametro de valor em
-- nenhuma funcao desta migracao — nao ha o que o agente possa passar.
--
-- SEM PII NO LOG: `pagamento_eventos` guarda ids, evento, valor e veredito.
-- NAO guarda o payload cru, que traz nome e documento do pagador. O que ele
-- resolve — auditar e deduplicar — nao precisa de nenhum dado pessoal, e o que
-- nao e guardado nao vaza.
--
-- ROLLBACK: 20260910230000_61_pagamento_asaas_sandbox_rollback.sql
-- =====================================================================

begin;

-- =====================================================================
-- 1. CREDENCIAL DO ASAAS, POR TENANT E POR AMBIENTE
-- =====================================================================
-- `tenant_credenciais` ja e a casa do token do Chatwoot desde a 21a, e ja
-- nasce fechada: a policy e `auth_is_super_admin()` e mais nada. Chave de
-- pagamento entra aqui pelo mesmo motivo que o token entrou — RLS nao filtra
-- COLUNA, e credencial da agencia nao pode viajar junto com dado do tenant.

alter table public.tenant_credenciais
  add column if not exists asaas_ambiente               text not null default 'sandbox',
  add column if not exists asaas_api_key_sandbox        text,
  add column if not exists asaas_api_key_producao       text,
  add column if not exists asaas_webhook_token_sandbox  text,
  add column if not exists asaas_webhook_token_producao text;

alter table public.tenant_credenciais
  drop constraint if exists tenant_credenciais_asaas_ambiente_valido;
alter table public.tenant_credenciais
  add constraint tenant_credenciais_asaas_ambiente_valido
  check (asaas_ambiente in ('sandbox', 'producao'));

-- 32 a 255 e a regra do proprio Asaas para o token do webhook. O CHECK existe
-- porque token curto demais e recusado LA, na hora de cadastrar o webhook — e
-- descobrir isso no cadastro e melhor que descobrir com a fila interrompida.
alter table public.tenant_credenciais
  drop constraint if exists tenant_credenciais_asaas_token_tamanho;
alter table public.tenant_credenciais
  add constraint tenant_credenciais_asaas_token_tamanho
  check (
    (asaas_webhook_token_sandbox  is null or length(asaas_webhook_token_sandbox)  between 32 and 255)
    and
    (asaas_webhook_token_producao is null or length(asaas_webhook_token_producao) between 32 and 255)
  );

-- =====================================================================
-- 2. A JANELA, POR TENANT
-- =====================================================================
-- Ao lado de `debounce_segundos` e `pausa_expira_minutos`, e pelo mesmo
-- motivo: uma padaria e um curso on-line nao tem a mesma janela.
--
-- NASCE AGENCIA-ONLY DE GRACA, e isso e propriedade e nao sorte:
-- `tenants_guard_colunas` compara `to_jsonb(new) - <lista branca>` com
-- `to_jsonb(old) - <lista branca>`, entao COLUNA QUE NAO ESTA NA LISTA e
-- imutavel para `tenant_admin` — `42501`. Para o cliente editar isso um dia,
-- e mexer na lista branca, em migracao propria e consciente.
alter table public.tenants
  add column if not exists pagamento_expira_minutos integer not null default 30;

alter table public.tenants
  drop constraint if exists tenants_pagamento_expira_valido;
alter table public.tenants
  add constraint tenants_pagamento_expira_valido
  check (pagamento_expira_minutos between 1 and 10080);   -- 1 min a 7 dias

-- ---------------------------------------------------------------------
-- O PISO DO PROVEDOR — COLUNA, E NAO CONSTANTE NO CODIGO
-- ---------------------------------------------------------------------
-- **Pix e boleto no Asaas tem valor minimo de R$ 5,00.** Nao foi lido em
-- documentacao: foi o sandbox recusando a criacao em 10/09/2026 com
-- "O valor minimo para cobrancas via Boleto e Pix e R$ 5,00."
--
-- Ele e COLUNA por um motivo que este projeto ja pagou: e numero de TERCEIRO,
-- pode mudar quando o Asaas quiser, e cravado em codigo vira `S = 622` — medido
-- certo num dia, silenciosamente errado depois, e sem ninguem para ligar "o
-- provedor mudou a regra" a "o numero no codigo envelheceu". Aqui muda sem
-- deploy.
--
-- POR TENANT e nao global porque e onde as outras configuracoes de pagamento
-- ja moram, e porque o dia em que o provedor for outro para um cliente, o piso
-- e dele. Continua nascendo agencia-only pela mesma lista branca.
--
-- QUANTO ISSO MORDE, MEDIDO EM PRODUCAO EM 10/09/2026: dos 14 pedidos ja
-- feitos, NENHUM ficaria abaixo (menor do `emporio` R$ 12,00, media R$ 32,36;
-- menor do `sendbox` R$ 69,90). Mas 3 dos 41 produtos do `emporio` custam menos
-- de R$ 5,00, e o pao de queijo (R$ 1,50) e um deles — dois paes de queijo dao
-- R$ 3,00 e NAO PODEM SER COBRADOS. Improvavel nao e impossivel.
alter table public.tenants
  add column if not exists pagamento_minimo_centavos integer not null default 500;

alter table public.tenants
  drop constraint if exists tenants_pagamento_minimo_valido;
alter table public.tenants
  add constraint tenants_pagamento_minimo_valido
  check (pagamento_minimo_centavos >= 0);

-- =====================================================================
-- 3. O VINCULO PEDIDO <-> COBRANCA
-- =====================================================================
-- Chave unica de `pedidos` por (tenant_id, id), para a FK COMPOSTA abaixo. E o
-- mesmo arranjo da 57 em `categorias`: sem ela, uma FK simples por `pedido_id`
-- permitiria uma cobranca do tenant A apontar para um pedido do tenant B —
-- RLS nao valida FK.
create unique index if not exists uq_pedidos_tenant_id
  on public.pedidos (tenant_id, id);

create table if not exists public.pedido_cobrancas (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  pedido_id        uuid not null,
  -- redundante com `pedidos.conversation_id` de proposito: o webhook precisa
  -- saber PARA ONDE avisar sem um join a mais no caminho quente, e o pedido nao
  -- muda de conversa.
  conversation_id  bigint not null,
  provedor         text not null default 'asaas',
  ambiente         text not null,
  valor_centavos   integer not null,
  -- A AUTORIDADE SOBRE O PRAZO. Nao e o `endDate` do Asaas (que e uma data) e
  -- nao e `pedidos.atualizado_em` (que qualquer update mexe — ver
  -- PENDENCIA-EXPIRACAO-PEDIDO.md). E este campo, com precisao de segundo.
  expira_em        timestamptz not null,

  -- fase 2: o que o Asaas devolveu
  link_id          text,
  url              text,
  falhou_em        timestamptz,
  detalhe          text,

  -- fase 3: o que o webhook aplicou
  pagamento_id     text,
  pago_em          timestamptz,
  pago_centavos    integer,
  -- pagamento que chegou DEPOIS da nossa janela. O pedido nao reabre; isto
  -- marca o caso para o humano.
  fora_do_prazo_em timestamptz,
  notificado_em    timestamptz,

  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),

  constraint pedido_cobrancas_ambiente_valido check (ambiente in ('sandbox', 'producao')),
  constraint pedido_cobrancas_valor_positivo  check (valor_centavos > 0),
  -- NAO existe CHECK ligando `pago_em` a `pagamento_id`. Chegou a ser escrito e
  -- foi retirado antes de sair: o caminho `fora_do_prazo` grava `pagamento_id`
  -- SEM `pago_em` de proposito — e um pagamento que existe no Asaas e que nos
  -- nao aceitamos —, e a regra "so tem id de pagamento quem pagou" o proibiria
  -- justamente no caso que ela pareceria proteger.
  constraint pedido_cobrancas_pedido_fk
    foreign key (tenant_id, pedido_id) references public.pedidos (tenant_id, id)
    on update cascade on delete cascade
);

-- `tenant_id` primeiro em todo indice composto (regra 3 do CLAUDE.md).
create index if not exists idx_pedido_cobrancas_tenant_pedido
  on public.pedido_cobrancas (tenant_id, pedido_id);
create index if not exists idx_pedido_cobrancas_tenant_conversa
  on public.pedido_cobrancas (tenant_id, conversation_id, criado_em desc);
-- Os dois caminhos por onde o webhook acha a cobranca.
create unique index if not exists uq_pedido_cobrancas_link
  on public.pedido_cobrancas (tenant_id, link_id) where link_id is not null;
create unique index if not exists uq_pedido_cobrancas_pagamento
  on public.pedido_cobrancas (tenant_id, pagamento_id) where pagamento_id is not null;

drop trigger if exists trg_pedido_cobrancas_upd on public.pedido_cobrancas;
create trigger trg_pedido_cobrancas_upd
  before update on public.pedido_cobrancas
  for each row execute function public.set_atualizado_em();

alter table public.pedido_cobrancas enable row level security;

drop policy if exists p_pedido_cobrancas_leitura on public.pedido_cobrancas;
create policy p_pedido_cobrancas_leitura on public.pedido_cobrancas
  for select using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

-- Objeto novo neste projeto NASCE COM `arwdDxtm` para `anon` — medido em
-- 2026-08-21. `grant` sem `revoke` antes e decoracao sobre o que ja estava
-- aberto.
revoke all on public.pedido_cobrancas from public;
revoke all on public.pedido_cobrancas from anon;
revoke all on public.pedido_cobrancas from authenticated;
revoke all on public.pedido_cobrancas from service_role;
grant select on public.pedido_cobrancas to authenticated;
grant select on public.pedido_cobrancas to service_role;

-- =====================================================================
-- 4. O REGISTRO DE QUE O WEBHOOK CHEGOU
-- =====================================================================
-- SEM PAYLOAD CRU: o corpo do webhook do Asaas traz nome e documento do
-- pagador. Nada aqui precisa deles — deduplicar precisa do `id` do evento,
-- auditar precisa do veredito. O que nao e guardado nao vaza.
create table if not exists public.pagamento_eventos (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  -- `evt_05b708f961d739ea7eba7e4db318f621&368604920` — a chave de deduplicacao
  -- que a propria doc do Asaas manda usar.
  evento_id      text not null,
  evento         text not null,
  pagamento_id   text,
  link_id        text,
  valor_centavos integer,
  cobranca_id    uuid,
  pedido_id      uuid,
  -- `aplicou` e diferente de "chegou": regra que nunca dispara e regra que
  -- nunca e avaliada parecem iguais no log, e so este par as separa.
  aplicou        boolean not null default false,
  motivo         text not null,
  recebido_em    timestamptz not null default now()
);

-- CAMADA 1 DA IDEMPOTENCIA. Sem ela o reenvio do mesmo evento vira segundo
-- registro e segunda notificacao.
create unique index if not exists uq_pagamento_eventos_evento
  on public.pagamento_eventos (tenant_id, evento_id);
create index if not exists idx_pagamento_eventos_tenant_recebido
  on public.pagamento_eventos (tenant_id, recebido_em desc);

alter table public.pagamento_eventos enable row level security;

drop policy if exists p_pagamento_eventos_leitura on public.pagamento_eventos;
create policy p_pagamento_eventos_leitura on public.pagamento_eventos
  for select using (public.auth_is_super_admin() or tenant_id = public.auth_tenant_id());

revoke all on public.pagamento_eventos from public;
revoke all on public.pagamento_eventos from anon;
revoke all on public.pagamento_eventos from authenticated;
revoke all on public.pagamento_eventos from service_role;
grant select on public.pagamento_eventos to authenticated;
grant select on public.pagamento_eventos to service_role;

-- =====================================================================
-- 5. A TOOL NO CATALOGO — e SO no catalogo
-- =====================================================================
-- Inserir no catalogo NAO contrata para ninguem: `tenant_tools` fica intocada.
-- Aplicar esta migracao nao liga pagamento em tenant nenhum, e o teste conta
-- antes x depois em vez de afirmar o estado do mundo.
insert into public.catalogo_tools (tool_nome, nome_exibicao, descricao_padrao, tipo, ativo)
values ('pagamento', 'Pagamento pelo agente',
        'Gera o link de pagamento do pedido fechado. O agente NUNCA confirma pagamento — quem confirma e o webhook do provedor.',
        'tool_modelo', true)
on conflict (tool_nome) do nothing;

-- =====================================================================
-- 6. api_n8n_credencial_asaas — o UNICO caminho ate a chave
-- =====================================================================
-- Mesma forma de `api_n8n_credencial_chatwoot`: a tool nunca le
-- `tenant_credenciais` direto; le por esta funcao, que e SECURITY DEFINER e e
-- o que da acesso a tabela fechada.
-- `drop` antes do `create`: esta funcao devolve TABLE, e mexer na lista de
-- colunas depois de aplicada exigiria o drop de qualquer jeito (`42P13`). Com
-- ele aqui, a migracao e replayavel sobre qualquer versao anterior de si mesma —
-- e os grants logo abaixo sao obrigatorios porque o drop os apaga.
drop function if exists public.api_n8n_credencial_asaas(uuid);

create or replace function public.api_n8n_credencial_asaas(p_tenant_id uuid)
returns table(ativa boolean, ambiente text, base_url text, api_key text,
              webhook_token text, expira_minutos integer, minimo_centavos integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_amb   text;
  v_ativa boolean;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  select coalesce(tc.asaas_ambiente, 'sandbox')
    into v_amb
  from public.tenants t
  left join public.tenant_credenciais tc on tc.tenant_id = t.id
  where t.id = p_tenant_id;

  -- `contratado` (agencia) E `ativo` (cliente), igual a `api_n8n_config_tool`.
  select coalesce(tt.ativo and tt.contratado, false)
    into v_ativa
  from public.tenant_tools tt
  where tt.tenant_id = p_tenant_id and tt.tool_nome = 'pagamento';

  return query
  select
    coalesce(v_ativa, false),
    v_amb,
    -- DERIVADA do ambiente, nunca guardada: guardar a URL ao lado da chave
    -- permite "chave de sandbox contra o host de producao", que nao da erro —
    -- da cobranca de verdade com credencial de teste.
    case v_amb when 'producao' then 'https://api.asaas.com'
                else 'https://api-sandbox.asaas.com' end,
    case v_amb when 'producao' then tc.asaas_api_key_producao
                else tc.asaas_api_key_sandbox end,
    case v_amb when 'producao' then tc.asaas_webhook_token_producao
                else tc.asaas_webhook_token_sandbox end,
    t.pagamento_expira_minutos,
    t.pagamento_minimo_centavos
  from public.tenants t
  left join public.tenant_credenciais tc on tc.tenant_id = t.id
  where t.id = p_tenant_id;
end;
$function$;

revoke all on function public.api_n8n_credencial_asaas(uuid) from public;
revoke all on function public.api_n8n_credencial_asaas(uuid) from anon;
revoke all on function public.api_n8n_credencial_asaas(uuid) from authenticated;
grant execute on function public.api_n8n_credencial_asaas(uuid) to service_role;
grant execute on function public.api_n8n_credencial_asaas(uuid) to n8n_agent;

-- =====================================================================
-- 7. api_n8n_gerar_cobranca — RESERVA (fase 1 de 2)
-- =====================================================================
-- NAO RECEBE VALOR, NAO RECEBE PRODUTO, NAO RECEBE NOME DE ITEM. Recebe tenant
-- e conversa, le o pedido e usa `total_centavos` do banco. Nao ha parametro
-- que o agente possa envenenar porque nao ha parametro.
--
-- Ela NAO chama o Asaas (o banco nao faz HTTP): devolve o que o fluxo precisa
-- POSTar, mais a credencial. Quem grava o que voltou e
-- `api_n8n_registrar_cobranca`. E o mesmo par reserva/confirma de
-- `api_n8n_notificar_venda` + `api_n8n_confirmar_notificacao`.
--
-- REUSO: chamada duas vezes no mesmo pedido, devolve a MESMA cobranca viva
-- (`ja_existia = true`) em vez de criar um segundo link. Dois links vivos para
-- um pedido e o caminho mais curto para cobrar duas vezes.
--
-- ---------------------------------------------------------------------
-- UMA SAIDA SO, E ISSO NAO E ESTILO
-- ---------------------------------------------------------------------
-- A primeira versao tinha SETE `return query select` com listas posicionais de
-- quinze colunas cada. Acrescentar uma coluna significava acertar sete listas na
-- mao, e uma trocada de posicao entre dois `null::integer` nao da erro nenhum —
-- da valor no campo errado, em silencio, no caminho do dinheiro. Agora as
-- decisoes so escrevem `v_motivo`, e a montagem do retorno acontece UMA vez.
--
-- ---------------------------------------------------------------------
-- O PISO DE R$ 5,00 NAO CHEGA AO AGENTE COMO ERRO
-- ---------------------------------------------------------------------
-- Pedido abaixo do minimo devolve `motivo = 'abaixo_do_minimo'` com
-- `minimo_centavos` e `faltam_centavos` — informacao que o modelo sabe tratar.
-- Deixar o 400 do Asaas ("O valor minimo para cobrancas via Boleto e Pix e
-- R$ 5,00") chegar cru seria pedir para o modelo improvisar em cima de erro de
-- integracao, que e exatamente o comportamento que o portao existe para conter.
--
-- E o que fazer com ele e decisao de produto, escrita em
-- docs/ENTREGA-PAGAMENTO-ASAAS-SANDBOX.md §7: cair para o fluxo manual de hoje,
-- pelo MESMO caminho da recusa por teto. `faltam_centavos` viaja junto para
-- quem quiser, um dia, oferecer completar o pedido — mas oferecer nao e a
-- saida escolhida.
drop function if exists public.api_n8n_gerar_cobranca(uuid, bigint);

create or replace function public.api_n8n_gerar_cobranca(
  p_tenant_id uuid, p_conversation_id bigint)
returns table(ok boolean, motivo text, cobranca_id uuid, ja_existia boolean,
              pedido_id uuid, pedido_numero integer, valor_centavos integer,
              minimo_centavos integer, faltam_centavos integer,
              expira_em timestamptz, vence_em date, descricao text,
              referencia_externa text, url text,
              ambiente text, base_url text, api_key text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cred     record;
  v_pedido   uuid;
  v_numero   integer;
  v_total    integer;
  v_status   text;
  v_cob      record;
  v_expira   timestamptz;
  v_nome     text;

  -- o que a saida unica la embaixo monta
  v_ok       boolean := false;
  v_motivo   text;
  v_cobid    uuid;
  v_reusou   boolean := false;
  v_url      text;
  v_minimo   integer := 0;
  v_faltam   integer;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  select * into v_cred from public.api_n8n_credencial_asaas(p_tenant_id);
  v_minimo := coalesce(v_cred.minimo_centavos, 0);

  if not coalesce(v_cred.ativa, false) then
    v_motivo := 'tool_inativa';

  elsif coalesce(btrim(v_cred.api_key), '') = '' then
    v_motivo := 'sem_credencial';

  else
    -- O pedido FECHADO desta conversa. Rascunho nao gera cobranca: o link nasce
    -- depois do `fechar_pedido`, que e quando o total para de mudar.
    --
    -- `for update` serializa duas execucoes na mesma conversa. O debounce ja
    -- torna isso raro, mas "raro" nao e "impossivel" e o estrago seria dois
    -- links vivos para um pedido so.
    select p.id, p.numero, p.total_centavos, p.status
      into v_pedido, v_numero, v_total, v_status
    from public.pedidos p
    where p.tenant_id = p_tenant_id
      and p.conversation_id = p_conversation_id
      and p.status in ('aguardando_pagamento', 'pago')
      and p.deletado_em is null
    order by p.criado_em desc
    limit 1
    for update;

    if v_pedido is null then
      v_motivo := 'sem_pedido_fechado';

    elsif v_status = 'pago' then
      v_motivo := 'ja_pago';

    elsif coalesce(v_total, 0) <= 0 then
      v_motivo := 'total_zero';

    elsif v_total < v_minimo then
      -- O PISO DO PROVEDOR. Chega ao agente como motivo, nunca como 400 cru.
      v_motivo := 'abaixo_do_minimo';
      v_faltam := v_minimo - v_total;

    else
      -- REUSO: cobranca viva, nao expirada, do mesmo ambiente e do mesmo valor.
      -- Valor diferente significa que o pedido mudou depois do link; ai o link
      -- velho nao serve e um novo e gerado.
      select * into v_cob
      from public.pedido_cobrancas c
      where c.tenant_id = p_tenant_id
        and c.pedido_id = v_pedido
        and c.ambiente = v_cred.ambiente
        and c.url is not null
        and c.pago_em is null
        and c.falhou_em is null
        and c.expira_em > now()
        and c.valor_centavos = v_total
      order by c.criado_em desc
      limit 1;

      if found then
        v_ok     := true;
        v_motivo := 'reusado';
        v_cobid  := v_cob.id;
        v_reusou := true;
        v_expira := v_cob.expira_em;
        v_url    := v_cob.url;
      else
        v_expira := now()
                  + make_interval(mins => greatest(coalesce(v_cred.expira_minutos, 30), 1));

        insert into public.pedido_cobrancas
          (tenant_id, pedido_id, conversation_id, ambiente, valor_centavos, expira_em)
        values
          (p_tenant_id, v_pedido, p_conversation_id, v_cred.ambiente, v_total, v_expira)
        returning id into v_cobid;

        v_ok     := true;
        v_motivo := 'ok';
      end if;
    end if;
  end if;

  -- A DESCRICAO NAO CARREGA DADO PESSOAL. Ela aparece na pagina do Asaas, que e
  -- publica por URL — e, medido em 10/09/2026 abrindo uma, aquela pagina JA
  -- exibe nome e documento do TITULAR DA CONTA. Acrescentar dado do comprador
  -- ali seria pior de propria vontade.
  select t.nome into v_nome from public.tenants t where t.id = p_tenant_id;

  return query select
    v_ok,
    v_motivo,
    v_cobid,
    v_reusou,
    v_pedido,
    v_numero,
    v_total,
    v_minimo,
    v_faltam,
    v_expira,
    -- `endDate` do Asaas e uma DATA (medido na doc e confirmado pela recusa do
    -- sandbox). Vai o dia da expiracao — teto grosseiro, nao alinhamento; a
    -- autoridade fina e `expira_em` acima.
    v_expira::date,
    case when v_ok then format('Pedido nº %s — %s', coalesce(v_numero::text, '?'), coalesce(v_nome, ''))
         else null end,
    case when v_ok then v_cobid::text else null end,
    v_url,
    v_cred.ambiente,
    v_cred.base_url,
    case when v_ok then v_cred.api_key else null end;
end;
$function$;

revoke all on function public.api_n8n_gerar_cobranca(uuid, bigint) from public;
revoke all on function public.api_n8n_gerar_cobranca(uuid, bigint) from anon;
revoke all on function public.api_n8n_gerar_cobranca(uuid, bigint) from authenticated;
grant execute on function public.api_n8n_gerar_cobranca(uuid, bigint) to service_role;
grant execute on function public.api_n8n_gerar_cobranca(uuid, bigint) to n8n_agent;

-- =====================================================================
-- 8. api_n8n_registrar_cobranca — CONFIRMA (fase 2 de 2)
-- =====================================================================
-- NAO MUDA `pedidos.status`. Ela so grava o que o Asaas devolveu. O caminho
-- ate `pago` passa exclusivamente pela funcao do webhook.
create or replace function public.api_n8n_registrar_cobranca(
  p_tenant_id uuid, p_cobranca_id uuid, p_ok boolean,
  p_link_id text default null, p_url text default null, p_detalhe text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_cobranca_id is null then
    return false;
  end if;

  if coalesce(p_ok, false) then
    update public.pedido_cobrancas c
       set link_id   = nullif(btrim(coalesce(p_link_id, '')), ''),
           url       = nullif(btrim(coalesce(p_url, '')), ''),
           falhou_em = null,
           detalhe   = null
     where c.id = p_cobranca_id
       and c.tenant_id = p_tenant_id
       and c.pago_em is null;
  else
    update public.pedido_cobrancas c
       set falhou_em = now(),
           detalhe   = left(coalesce(p_detalhe, ''), 500)
     where c.id = p_cobranca_id
       and c.tenant_id = p_tenant_id;
  end if;

  return found;
end;
$function$;

revoke all on function public.api_n8n_registrar_cobranca(uuid, uuid, boolean, text, text, text) from public;
revoke all on function public.api_n8n_registrar_cobranca(uuid, uuid, boolean, text, text, text) from anon;
revoke all on function public.api_n8n_registrar_cobranca(uuid, uuid, boolean, text, text, text) from authenticated;
grant execute on function public.api_n8n_registrar_cobranca(uuid, uuid, boolean, text, text, text) to service_role;
grant execute on function public.api_n8n_registrar_cobranca(uuid, uuid, boolean, text, text, text) to n8n_agent;

-- =====================================================================
-- 9. api_n8n_pagamento_webhook — A UNICA FUNCAO QUE ESCREVE `pago`
-- =====================================================================
-- O TENANT VEM DO TOKEN, nao do payload. E a mesma regra do `tenant_id` que
-- nunca vem do request: o corpo do webhook e entrada externa e nao autentica
-- nada. Token de 32+ caracteres, e SO o do ambiente ATIVO.
--
-- ELA NAO ESTOURA. Entrada desconhecida devolve `reconhecido = false` e o
-- fluxo responde 200 — porque 15 respostas nao-200 INTERROMPEM A FILA do
-- webhook no Asaas, e ai para de chegar tudo, inclusive o que estava certo.
-- Erro de verdade (banco fora) continua estourando; o que nao estoura e
-- "evento que eu nao sei tratar".
create or replace function public.api_n8n_pagamento_webhook(
  p_webhook_token text,
  p_evento_id text,
  p_evento text,
  p_pagamento_id text default null,
  p_link_id text default null,
  p_referencia text default null,
  p_valor_centavos integer default null)
returns table(reconhecido boolean, ja_processado boolean, aplicou boolean,
              motivo text, tenant_id uuid, cobranca_id uuid, pedido_id uuid,
              pedido_numero integer, conversation_id bigint,
              total_centavos integer, precisa_humano boolean, mensagem text)
language plpgsql
security definer
set search_path to 'public'
as $function$
-- NOMES DE COLUNA DE SAIDA VIRAM VARIAVEIS plpgsql, e varios deles sao tambem
-- colunas das tabelas que esta funcao toca: `tenant_id`, `aplicou`, `motivo`,
-- `cobranca_id`, `pedido_id`, `conversation_id`, `total_centavos`. Sem esta
-- linha o `on conflict (tenant_id, evento_id)` abaixo estoura `42702` — foi o
-- primeiro erro real que este arquivo deu, e o `on conflict` e justamente a
-- camada 1 da idempotencia.
--
-- `use_column` e seguro AQUI porque nenhuma variavel local e lida por nome de
-- coluna: as locais sao todas `v_*` e os parametros todos `p_*`. Se alguem
-- acrescentar uma variavel chamada como uma coluna, ela passa a ser ignorada em
-- silencio — entao a convencao `v_`/`p_` deixou de ser estilo neste corpo.
#variable_conflict use_column
declare
  v_tenant  uuid;
  v_cob     record;
  v_ped     record;
  v_ev      text := upper(btrim(coalesce(p_evento, '')));
  v_ref     uuid;
  v_aplicou boolean := false;
  v_motivo  text;
  v_fora    boolean := false;
  v_msg     text;
  v_evid    text := btrim(coalesce(p_evento_id, ''));
begin
  -- ---------- autenticacao ----------
  if p_webhook_token is null or length(btrim(p_webhook_token)) < 32 then
    return query select false, false, false, 'token_invalido', null::uuid, null::uuid,
                        null::uuid, null::integer, null::bigint, null::integer, false, null::text;
    return;
  end if;

  select tc.tenant_id into v_tenant
  from public.tenant_credenciais tc
  where (tc.asaas_ambiente = 'sandbox'
         and tc.asaas_webhook_token_sandbox = btrim(p_webhook_token))
     or (tc.asaas_ambiente = 'producao'
         and tc.asaas_webhook_token_producao = btrim(p_webhook_token));

  if v_tenant is null then
    return query select false, false, false, 'token_desconhecido', null::uuid, null::uuid,
                        null::uuid, null::integer, null::bigint, null::integer, false, null::text;
    return;
  end if;

  perform public.n8n_assert_tenant(v_tenant);

  if v_evid = '' then
    return query select true, false, false, 'evento_sem_id', v_tenant, null::uuid,
                        null::uuid, null::integer, null::bigint, null::integer, false, null::text;
    return;
  end if;

  -- ---------- a cobranca ----------
  -- Tres caminhos, do mais confiavel para o menos: a referencia externa (que
  -- NOS geramos), o id do link, o id do pagamento.
  begin
    v_ref := nullif(btrim(coalesce(p_referencia, '')), '')::uuid;
  exception when others then
    v_ref := null;
  end;

  select * into v_cob from public.pedido_cobrancas c
   where c.tenant_id = v_tenant
     and (
       (v_ref is not null and c.id = v_ref)
       or (nullif(btrim(coalesce(p_link_id, '')), '') is not null and c.link_id = btrim(p_link_id))
       or (nullif(btrim(coalesce(p_pagamento_id, '')), '') is not null and c.pagamento_id = btrim(p_pagamento_id))
     )
   order by c.criado_em desc
   limit 1;

  -- ---------- CAMADA 1 DA IDEMPOTENCIA: por evento ----------
  -- O insert e a trava. Se ele nao inseriu, este evento ja passou por aqui e
  -- NADA acontece — nem escrita, nem notificacao.
  insert into public.pagamento_eventos
    (tenant_id, evento_id, evento, pagamento_id, link_id, valor_centavos,
     cobranca_id, pedido_id, aplicou, motivo)
  values
    (v_tenant, v_evid, v_ev, nullif(btrim(coalesce(p_pagamento_id, '')), ''),
     nullif(btrim(coalesce(p_link_id, '')), ''), p_valor_centavos,
     v_cob.id, v_cob.pedido_id, false, 'recebido')
  on conflict (tenant_id, evento_id) do nothing;

  if not found then
    return query select true, true, false, 'ja_processado', v_tenant, v_cob.id,
                        v_cob.pedido_id, null::integer, v_cob.conversation_id,
                        null::integer, false, null::text;
    return;
  end if;

  -- ---------- o que fazer com ele ----------
  if v_cob.id is null then
    v_motivo := 'cobranca_desconhecida';
  elsif v_ev not in ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED') then
    -- Os dois entram: RECEIVED e o de Pix e boleto, CONFIRMED e o
    -- intermediario de cartao. Eventos com `id` diferente sobre o mesmo
    -- pagamento morrem na camada 2, nao aqui.
    v_motivo := 'evento_ignorado';
  else
    select p.* into v_ped from public.pedidos p
     where p.id = v_cob.pedido_id and p.tenant_id = v_tenant;

    -- FORA DO PRAZO. A autoridade e `expira_em`, nossa, com precisao de
    -- segundo — e nao `pedidos.status`, que a expiracao preguicosa pode nao ter
    -- alcancado ainda.
    if now() > v_cob.expira_em
       or coalesce(v_ped.status, '') in ('cancelado', 'expirado') then
      v_fora   := true;
      v_motivo := 'fora_do_prazo';
      -- O PEDIDO NAO REABRE. Reabrir seria revalidar preco e estoque de um
      -- pedido velho sem ninguem olhando. O pagamento fica retido e a
      -- divergencia registrada; quem resolve e gente.
      update public.pedido_cobrancas c
         set fora_do_prazo_em = coalesce(c.fora_do_prazo_em, now()),
             pagamento_id     = coalesce(c.pagamento_id, nullif(btrim(coalesce(p_pagamento_id, '')), '')),
             pago_centavos    = coalesce(c.pago_centavos, p_valor_centavos)
       where c.id = v_cob.id and c.tenant_id = v_tenant;
    else
      -- ---------- CAMADA 2 DA IDEMPOTENCIA: por estado ----------
      update public.pedido_cobrancas c
         set pago_em       = now(),
             pagamento_id  = coalesce(nullif(btrim(coalesce(p_pagamento_id, '')), ''), c.pagamento_id),
             pago_centavos = coalesce(p_valor_centavos, c.valor_centavos)
       where c.id = v_cob.id
         and c.tenant_id = v_tenant
         and c.pago_em is null;

      if found then
        update public.pedidos p
           set status = 'pago'
         where p.id = v_cob.pedido_id
           and p.tenant_id = v_tenant
           and p.status = 'aguardando_pagamento'
           and p.deletado_em is null;

        v_aplicou := found;
        v_motivo  := case when v_aplicou then 'pago' else 'pedido_nao_estava_aguardando' end;
      else
        v_motivo := 'ja_pago';
      end if;
    end if;
  end if;

  update public.pagamento_eventos e
     set aplicou = v_aplicou, motivo = v_motivo
   where e.tenant_id = v_tenant and e.evento_id = v_evid;

  select p.* into v_ped from public.pedidos p
   where p.id = v_cob.pedido_id and p.tenant_id = v_tenant;

  -- A MENSAGEM E ESCRITA AQUI, EM CODIGO. O modelo nao a redige, entao nao tem
  -- como errar o valor nem confirmar o que nao caiu.
  if v_aplicou then
    v_msg := format(E'Pagamento confirmado! ✅\n\nPedido nº %s — %s\n\nJá está tudo certo por aqui. Obrigado!',
                    coalesce(v_ped.numero::text, '?'),
                    public.centavos_brl(coalesce(v_ped.total_centavos, 0)));
  end if;

  return query select true, false, v_aplicou, v_motivo, v_tenant, v_cob.id,
                      v_cob.pedido_id, v_ped.numero, v_cob.conversation_id,
                      v_ped.total_centavos, v_fora, v_msg;
end;
$function$;

revoke all on function public.api_n8n_pagamento_webhook(text, text, text, text, text, text, integer) from public;
revoke all on function public.api_n8n_pagamento_webhook(text, text, text, text, text, text, integer) from anon;
revoke all on function public.api_n8n_pagamento_webhook(text, text, text, text, text, text, integer) from authenticated;
grant execute on function public.api_n8n_pagamento_webhook(text, text, text, text, text, text, integer) to service_role;
grant execute on function public.api_n8n_pagamento_webhook(text, text, text, text, text, text, integer) to n8n_agent;

-- =====================================================================
-- 10. api_n8n_confirmar_pagamento_notificado
-- =====================================================================
create or replace function public.api_n8n_confirmar_pagamento_notificado(
  p_tenant_id uuid, p_cobranca_id uuid, p_ok boolean, p_detalhe text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);
  if p_cobranca_id is null then
    return false;
  end if;

  update public.pedido_cobrancas c
     set notificado_em = case when coalesce(p_ok, false) then now() else c.notificado_em end,
         detalhe       = case when coalesce(p_ok, false) then c.detalhe
                              else left(coalesce(p_detalhe, ''), 500) end
   where c.id = p_cobranca_id and c.tenant_id = p_tenant_id;

  return found;
end;
$function$;

revoke all on function public.api_n8n_confirmar_pagamento_notificado(uuid, uuid, boolean, text) from public;
revoke all on function public.api_n8n_confirmar_pagamento_notificado(uuid, uuid, boolean, text) from anon;
revoke all on function public.api_n8n_confirmar_pagamento_notificado(uuid, uuid, boolean, text) from authenticated;
grant execute on function public.api_n8n_confirmar_pagamento_notificado(uuid, uuid, boolean, text) to service_role;
grant execute on function public.api_n8n_confirmar_pagamento_notificado(uuid, uuid, boolean, text) to n8n_agent;

-- =====================================================================
-- 11. api_n8n_estado_pedido — TROCA DE ASSINATURA, entao DROP explicito
-- =====================================================================
-- `create or replace` nao muda tipo de retorno (`42P13`). O `drop` pela LISTA
-- COMPLETA DE TIPOS e obrigatorio, e ele APAGA TODOS OS GRANTS — a armadilha
-- das migracoes 40 e 41. Os dois `grant` estao logo abaixo, e o `revoke` vem
-- antes deles porque funcao recriada neste projeto nasce com EXECUTE para
-- PUBLIC.
drop function if exists public.api_n8n_estado_pedido(uuid, bigint, text, integer);

create or replace function public.api_n8n_estado_pedido(
  p_tenant_id uuid, p_conversation_id bigint,
  p_perfil text default 'vendas', p_teto_segundos integer default 300)
returns table(tem_pedido boolean, pedido_id uuid, pedido_status text,
              pedido_numero integer, total_centavos integer, itens jsonb,
              escreveu_neste_turno boolean, barrou_anterior boolean,
              pagamento_confirmado boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_limite     timestamptz;
  v_tocado     uuid;
  v_ref        uuid;
  v_status     text;
  v_numero     integer;
  v_total      integer;
  v_itens      jsonb;
  v_barrou     boolean;
  v_pago       boolean;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if coalesce(p_perfil, '') <> 'vendas' then
    return query select false, null::uuid, null::text, null::integer, 0, '[]'::jsonb,
                        false, false, false;
    return;
  end if;

  -- ------------------------------------------------------------------
  -- O LIMITE DA JANELA — DUAS BORDAS, E A DE CIMA NAO E ENFEITE
  -- ------------------------------------------------------------------
  -- A borda de baixo e a ultima saida ja registrada: `Registra Mensagem` roda
  -- DEPOIS do portao, entao ela e a do turno anterior, e "mutou depois dela"
  -- cobre o turno inteiro, inclusive as tool calls.
  --
  -- Sozinha, ela e larga demais. Medido em 2026-09-09 sobre `mensagens_log`:
  -- o intervalo entre saidas consecutivas tem MEDIANA de 41 s, mas p95 de
  -- 103.898 s (28,9 h) e MAXIMO de 18 DIAS. Sem teto, uma conversa que ficou
  -- parada duas semanas leria qualquer mutacao daquele periodo como "escreveu
  -- neste turno" — e passaria uma fabricacao por isso.
  --
  -- O teto sai da outra ponta da mesma medicao: a distancia entre a escrita e o
  -- turno que a narrou, nas 22 escritas do historico, e de 1,3 s (minimo),
  -- 2,3 s (mediana), 7,3 s (p95) e 10,0 s (MAXIMO). O default de 300 s e 30x o
  -- maximo observado e ainda assim corta a janela de 18 dias para 5 minutos.
  v_limite := greatest(
    coalesce((select max(m.criado_em)
                from public.mensagens_log m
               where m.tenant_id = p_tenant_id
                 and m.conversation_id = p_conversation_id
                 and m.direcao = 'saida'), '-infinity'::timestamptz),
    now() - make_interval(secs => greatest(coalesce(p_teto_segundos, 300), 1))
  );

  -- ------------------------------------------------------------------
  -- A REFERENCIA: O PEDIDO TOCADO NO TURNO, E SO ENTAO O RASCUNHO
  -- ------------------------------------------------------------------
  -- MUDANCA DA 61: `pedido_cobrancas` entra no `greatest`. Gerar o link E
  -- escrita do turno, e nenhuma linha de `pedidos` se mexe quando isso
  -- acontece — sem esta parte, a mensagem que ENTREGA o link ("Prontinho! aqui
  -- esta o link de pagamento") cai na regra 1 do portao, que barra afirmacao de
  -- efeito consumado sem escrita no turno. Seria o portao barrando exatamente o
  -- passo que a fase de pagamento existe para dar.
  select p.id into v_tocado
    from public.pedidos p
   where p.tenant_id = p_tenant_id
     and p.conversation_id = p_conversation_id
     and p.deletado_em is null
     and greatest(
           p.atualizado_em,
           coalesce((select max(i.atualizado_em)
                       from public.pedido_itens i
                      where i.pedido_id = p.id
                        and i.tenant_id = p_tenant_id), p.atualizado_em),
           coalesce((select max(c.atualizado_em)
                       from public.pedido_cobrancas c
                      where c.pedido_id = p.id
                        and c.tenant_id = p_tenant_id), p.atualizado_em)
         ) > v_limite
   order by p.atualizado_em desc
   limit 1;

  if v_tocado is null then
    select p.id into v_ref
      from public.pedidos p
     where p.tenant_id = p_tenant_id
       and p.conversation_id = p_conversation_id
       and p.status = 'rascunho'
       and p.deletado_em is null
     limit 1;
  else
    v_ref := v_tocado;
  end if;

  select coalesce((m.portao ->> 'veredito') like 'barrado%', false)
    into v_barrou
    from public.mensagens_log m
   where m.tenant_id = p_tenant_id
     and m.conversation_id = p_conversation_id
     and m.direcao = 'saida'
   order by m.criado_em desc
   limit 1;

  -- ------------------------------------------------------------------
  -- `pagamento_confirmado` — FORA DA JANELA, DE PROPOSITO
  -- ------------------------------------------------------------------
  -- O pedido MAIS RECENTE da conversa esta `pago`? Fora da janela porque a
  -- pergunta "caiu?" chega quando o cliente quiser, e a regra 3 do portao
  -- precisa distinguir "afirmou pagamento que nao existe" de "confirmou um
  -- pagamento que existe, meia hora depois".
  --
  -- MAIS RECENTE, e nao "existe algum pago": um cliente que pagou ontem e
  -- comecou um carrinho novo hoje nao tem pagamento confirmado para o carrinho
  -- de hoje, e afirmar que tem seria a mesma falha com outra roupa.
  --
  -- O RASCUNHO E VERIFICADO A PARTE, e nao por `order by criado_em desc`, e a
  -- razao e concreta: `now()` e o instante da TRANSACAO, entao dois pedidos
  -- criados na mesma transacao tem `criado_em` IDENTICO e a ordenacao vira
  -- moeda. Foi assim que a §12 do teste pegou este trecho errado na primeira
  -- execucao — carrinho novo depois de pagar continuava dando `true`.
  --
  -- `uq_pedidos_conversa_rascunho` garante no maximo um rascunho vivo, entao o
  -- `exists` e exato. E a semantica fica dita em vez de emergir da ordenacao:
  -- havendo carrinho aberto, o pagamento de antes nao vale para ele.
  if exists (select 1 from public.pedidos p
              where p.tenant_id = p_tenant_id
                and p.conversation_id = p_conversation_id
                and p.status = 'rascunho'
                and p.deletado_em is null) then
    v_pago := false;
  else
    select coalesce(p.status = 'pago', false)
      into v_pago
      from public.pedidos p
     where p.tenant_id = p_tenant_id
       and p.conversation_id = p_conversation_id
       and p.deletado_em is null
     -- `id desc` como desempate: nao tem significado, tem DETERMINISMO. Sem
     -- ele, empate de `criado_em` faz esta funcao responder coisas diferentes
     -- para a mesma pergunta.
     order by p.criado_em desc, p.id desc
     limit 1;
  end if;

  if v_ref is null then
    return query select false, null::uuid, null::text, null::integer, 0, '[]'::jsonb,
                        false, coalesce(v_barrou, false), coalesce(v_pago, false);
    return;
  end if;

  select p.status, p.numero, coalesce(p.total_centavos, 0)
    into v_status, v_numero, v_total
    from public.pedidos p
   where p.id = v_ref and p.tenant_id = p_tenant_id;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'nome',                i.nome_snapshot,
             'quantidade',          i.quantidade,
             'preco_unit_centavos', i.preco_unit_centavos,
             'subtotal_centavos',   (i.preco_unit_centavos::bigint * i.quantidade)::integer
           ) order by i.criado_em
         ), '[]'::jsonb)
    into v_itens
    from public.pedido_itens i
   where i.pedido_id = v_ref
     and i.tenant_id = p_tenant_id;

  return query
    select true, v_ref, v_status, v_numero, v_total, v_itens,
           v_tocado is not null,
           coalesce(v_barrou, false),
           coalesce(v_pago, false);
end;
$function$;

revoke all on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) from public;
revoke all on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) from anon;
revoke all on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) from authenticated;
grant execute on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) to service_role;
grant execute on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) to n8n_agent;

commit;
