-- =====================================================================
-- 53. Protecao anti-loop: pausa por anomalia (B) + teto de consumo (C)
-- =====================================================================
--
-- O QUE ACONTECEU, E POR QUE NAO E ACIDENTE ISOLADO
--
-- Entre 21 e 24/08/2026 a conversa 20 do `emporio` trocou 5.624 mensagens
-- identicas com o outro lado, uma a cada ~16 segundos, sem parar. Custo medido
-- pelos precos de `precos_modelo` (gpt-4.1-mini): **22.961.462 tokens de entrada
-- e 188.627 de saida = US$ 9,49**, ou 96,1% de TODO o consumo do tenant no
-- periodo. Um dia sozinho (23/08) custou US$ 6,18, contra US$ 0,08-0,15 de um
-- dia normal.
--
-- O outro lado se identifica no proprio texto:
--
--     {"Ola! Eu sou o assistente virtual da PresenteIA. Como posso te ajudar hoje?"}
--
-- Isso e o que muda o peso desta migracao. Nao era um numero perdido: era OUTRO
-- ASSISTENTE DE WHATSAPP, de um produto que existe. Cada um respondia a saudacao
-- do outro com uma saudacao. **Qualquer cliente que tenha o numero de outro
-- assistente na agenda pode entrar em laco**, e assistentes de WhatsApp estao
-- virando comuns — entao esta e uma CATEGORIA DE FALHA que vai se repetir, e nao
-- um caso a consertar uma vez.
--
-- Duas camadas, com papeis diferentes:
--
--   B) repeticao de conteudo -> pausa a CONVERSA. Cirurgico: pega o laco e nao
--      pega o cliente ansioso, porque separa por CONTEUDO e nao por ritmo;
--   C) teto de tokens por tenant por dia -> nao pega o laco rapido, pega o DANO
--      ACUMULADO. Vale qualquer que seja a causa, inclusive um laco de formato
--      diferente que a B nao reconheca.
--
-- Teto de MENSAGENS por janela (a ideia "A") ficou de fora de proposito: o laco
-- rodou a ~3,75 mensagens/minuto, e um cliente mandando quatro fotos seguidas
-- bate nisso. Ritmo nao separa os dois casos; conteudo separa.
--
-- ---------------------------------------------------------------------
-- ONDE A CHECAGEM MORA, E POR QUE NAO E DENTRO DA `api_n8n_conversa_pausada`
--
-- Aquela funcao e `STABLE`, e isso nao e rotulo: e contrato. O planner pode
-- cachear o resultado de uma `STABLE` dentro da mesma query. Uma funcao que
-- ESCREVE pausa nao pode prometer isso. Marca-la `VOLATILE` "resolveria" a
-- promessa e deixaria uma funcao chamada *conversa_pausada* gravando no banco a
-- cada mensagem: nome dizendo uma coisa, efeito fazendo outra — que e exatamente
-- a doenca do `Conversa Ativa?` que a migracao 48 matou.
--
-- Entao: funcao NOVA (`api_n8n_portao_mensagem`), `VOLATILE`, chamada pelo MESMO
-- no `Consulta Pausa`. Zero no novo no caminho quente, e:
--
--   - `pausa_vigente` continua sendo O PREDICADO UNICO (desenho da 47);
--   - `api_n8n_conversa_pausada` continua existindo e `STABLE`, para quem so le;
--   - a aridade NAO muda (`uuid, bigint`), entao nada da familia 28/32/37.
--
-- A aridade so pode ficar igual por causa de um fato do workflow: o
-- `Registra Mensagem` roda NO FIM, depois do `Envia Mensagem Chatwoot`. A
-- mensagem atual ainda nao esta no log quando o portao roda, entao a regra le so
-- historico e nao precisa receber o texto. O preco e disparar uma mensagem mais
-- tarde: medido em ~US$ 0,006.
--
-- ---------------------------------------------------------------------
-- CUSTO DAS DUAS CONSULTAS, medido com `explain (analyze, buffers)`
--
--   - ultimas 5 entradas da conversa: 0,19 ms, Index Scan Backward em
--     `idx_log_conversa`;
--   - soma de tokens do dia do tenant: 1,5 ms, Index Scan em
--     `idx_log_tenant_data`.
--
-- Os dois indices ja existiam. Nenhum indice novo entra aqui.
--
-- ROLLBACK: 20260824180000_53_anti_loop_rollback.sql
-- DEPENDE DA 52: usa `public.contato_exibivel`. Rollback na ordem inversa.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Normalizacao do texto — exata, nao difusa
-- ---------------------------------------------------------------------
-- Tira o involucro `{"..."}` com que o log guarda a entrada, colapsa espaco e
-- baixa a caixa. E SO ISSO.
--
-- A migracao 50 instalou `pg_trgm`, e usar `word_similarity` aqui e tentador.
-- Nao: casamento difuso sobre texto de CLIENTE e onde mora o falso positivo, e
-- o exato-normalizado ja deu ZERO falso positivo nas 24 conversas reais fora da
-- 20 (simulado; ver `npm run teste:anti-loop`). Regra mais simples que a
-- evidencia sustenta.
create or replace function public.texto_normalizado(p_texto text)
returns text
language sql
immutable
as $$
  select nullif(btrim(regexp_replace(lower(coalesce(p_texto, '')), '\s+', ' ', 'g'), ' {}"'), '');
$$;

-- ---------------------------------------------------------------------
-- 2. `anomalia` vira motivo de pausa — e NAO caduca
-- ---------------------------------------------------------------------
alter table public.conversas drop constraint if exists conversas_motivo_pausa_check;
alter table public.conversas add constraint conversas_motivo_pausa_check
  check (motivo_pausa is null or motivo_pausa in ('manual', 'mensagem_humana', 'anomalia'));

-- SEM ESTA PARTE A PROTECAO INTEIRA E INUTIL contra o caso que a motivou.
-- `pausa_vigente` so trata `manual` como nao-expiravel; `anomalia` cairia na
-- janela do tenant e **expiraria em 30 minutos** — que foi literalmente o que
-- aconteceu com a conversa 20 em 24/08, e o laco recomecou.
--
-- Mesma assinatura, entao `create or replace` basta: sem drop, sem aridade
-- ambigua, e a view `conversas_painel` (que le esta funcao) sobrevive.
-- `conversa_status_efetivo` delega a esta aqui, entao ela herda a mudanca
-- sozinha — o predicado continua num lugar so.
create or replace function public.pausa_vigente(
  p_status          text,
  p_pausado_em      timestamptz,
  p_motivo_pausa    text,
  p_janela_minutos  integer
)
returns boolean
language sql
stable
set search_path to 'public', 'extensions'
as $$
  select case
    when p_status is distinct from 'pausado'        then false
    -- `manual` e `anomalia` sao as pausas que EXIGEM alguem olhar. Caducar
    -- sozinha derrotaria as duas: a manual voltaria com o humano ainda
    -- atendendo, e a de anomalia devolveria o agente ao laco.
    when p_motivo_pausa in ('manual', 'anomalia')   then true
    -- `null = 'manual'` e NULL, entao motivo nulo NAO para aqui: segue para a
    -- janela e caduca. E deliberado; ver docs/PAUSA-AUTOMATICA.md.
    when p_pausado_em is null                       then false
    when p_janela_minutos is null                   then false
    else p_pausado_em > now() - make_interval(mins => p_janela_minutos)
  end;
$$;

-- ---------------------------------------------------------------------
-- 3. Os tetos, por tenant
-- ---------------------------------------------------------------------
-- `add column ... not null default` e NAO `add column` + `update`: um `update`
-- em `tenants` sem claim de super_admin bate no `trg_tenants_guard_colunas` e
-- estoura `42501`. Foi a armadilha que quase derrubou a aplicacao da 47.
--
-- 1.000.000 = 2,8x o maior dia legitimo ja medido (356 mil tokens, emporio
-- 20/08). Os dias de laco deram 6,8 e 15,0 milhoes.
alter table public.tenants
  add column if not exists teto_aviso_tokens_dia bigint not null default 1000000;

-- NULO = DESLIGADO, e nasce desligado de proposito. Derrubar o agente de um
-- cliente que paga, por causa de um limiar que nunca foi calibrado, e pior do
-- que os US$ 9,49 que este incidente custou. O aviso resolve o que de fato
-- faltou — ninguem soube —, e o corte fica disponivel para quando houver mes de
-- dado para calibrar.
alter table public.tenants
  add column if not exists teto_corte_tokens_dia bigint;

comment on column public.tenants.teto_aviso_tokens_dia is
  'Tokens/dia (entrada+saida, dia UTC) a partir dos quais um alerta e gravado em alertas_consumo. Nao notifica ninguem.';
comment on column public.tenants.teto_corte_tokens_dia is
  'Tokens/dia a partir dos quais o agente PARA de responder no tenant inteiro. NULO = desligado (padrao).';

-- ---------------------------------------------------------------------
-- 4. `alertas_consumo` — e por que NAO e coluna em `tenants`
-- ---------------------------------------------------------------------
-- A marca de "ja avisei hoje" precisa ser gravada pelo portao, que roda como
-- `n8n_agent` e SEM claim nenhuma. `tenants_guard_colunas` recusa qualquer
-- coluna fora da whitelist quando `auth_is_super_admin()` e falso — ou seja,
-- gravar em `tenants` daria **`42501` em runtime, no caminho quente, no primeiro
-- tenant que estourasse o teto**. E a armadilha da 47 outra vez, so que
-- aparecendo em producao em vez de na migracao.
--
-- Com tabela propria, a UNICIDADE de (tenant, dia, tipo) E o claim: o
-- `on conflict do nothing` e atomico por definicao do banco, mais forte que o
-- claim por `where` que a 52 usa em `pedidos.metadados`.
create table if not exists public.alertas_consumo (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  dia         date not null,
  tipo        text not null check (tipo in ('aviso', 'corte')),
  tokens_dia  bigint not null,
  teto        bigint not null,
  criado_em   timestamptz not null default now()
);

-- `tenant_id` PRIMEIRO no indice composto (regra 3): serve para "alertas do
-- tenant X" e para "alertas do tenant X por dia". O contrario nao serve para
-- nada.
create unique index if not exists uq_alertas_consumo_dia
  on public.alertas_consumo (tenant_id, dia, tipo);
create index if not exists idx_alertas_consumo_tenant
  on public.alertas_consumo (tenant_id, dia desc);

-- Tabela nova com `tenant_id` NASCE com RLS e policy na MESMA migracao (regra
-- 2). Aqui a policy e so-agencia: **o aviso de teto nao vai para o cliente**.
-- Motivo, decidido com o Felipe em 24/08: o dono da padaria recebendo "seu
-- tenant consumiu 1 milhao de tokens hoje" liga perguntando o que fez de errado
-- — e informacao que nao e dele e sobre a qual ele nao pode agir. Pior no dia em
-- que o teto disparar por uso LEGITIMO (promocao, crescimento): chega parecendo
-- cobranca. A informacao fica em casa e o painel de admin mostra.
alter table public.alertas_consumo enable row level security;

drop policy if exists p_alertas_consumo_super on public.alertas_consumo;
create policy p_alertas_consumo_super on public.alertas_consumo
  for select to authenticated
  using (public.auth_is_super_admin());

-- REVOKE ANTES DO GRANT, senao o `grant` e decoracao: o
-- `ALTER DEFAULT PRIVILEGES` deste projeto concede `arwdDxtm` a `anon`,
-- `authenticated` e `service_role` em TODO objeto novo de `public`. Medido em
-- 2026-08-21 e de novo na 52, do lado das funcoes.
revoke all on public.alertas_consumo from public;
revoke all on public.alertas_consumo from anon;
revoke all on public.alertas_consumo from authenticated;
revoke all on public.alertas_consumo from service_role;
grant select on public.alertas_consumo to authenticated;   -- a policy restringe a super_admin
grant select on public.alertas_consumo to service_role;

-- ---------------------------------------------------------------------
-- 5. O portao
-- ---------------------------------------------------------------------
-- SEMPRE devolve EXATAMENTE UMA LINHA. Zero linhas faria o no do n8n parar o
-- fluxo em silencio e o agente nunca responderia — falha calada, que e a classe
-- que este projeto vem trocando por barulhenta. Ha teste so para isso.
create or replace function public.api_n8n_portao_mensagem(
  p_tenant_id        uuid,
  p_conversation_id  bigint
)
returns table (
  pausada   boolean,
  motivo    text,
  anomalia  boolean,   -- true SOMENTE na transicao, e a transicao ocorre uma vez
  sessao    text,
  destino   text,
  mensagem  text
)
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  -- ---- a regra B, em constantes visiveis ----
  -- 5 e nao 3: as duas dao zero falso positivo nas 24 conversas reais, e as
  -- duas evitariam 99,9% do gasto (3 dispara na entrada 5 de 5.624; 5 dispara
  -- na 7). A diferenca custa ~US$ 0,006 e compra margem contra o cliente
  -- ansioso, que manda "oi/oi/oi" mas nao cinco iguais seguidas.
  c_repeticoes  constant integer  := 5;
  -- A JANELA NAO E ENFEITE. Sem ela, uma conversa que repetiu 5 vezes semana
  -- passada pausaria o primeiro cliente de verdade que escrevesse hoje — porque
  -- a regra le historico, e nao a mensagem atual.
  c_janela      constant interval := interval '10 minutes';

  v_teto_aviso  bigint;
  v_teto_corte  bigint;
  v_janela_min  integer;
  v_tokens_hoje bigint;

  v_status      text;
  v_pausado_em  timestamptz;
  v_motivo      text;

  v_n           integer;
  v_distintos   integer;
  v_mais_antiga timestamptz;
  v_ultima      text;

  v_cfg         jsonb;
  v_sessao      text;
  v_destino     text;
  v_nome        text;
  v_fone        text;
  v_msg         text;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_conversation_id is null then
    raise exception 'api_n8n: p_conversation_id e obrigatorio' using errcode = '22023';
  end if;

  select t.teto_aviso_tokens_dia, t.teto_corte_tokens_dia, t.pausa_expira_minutos
    into v_teto_aviso, v_teto_corte, v_janela_min
  from public.tenants t
  where t.id = p_tenant_id;

  -- ---- C: o teto vem PRIMEIRO ----
  -- Antes da pausa, de proposito: e rede de seguranca do TENANT inteiro, e
  -- pular a checagem porque esta conversa esta pausada deixaria o tenant sem
  -- rede justamente quando ha conversa parada. Custa 1,5 ms medidos.
  --
  -- O dia e o dia UTC (`date_trunc('day', now())`), e nao o fuso do tenant. E
  -- deliberado: o teto e guarda grossa, e fuso por tenant so existe hoje dentro
  -- da config do `transferir_humano`. Se um dia virar cobranca, aí sim.
  select coalesce(sum(coalesce(l.tokens_entrada, 0) + coalesce(l.tokens_saida, 0)), 0)
    into v_tokens_hoje
  from public.mensagens_log l
  where l.tenant_id = p_tenant_id
    and l.criado_em >= date_trunc('day', now());

  if v_teto_aviso is not null and v_tokens_hoje >= v_teto_aviso then
    -- A unicidade E o claim: um alerta por tenant/dia/tipo, sem "ja avisei?".
    insert into public.alertas_consumo (tenant_id, dia, tipo, tokens_dia, teto)
    values (p_tenant_id, current_date, 'aviso', v_tokens_hoje, v_teto_aviso)
    on conflict (tenant_id, dia, tipo) do nothing;
  end if;

  if v_teto_corte is not null and v_tokens_hoje >= v_teto_corte then
    insert into public.alertas_consumo (tenant_id, dia, tipo, tokens_dia, teto)
    values (p_tenant_id, current_date, 'corte', v_tokens_hoje, v_teto_corte)
    on conflict (tenant_id, dia, tipo) do nothing;
    return query select true, 'teto_consumo'::text, false, null::text, null::text, null::text;
    return;
  end if;

  -- ---- a pausa que ja existe ----
  select cv.status, cv.pausado_em, cv.motivo_pausa
    into v_status, v_pausado_em, v_motivo
  from public.conversas cv
  where cv.tenant_id = p_tenant_id
    and cv.conversation_id = p_conversation_id;

  if public.pausa_vigente(v_status, v_pausado_em, v_motivo, v_janela_min) then
    return query select true, coalesce(v_motivo, 'pausado')::text, false,
                        null::text, null::text, null::text;
    return;
  end if;

  -- ---- B: as ultimas N entradas ----
  select count(*)::integer,
         count(distinct public.texto_normalizado(x.conteudo))::integer,
         min(x.criado_em),
         max(x.conteudo)   -- so para exibir; as 5 sao identicas quando v_distintos = 1
    into v_n, v_distintos, v_mais_antiga, v_ultima
  from (
    select l.conteudo, l.criado_em
    from public.mensagens_log l
    where l.tenant_id = p_tenant_id
      and l.conversation_id = p_conversation_id
      and l.direcao = 'entrada'
    order by l.criado_em desc
    limit c_repeticoes
  ) x;

  if coalesce(v_n, 0) < c_repeticoes
     or v_distintos <> 1
     or v_mais_antiga < now() - c_janela then
    return query select false, null::text, false, null::text, null::text, null::text;
    return;
  end if;

  -- ---- pausa por anomalia ----
  -- O proprio `update` e o claim, e por isso a notificacao sai UMA vez sem
  -- precisar da mecanica de reserva da 52: quem ja esta em `anomalia` nao entra.
  -- A condicao inclui `status <> 'pausado'` OR motivo diferente porque uma pausa
  -- VENCIDA deixa `status = 'pausado'` na coluna crua (a lapide) — sem a segunda
  -- metade, conversa nesse estado nunca seria marcada.
  update public.conversas cv
  set status       = 'pausado',
      motivo_pausa = 'anomalia',
      pausado_em   = now()
  where cv.tenant_id = p_tenant_id
    and cv.conversation_id = p_conversation_id
    and (cv.status <> 'pausado' or cv.motivo_pausa is distinct from 'anomalia');

  if not found then
    -- Outra execucao chegou antes. Pausada esta; notificar de novo, nao.
    return query select true, 'anomalia'::text, false, null::text, null::text, null::text;
    return;
  end if;

  -- ---- o aviso, pelo canal do `transferir_humano` ----
  -- Reuso e nao canal novo, por dois motivos: e o mesmo recado ("um humano
  -- precisa olhar esta conversa"), e esta PREENCHIDO em 4 tenants, enquanto
  -- `vendas.config` esta `{}` nos quatro — notificacao que depende de config
  -- vazia e notificacao que nao existe.
  --
  -- Le a config SEM exigir `ativo`/`contratado`: isto nao e a tool transferir
  -- humano funcionando, e o agente avisando que ELE MESMO parou. A superficie da
  -- tool (a tela de config) continua fechada por contratacao, como manda a regra.
  select coalesce(tt.config, '{}'::jsonb) into v_cfg
  from public.tenant_tools tt
  where tt.tenant_id = p_tenant_id
    and tt.tool_nome = 'transferir_humano';

  v_sessao  := btrim(coalesce(v_cfg #>> '{notificacao,sessao}', ''));
  v_destino := btrim(coalesce(v_cfg #>> '{notificacao,destino}', ''));

  if coalesce(v_cfg #>> '{notificacao,canal}', 'nenhum') <> 'waha'
     or v_sessao = '' or v_destino = '' then
    return query select true, 'anomalia'::text, true, null::text, null::text, null::text;
    return;
  end if;

  select public.contato_exibivel(cv.contact_name), cv.phone
    into v_nome, v_fone
  from public.conversas cv
  where cv.tenant_id = p_tenant_id
    and cv.conversation_id = p_conversation_id;

  v_msg :=
      E'⚠️ *Atendimento pausado automaticamente*\n'
    || format(E'\nA conversa com %s recebeu a MESMA mensagem %s vezes seguidas, e o agente parou para nao ficar respondendo em laco.',
              coalesce(nullif(v_nome, ''),
                       case when coalesce(btrim(v_fone), '') <> '' then 'o contato ' || btrim(v_fone) else 'um contato' end),
              c_repeticoes)
    || case when coalesce(btrim(v_fone), '') <> ''
            then format(E'\n\n📱 %s%s',
                        case when btrim(v_fone) ~ '^[0-9]+$' then '+' else '' end, btrim(v_fone))
            else '' end
    || format(E'\n\nUltima mensagem recebida:\n"%s"',
              left(btrim(coalesce(public.texto_normalizado(v_ultima), '(vazia)')), 200))
    || E'\n\nIsso costuma ser outro robo do outro lado. O agente NAO volta sozinho nesta conversa — retome pelo painel depois de olhar.';

  return query select true, 'anomalia'::text, true, v_sessao, v_destino, v_msg;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Grants — revoke antes, e os DOIS roles
-- ---------------------------------------------------------------------
-- Funcao nova nasce com EXECUTE para PUBLIC (padrao do Postgres) e, neste
-- projeto, para `anon` e `authenticated` tambem. Sem o revoke, a chave anonima
-- do navegador executaria uma SECURITY DEFINER que ESCREVE pausa e devolve
-- telefone de cliente. Foi assim que a migracao 43 encontrou sete funcoes
-- expostas: nenhuma tinha `anon=` proprio, todas passavam por PUBLIC.
revoke all on function public.api_n8n_portao_mensagem(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.texto_normalizado(text)
  from public, anon, authenticated;

-- `service_role` e o PostgREST/supabase-js; `n8n_agent` e como o n8n conecta de
-- verdade, e foi a linha que faltou nas migracoes 40 e 41.
grant execute on function public.api_n8n_portao_mensagem(uuid, bigint) to service_role;
grant execute on function public.api_n8n_portao_mensagem(uuid, bigint) to n8n_agent;
grant execute on function public.texto_normalizado(text) to service_role;
grant execute on function public.texto_normalizado(text) to n8n_agent;

comment on function public.api_n8n_portao_mensagem(uuid, bigint) is
  'Portao de cada mensagem: teto de consumo do tenant, pausa vigente, e pausa por anomalia (N entradas identicas seguidas). '
  'Devolve SEMPRE uma linha. `anomalia` = true so na transicao, que ocorre uma vez.';

commit;
