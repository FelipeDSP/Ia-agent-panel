-- =====================================================================
-- ROLLBACK da 61 — tira o esqueleto de pagamento
-- =====================================================================
--
-- ELE ABORTA se houver pagamento registrado, e isso e o comportamento certo.
--
-- `drop table public.pedido_cobrancas` apaga o vinculo entre um pedido e o
-- dinheiro que entrou por ele. Num banco onde nenhuma cobranca foi paga isso
-- nao custa nada; num banco onde alguma foi, custa a unica prova de que ela
-- foi. Entao ele para, com mensagem propria, e quem quiser mesmo remover tem
-- de decidir o que fazer com aquelas linhas primeiro.
--
-- E a mesma forma da nota do CLAUDE.md sobre a 55: rollback continua sendo
-- obrigatorio e continua devendo ABORTAR com mensagem propria quando desfazer
-- destruiria dado que so existe depois da migracao. Aqui ha dois gatilhos —
-- cobranca paga e tool contratada —, e o segundo pelo mesmo motivo: apagar
-- `catalogo_tools` com `tenant_tools` apontando para ela transforma o rollback
-- em "descontratar cliente", que este projeto ja decidiu que nunca acontece
-- sozinho.
--
-- O QUE VOLTA: `api_n8n_estado_pedido` sem `pagamento_confirmado`, no corpo
-- EXATO que estava em producao antes da 61 (`pg_get_functiondef`, extraido no
-- dia da entrega). Como e troca de tipo de retorno, aqui tambem e `drop` pela
-- lista completa de tipos — e por isso ESTE arquivo TEM bloco de grants, ao
-- contrario dos rollbacks de 59 e 60. Sem ele o `n8n_agent` fica sem
-- `execute` e o portao para de ter estado, em silencio, no proximo turno de
-- todo tenant de vendas.
--
-- REEXECUTAVEL: `drop ... if exists`, `create or replace`, `delete` idempotente.
-- =====================================================================

begin;

do $$
declare
  v_pagas integer;
  v_contratada integer;
begin
  -- `to_regclass` e o que torna este rollback replayavel num banco PRE-61, onde
  -- a tabela nao existe: sem ele o proprio `select` estoura `42P01` e o teste
  -- de migracao — que comeca pelo rollback justamente para nao afirmar o
  -- calendario — nao conseguiria comecar.
  if to_regclass('public.pedido_cobrancas') is null then
    v_pagas := 0;
  else
    execute 'select count(*) from public.pedido_cobrancas
              where pago_em is not null or fora_do_prazo_em is not null'
       into v_pagas;
  end if;

  if v_pagas > 0 then
    raise exception
      'ROLLBACK DA 61 ABORTADO: % cobranca(s) com pagamento registrado. Dropar `pedido_cobrancas` apagaria a unica prova de que aquele dinheiro entrou. Decida o que fazer com essas linhas (exportar, arquivar) antes de rodar isto.',
      v_pagas
      using errcode = 'P0001';
  end if;

  select count(*) into v_contratada
    from public.tenant_tools where tool_nome = 'pagamento';

  if v_contratada > 0 then
    raise exception
      'ROLLBACK DA 61 ABORTADO: % tenant(s) com a tool `pagamento` em `tenant_tools`. Apagar o catalogo com contratacao viva e descontratar cliente por efeito colateral. Descontrate pelo painel primeiro, de proposito.',
      v_contratada
      using errcode = 'P0001';
  end if;
end $$;

-- --- funcoes novas ---
drop function if exists public.api_n8n_confirmar_pagamento_notificado(uuid, uuid, boolean, text);
drop function if exists public.api_n8n_pagamento_webhook(text, text, text, text, text, text, integer);
drop function if exists public.api_n8n_registrar_cobranca(uuid, uuid, boolean, text, text, text);
drop function if exists public.api_n8n_gerar_cobranca(uuid, bigint);
drop function if exists public.api_n8n_credencial_asaas(uuid);

-- --- tabelas ---
drop table if exists public.pagamento_eventos;
drop table if exists public.pedido_cobrancas;
drop index if exists public.uq_pedidos_tenant_id;

-- --- catalogo (ja provado vazio de contratacao pelo bloco acima) ---
delete from public.catalogo_tools where tool_nome = 'pagamento';

-- --- colunas ---
alter table public.tenants
  drop constraint if exists tenants_pagamento_expira_valido;
alter table public.tenants
  drop column if exists pagamento_expira_minutos;

alter table public.tenant_credenciais
  drop constraint if exists tenant_credenciais_asaas_token_tamanho;
alter table public.tenant_credenciais
  drop constraint if exists tenant_credenciais_asaas_ambiente_valido;
alter table public.tenant_credenciais
  drop column if exists asaas_webhook_token_producao,
  drop column if exists asaas_webhook_token_sandbox,
  drop column if exists asaas_api_key_producao,
  drop column if exists asaas_api_key_sandbox,
  drop column if exists asaas_ambiente;

-- --- api_n8n_estado_pedido volta a assinatura de 8 colunas ---
drop function if exists public.api_n8n_estado_pedido(uuid, bigint, text, integer);

CREATE OR REPLACE FUNCTION public.api_n8n_estado_pedido(p_tenant_id uuid, p_conversation_id bigint, p_perfil text DEFAULT 'vendas'::text, p_teto_segundos integer DEFAULT 300)
 RETURNS TABLE(tem_pedido boolean, pedido_id uuid, pedido_status text, pedido_numero integer, total_centavos integer, itens jsonb, escreveu_neste_turno boolean, barrou_anterior boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_limite     timestamptz;
  v_tocado     uuid;
  v_ref        uuid;
  v_status     text;
  v_numero     integer;
  v_total      integer;
  v_itens      jsonb;
  v_barrou     boolean;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if coalesce(p_perfil, '') <> 'vendas' then
    return query select false, null::uuid, null::text, null::integer, 0, '[]'::jsonb, false, false;
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
  -- neste turno" — e passaria uma fabricacao por isso. E a mesma forma do
  -- defeito que a §6 da PENDENCIA-VENDA-AFIRMADA-SEM-TOOL registra na D2, onde
  -- `atualizado_em` movido pela expiracao fez um pedido engolir a conversa de
  -- onze dias depois.
  --
  -- O teto sai da outra ponta da mesma medicao: a distancia entre a escrita e o
  -- turno que a narrou, nas 22 escritas do historico, e de 1,3 s (minimo),
  -- 2,3 s (mediana), 7,3 s (p95) e 10,0 s (MAXIMO). O default de 300 s e 30x o
  -- maximo observado — folga para debounce (ate 15 s), agente lento e retry —
  -- e ainda assim corta a janela de 18 dias para 5 minutos.
  --
  -- `greatest` das duas: manda a borda MAIS RECENTE. Em conversa ativa a ultima
  -- saida e que limita (41 s de mediana); em conversa que voltou depois de dias,
  -- o teto e que limita.
  v_limite := greatest(
    coalesce((select max(m.criado_em)
                from public.mensagens_log m
               where m.tenant_id = p_tenant_id
                 and m.conversation_id = p_conversation_id
                 and m.direcao = 'saida'), '-infinity'::timestamptz),
    now() - make_interval(secs => greatest(coalesce(p_teto_segundos, 300), 1))
  );

  -- PRIMEIRO TURNO DA CONVERSA: nao ha saida anterior, entao `max` e nulo e o
  -- `coalesce` devolve `-infinity` — e ai o `greatest` faz o TETO ser a unica
  -- borda. E o comportamento certo, e nao um acidente: no primeiro turno a
  -- unica escrita que pode ter sido feita por ESTE turno e uma de segundos
  -- atras. Um pedido que ja existia na conversa antes da primeira fala do bot
  -- (rascunho pendurado de uma sessao antiga) NAO conta como escrita de agora,
  -- que era exatamente o furo do `-infinity` sozinho.

  -- ------------------------------------------------------------------
  -- A REFERENCIA: O PEDIDO TOCADO NO TURNO, E SO ENTAO O RASCUNHO
  -- ------------------------------------------------------------------
  -- Antes esta funcao devolvia SEMPRE o rascunho, e isso deixava escapar a
  -- ocorrencia de 21/08 (`emporio` conv 18, R$ 42,50): a tool RODOU, o
  -- `fechar_pedido` transformou o rascunho em `aguardando_pagamento`, e no
  -- instante da consulta nao havia mais rascunho nenhum — a regra 2 ficava sem
  -- referencia justamente no turno do fechamento, que e quando o valor final e
  -- dito ao cliente.
  --
  -- Agora a referencia e o pedido TOCADO nesta janela, em qualquer status. Isso
  -- cobre o fechamento (o pedido acabou de virar `aguardando_pagamento` e ainda
  -- e o pedido do turno) e cobre o cancelamento pelo mesmo caminho.
  --
  -- `deletado_em is null` porque soft delete e o padrao do projeto para pedido
  -- removido de proposito.
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
                        and i.tenant_id = p_tenant_id), p.atualizado_em)
         ) > v_limite
   order by p.atualizado_em desc
   limit 1;

  -- Sem pedido tocado, a referencia volta a ser o rascunho: ele e o que o
  -- cliente esta montando, e e contra ele que um total recitado deve bater.
  -- A migracao 55 deixou o indice unico valer so em `rascunho`, entao ha no
  -- maximo um.
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

  if v_ref is null then
    return query select false, null::uuid, null::text, null::integer, 0, '[]'::jsonb,
                        false, coalesce(v_barrou, false);
    return;
  end if;

  select p.status, p.numero, coalesce(p.total_centavos, 0)
    into v_status, v_numero, v_total
    from public.pedidos p
   where p.id = v_ref and p.tenant_id = p_tenant_id;

  -- Itens em CENTAVOS. `nome_snapshot` e o nome congelado na venda; nao e
  -- recalculado aqui de proposito.
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
           coalesce(v_barrou, false);
end;
$function$
;

-- O `drop` acima apagou TODOS os grants (28/32/37/40/41). Reconceder e
-- obrigatorio, e o `revoke` vem antes porque funcao recriada neste projeto
-- nasce com EXECUTE para PUBLIC.
revoke all on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) from public;
revoke all on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) from anon;
revoke all on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) from authenticated;
grant execute on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) to service_role;
grant execute on function public.api_n8n_estado_pedido(uuid, bigint, text, integer) to n8n_agent;

commit;
