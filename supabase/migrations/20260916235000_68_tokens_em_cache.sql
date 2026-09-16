-- =====================================================================
-- 68. Tokens em CACHE — o custo da aba passa a bater com a fatura da OpenAI
-- =====================================================================
--
-- A OpenAI cobra METADE pelos tokens de entrada que repetem o comeco da
-- chamada anterior (`usage.input_tokens_details.cached_tokens`) — e o system
-- prompt inteiro (instrucoes fixas + prompt do cliente + schemas das tools) se
-- repete a cada turno. Medido no sendbox em 16/09: ~4.100 de ~5.000 tokens de
-- entrada por turno sao cacheaveis; a aba, que aplicava o preco cheio a tudo,
-- mostrava um custo ~2,5x acima do faturado. Decisao do Felipe: a aba mostra
-- o custo REAL. Nada muda em quem paga o que (isso e regra comercial, e os
-- componentes por mensagem ja estao gravados desde a 42).
--
--   - `mensagens_log.tokens_entrada_cache` (nulo = desconhecido: estimativas do
--     n8n, linhas antigas);
--   - `precos_modelo.usd_entrada_cache_por_1m` (gpt-4.1: 0,50; gpt-4.1-mini:
--     0,10 — tabela da OpenAI em 09/2026; sem preco, o cache e cobrado como
--     entrada normal, nunca mais barato do que a tabela diz);
--   - `api_n8n_registrar_mensagem`: MESMA assinatura (a chave `entrada_cache`
--     vem no jsonb `p_componentes`) — grants intactos, conferido por diff;
--   - `billing_consumo_mensal`: tipo de retorno MUDA (tres colunas a mais:
--     cache, mensagens reais, mensagens estimadas) => drop + create + o bloco
--     de grants (a armadilha das 40/41: drop apaga o ACL). ACL da 43 mantido:
--     authenticated (a funcao checa super_admin por dentro) e service_role.
--
-- Extensao: nenhuma. REEXECUTAVEL. Rollback ao lado.
-- =====================================================================

begin;

alter table public.mensagens_log add column if not exists tokens_entrada_cache integer;
comment on column public.mensagens_log.tokens_entrada_cache is
  'Tokens de entrada servidos do cache da OpenAI (metade do preco). Nulo = desconhecido (estimativa). 68.';

alter table public.precos_modelo add column if not exists usd_entrada_cache_por_1m numeric;
update public.precos_modelo set usd_entrada_cache_por_1m = 0.5000 where modelo = 'gpt-4.1' and usd_entrada_cache_por_1m is null;
update public.precos_modelo set usd_entrada_cache_por_1m = 0.1000 where modelo = 'gpt-4.1-mini' and usd_entrada_cache_por_1m is null;

-- --- api_n8n_registrar_mensagem: mesma assinatura, uma coluna a mais no insert ---
create or replace function public.api_n8n_registrar_mensagem(p_tenant_id uuid, p_conversation_id bigint, p_direcao text, p_conteudo text DEFAULT NULL::text, p_tokens_entrada integer DEFAULT NULL::integer, p_tokens_saida integer DEFAULT NULL::integer, p_modelo text DEFAULT NULL::text, p_audio_segundos numeric DEFAULT NULL::numeric, p_execucao_id text DEFAULT NULL::text, p_componentes jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_id uuid;
  v_cortes jsonb;
  v_portao jsonb;  -- 56: veredito do portao de venda afirmada
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_direcao not in ('entrada', 'saida') then
    raise exception 'api_n8n: direcao invalida: %', p_direcao using errcode = '22023';
  end if;

  if p_audio_segundos is not null and p_audio_segundos < 0 then
    raise exception 'api_n8n: audio_segundos negativo: %', p_audio_segundos using errcode = '22023';
  end if;

  -- Guardado por `jsonb_typeof`: chave ausente, `null` JSON, array vazio ou
  -- tipo errado viram NULL em vez de levantar. Ver o cabecalho.
  v_cortes := case
    when jsonb_typeof(p_componentes -> 'saida_cortes') = 'array'
     and jsonb_array_length(p_componentes -> 'saida_cortes') > 0
    then p_componentes -> 'saida_cortes'
    else null
  end;

  -- 56: mesma guarda por tipo, agora para objeto. Chave ausente ou tipo errado
  -- viram NULL, e `null` continua significando "o portao nao rodou".
  v_portao := case
    when jsonb_typeof(p_componentes -> 'portao') = 'object'
    then p_componentes -> 'portao'
    else null
  end;

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
  -- justamente para um turno contar UMA vez. Vale igual para `saida_cortes` e
  -- para `portao`.
  insert into public.mensagens_log
    (tenant_id, conversation_id, direcao, conteudo, tokens_entrada, tokens_saida,
     modelo, audio_segundos, execucao_id,
     tokens_wrapper, tokens_system_prompt, tokens_schema_tools,
     tokens_mensagens, tokens_memoria, tokens_round_trip, chamadas, fonte_tokens,
     saida_cortes, portao, tokens_entrada_cache)
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
     nullif(p_componentes ->> 'fonte', ''),
     v_cortes, v_portao,
     -- 68: tokens de entrada que vieram do CACHE da OpenAI (metade do preco). Nulo = desconhecido (estimativa).
     public.n8n_json_int(p_componentes, 'entrada_cache'))
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


-- --- billing_consumo_mensal: tipo de retorno novo -> drop + create + grants ---
drop function if exists public.billing_consumo_mensal();
create or replace function public.billing_consumo_mensal()
 returns table(tenant_id uuid, tenant_nome text, mes date, tokens_entrada bigint, tokens_saida bigint, tokens_embedding bigint, custo_usd numeric,
               tokens_entrada_cache bigint, mensagens_reais bigint, mensagens_estimadas bigint)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not public.auth_is_super_admin() then
    raise exception 'billing_consumo_mensal: apenas super_admin' using errcode = '42501';
  end if;

  return query
  with conv as (
    select m.tenant_id,
           date_trunc('month', m.criado_em)::date as mes,
           coalesce(m.tokens_entrada, 0)::bigint as te,
           coalesce(m.tokens_saida, 0)::bigint   as ts,
           -- 68: a parte da entrada que veio do cache; nunca acima da entrada
           least(coalesce(m.tokens_entrada_cache, 0), coalesce(m.tokens_entrada, 0))::bigint as tc,
           (m.direcao = 'saida' and m.fonte_tokens = 'openai_usage') as real,
           (m.direcao = 'saida' and m.fonte_tokens like 'estimativa%') as estimada,
           p.usd_entrada_por_1m as pe,
           p.usd_saida_por_1m   as ps,
           -- sem preco de cache cadastrado, o cache e cobrado como entrada normal (nunca mais barato do que a tabela diz)
           coalesce(p.usd_entrada_cache_por_1m, p.usd_entrada_por_1m) as pc
    from public.mensagens_log m
    left join lateral (
      select pm.usd_entrada_por_1m, pm.usd_saida_por_1m, pm.usd_entrada_cache_por_1m
      from public.precos_modelo pm
      where pm.modelo = m.modelo and pm.vigente_desde <= m.criado_em
      order by pm.vigente_desde desc limit 1
    ) p on true
  ),
  ing as (
    select u.tenant_id,
           date_trunc('month', u.criado_em)::date as mes,
           coalesce(u.tokens, 0)::bigint as tk,
           p.usd_embedding_por_1m as pemb
    from public.uso_ingestao u
    left join lateral (
      select pm.usd_embedding_por_1m
      from public.precos_modelo pm
      where pm.modelo = u.modelo and pm.vigente_desde <= u.criado_em
      order by pm.vigente_desde desc limit 1
    ) p on true
  ),
  agg as (
    select c.tenant_id, c.mes,
           sum(c.te) as te, sum(c.ts) as ts, 0::bigint as tk, sum(c.tc) as tc,
           count(*) filter (where c.real) as reais, count(*) filter (where c.estimada) as estimadas,
           sum((c.te - c.tc) / 1e6 * coalesce(c.pe, 0) + c.tc / 1e6 * coalesce(c.pc, 0) + c.ts / 1e6 * coalesce(c.ps, 0)) as custo
    from conv c group by c.tenant_id, c.mes
    union all
    select i.tenant_id, i.mes, 0::bigint, 0::bigint, sum(i.tk), 0::bigint, 0::bigint, 0::bigint,
           sum(i.tk / 1e6 * coalesce(i.pemb, 0))
    from ing i group by i.tenant_id, i.mes
  )
  select a.tenant_id, t.nome, a.mes,
         sum(a.te)::bigint, sum(a.ts)::bigint, sum(a.tk)::bigint,
         round(sum(a.custo)::numeric, 4),
         sum(a.tc)::bigint, sum(a.reais)::bigint, sum(a.estimadas)::bigint
  from agg a join public.tenants t on t.id = a.tenant_id
  group by a.tenant_id, t.nome, a.mes
  order by a.mes desc, t.nome;
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array['public.billing_consumo_mensal()'] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
