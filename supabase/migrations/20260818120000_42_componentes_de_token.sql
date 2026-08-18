-- Migracao 42 — decomposicao dos tokens em `mensagens_log`
--
-- O QUE ELA FAZ, E SO ISSO: passa a GRAVAR os componentes que o
-- `n8n/estima-tokens.js` ja calcula e joga fora. Nenhuma regra de rateio entra
-- aqui — nao ha coluna "cliente", nao ha coluna "agencia", nao ha teto de
-- referencia. A classificacao ainda esta EM ABERTO
-- (docs/PENDENCIA-FATURA-OPENAI.md) e vai entrar na QUERY quando houver
-- decisao. Gravar separado e o que permite decidir depois sem regravar nada.
--
-- POR QUE AGORA, se a cobranca nao existe ainda: decomposicao NAO E RETROATIVA.
-- Hoje a tabela guarda so o total ja somado, e o no calcula os componentes e
-- descarta todos menos a soma. Cada turno que passa e um turno que nunca podera
-- ser olhado por componente — e a decisao de modelo de plano depende justamente
-- disso, porque um total que mistura uso (mensagens, memoria, ferramenta) com
-- configuracao (comprimento do prompt que a agencia escreveu) leva a decisao
-- errada. Com tres clientes entrando, a janela de perda e agora.
--
-- ============================ TRANSPORTE: JSONB ============================
--
-- Um parametro novo, `p_componentes jsonb`, e nao oito escalares. Motivo: esta e
-- a SEXTA vez que esta assinatura muda (28, 32, 37, 40, 41 na familia) e a ideia
-- e ser a ultima por este motivo. Componente novo depois vira coluna + uma linha
-- no insert, sem tocar em assinatura, sem tocar no n8n alem do objeto que o no
-- Code ja monta.
--
-- As colunas continuam TIPADAS e separadas — o jsonb e so o transporte.
--
-- ===================== A FUNCAO NUNCA ESTOURA POR DIAGNOSTICO ==============
--
-- `(p_componentes->>'wrapper')::int` estoura com `22P02` se chegar texto nao
-- numerico. Isso e o caminho quente: TODA mensagem de TODO cliente passa aqui, e
-- derrubar o log de uma conversa real por causa de um campo de diagnostico mal
-- formado seria trocar um problema de contabilidade por um de atendimento. Por
-- isso a extracao passa por `public.n8n_json_int`, que devolve NULL em vez de
-- levantar quando a chave nao e um numero JSON.
--
-- ========================= GRANTS: A ARMADILHA DA 41 ======================
--
-- `DROP FUNCTION` apaga TODOS os grants, e recriar restaura so o que o script
-- listar. Foi assim nas migracoes 40 e 41.
--
-- AQUI HA UM AGRAVANTE QUE NAO EXISTIA LA. O ACL atual desta funcao e:
--
--   =X/postgres | postgres=X | anon=X | authenticated=X | service_role=X
--
-- `n8n_agent` NAO TEM GRANT EXPLICITO. Ele executa hoje pelo `=X` — o grant
-- implicito a PUBLIC. Ou seja: revogar de PUBLIC sem conceder explicitamente a
-- `n8n_agent` derruba o log em TODA mensagem, na funcao mais quente do sistema.
-- As duas linhas de grant abaixo nao sao redundantes; a segunda e a que o agente
-- usa.
--
-- E POR QUE MEXER NO ACL, ja que a tarefa era outra: `anon` e a chave que vai no
-- navegador, e esta funcao e SECURITY DEFINER que ESCREVE em `mensagens_log` —
-- que esta virando base de cobranca. Linha falsa ali vira valor cobrado errado.
-- As tres irmas (`api_n8n_ver_pedido`, `api_n8n_buscar_produtos`,
-- `api_n8n_tools_ativas`) ja estao no formato correto; esta ficou para tras.
-- Nao ha chamador no app nem em Edge Function — so o n8n, conferido por varredura.
--
-- VERIFICACAO QUE VALE: diff do ACL antes/depois e CHAMADA REAL com
-- `set local role n8n_agent`. `has_function_privilege` diz o que o ACL contem;
-- so a chamada diz o que acontece. Ver tests/migracao-componentes-token.mjs.
--
-- ROLLBACK: 20260818120000_42_componentes_de_token_rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. Colunas. Todas nullable e SEM default: o historico fica com NULL, e isso e
--    honesto — nao da para inventar decomposicao do que foi gravado somado.
--    Sem DEFAULT nao ha reescrita de tabela (seria irrelevante com 114 linhas,
--    mas o habito vale para quando nao for).
-- ---------------------------------------------------------------------------
alter table public.mensagens_log
  add column if not exists tokens_wrapper        integer,
  add column if not exists tokens_system_prompt  integer,
  add column if not exists tokens_schema_tools   integer,
  add column if not exists tokens_mensagens      integer,
  add column if not exists tokens_memoria        integer,
  add column if not exists tokens_round_trip     integer,
  add column if not exists chamadas              integer,
  add column if not exists fonte_tokens          text;

comment on column public.mensagens_log.tokens_wrapper is
  'Componente: wrapper do perfil (basico/vendas), JA multiplicado por chamadas. Sem regra de rateio aplicada — ver docs/PENDENCIA-FATURA-OPENAI.md.';
comment on column public.mensagens_log.tokens_system_prompt is
  'Componente: system_prompt do tenant, JA multiplicado por chamadas. Classificacao (cliente ou agencia) EM ABERTO.';
comment on column public.mensagens_log.tokens_schema_tools is
  'Componente: schema das tools do perfil, JA multiplicado por chamadas.';
comment on column public.mensagens_log.tokens_mensagens is
  'Componente: texto trocado no turno, JA multiplicado por chamadas.';
comment on column public.mensagens_log.tokens_memoria is
  'Componente: janela de memoria do Redis, JA multiplicada por chamadas.';
comment on column public.mensagens_log.tokens_round_trip is
  'Componente: crescimento acumulado dos round-trips de ferramenta.';
comment on column public.mensagens_log.chamadas is
  'Quantas vezes o modelo foi chamado no turno. Diagnostico: 1 + intermediateSteps.';
comment on column public.mensagens_log.fonte_tokens is
  'Quem estimou: estimativa_nossa_com_multiplicidade | estimativa_n8n_sub_no. NENHUMA das duas e a fatura da OpenAI.';

-- ---------------------------------------------------------------------------
-- 2. Extracao que nao levanta. Ver o bloco do cabecalho: caminho quente.
-- ---------------------------------------------------------------------------
create or replace function public.n8n_json_int(p_json jsonb, p_chave text)
returns integer
language sql
immutable
set search_path to 'public'
as $$
  -- `jsonb_typeof` antes do cast: chave ausente, string, booleano ou objeto
  -- devolvem NULL em vez de estourar. O passo por `numeric` aceita 5759.0.
  select case
           when jsonb_typeof(p_json -> p_chave) = 'number'
           then ((p_json ->> p_chave)::numeric)::integer
         end;
$$;

comment on function public.n8n_json_int(jsonb, text) is
  'Extrai inteiro de jsonb devolvendo NULL quando a chave nao e numero. Existe para o caminho quente de api_n8n_registrar_mensagem nunca cair por dado de diagnostico mal formado.';

-- ---------------------------------------------------------------------------
-- 3. A funcao. DROP EXPLICITO PELA LISTA COMPLETA DE TIPOS antes do
--    `create or replace`: com o parametro novo as duas assinaturas ficariam
--    vivas e a chamada de 9 argumentos — a que o n8n faz HOJE — viraria
--    ambigua. Dropar pelo NOME erraria com varias assinaturas vivas.
--    O `create or replace` fica depois do drop para a migracao continuar
--    reexecutavel.
-- ---------------------------------------------------------------------------
drop function if exists public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text
);

create or replace function public.api_n8n_registrar_mensagem(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_direcao         text,
  p_conteudo        text    default null,
  p_tokens_entrada  integer default null,
  p_tokens_saida    integer default null,
  p_modelo          text    default null,
  p_audio_segundos  numeric default null,
  p_execucao_id     text    default null,
  -- O parametro novo. COM DEFAULT, de proposito: a chamada de 9 argumentos que
  -- o workflow em producao faz hoje continua resolvendo, entao esta migracao
  -- entra sozinha e o workflow novo e importado quando der. Nao ha instante em
  -- que producao fica sem funcao, e se o import nunca acontecer o unico efeito
  -- e coluna nula — que e exatamente o estado de hoje.
  p_componentes     jsonb   default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_id uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_direcao not in ('entrada', 'saida') then
    raise exception 'api_n8n: direcao invalida: %', p_direcao using errcode = '22023';
  end if;

  if p_audio_segundos is not null and p_audio_segundos < 0 then
    raise exception 'api_n8n: audio_segundos negativo: %', p_audio_segundos using errcode = '22023';
  end if;

  -- O `where` do ON CONFLICT tem de repetir o predicado do indice parcial para
  -- o Postgres inferir qual indice usar. Com `p_execucao_id` nulo a linha nem
  -- entra no indice, entao nao ha conflito possivel e o insert e o de sempre —
  -- e por isso que a chamada antiga de 8 argumentos segue se comportando como
  -- antes.
  --
  -- NOTA SOBRE OS COMPONENTES E A IDEMPOTENCIA: no conflito o DO NOTHING nao
  -- atualiza nada, entao um retry NAO preenche os componentes de uma linha que
  -- entrou sem eles. Isso e deliberado: a alternativa (DO UPDATE) faria um
  -- reprocessamento reescrever dado de uma linha ja contabilizada, e a 37 existe
  -- justamente para um turno contar UMA vez.
  insert into public.mensagens_log
    (tenant_id, conversation_id, direcao, conteudo, tokens_entrada, tokens_saida,
     modelo, audio_segundos, execucao_id,
     tokens_wrapper, tokens_system_prompt, tokens_schema_tools,
     tokens_mensagens, tokens_memoria, tokens_round_trip, chamadas, fonte_tokens)
  values
    (p_tenant_id, p_conversation_id, p_direcao, p_conteudo, p_tokens_entrada, p_tokens_saida,
     p_modelo, p_audio_segundos, p_execucao_id,
     public.n8n_json_int(p_componentes, 'wrapper'),
     public.n8n_json_int(p_componentes, 'system_prompt'),
     public.n8n_json_int(p_componentes, 'schema_tools'),
     public.n8n_json_int(p_componentes, 'mensagens'),
     public.n8n_json_int(p_componentes, 'memoria'),
     public.n8n_json_int(p_componentes, 'round_trip'),
     public.n8n_json_int(p_componentes, 'chamadas'),
     nullif(p_componentes ->> 'fonte', ''))
  on conflict (tenant_id, execucao_id, direcao) where execucao_id is not null
    do nothing
  returning id into v_id;

  -- DO NOTHING nao devolve linha no conflito, e `returning` deixa v_id nulo. Sem
  -- este bloco o no do n8n receberia null e leria como falha. Devolver o id que
  -- JA existe e o que faz a funcao ser idempotente de verdade: mesma chamada,
  -- mesma resposta.
  if v_id is null and p_execucao_id is not null then
    select m.id into v_id
      from public.mensagens_log m
     where m.tenant_id = p_tenant_id
       and m.execucao_id = p_execucao_id
       and m.direcao = p_direcao;
  end if;

  return v_id;
end;
$function$;

comment on function public.api_n8n_registrar_mensagem(uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb) is
  'Registra o turno em mensagens_log, idempotente por (tenant, execucao, direcao). p_componentes traz a decomposicao dos tokens; chave nao numerica vira NULL, nunca excecao.';

-- ---------------------------------------------------------------------------
-- 4. Grants. Ver o cabecalho: o `drop` acima zerou o ACL, e o que nao estiver
--    aqui deixa de existir. `revoke ... from public` tira o grant IMPLICITO que
--    a criacao devolve — sem ele, `anon` continua executando por heranca.
-- ---------------------------------------------------------------------------
revoke all on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb
) from public;
revoke all on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb
) from anon;
revoke all on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb
) from authenticated;

-- service_role e o role do PostgREST/supabase-js.
grant execute on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb
) to service_role;

-- n8n_agent e o role com que o agente conecta. ESTA e a linha que roda em toda
-- mensagem, e a que nao existia antes desta migracao (ele herdava de PUBLIC).
grant execute on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb
) to n8n_agent;

commit;
