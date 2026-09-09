-- =====================================================================
-- 56. Portao de venda afirmada — estado do pedido para o no de saida
-- =====================================================================
--
-- O QUE ESTA MIGRACAO FAZ
--
--   1. `api_n8n_estado_pedido(uuid, bigint, text)` — funcao NOVA, somente
--      leitura, que devolve o rascunho da conversa (itens, total, ultima
--      mutacao) e responde a UNICA pergunta que o portao nao consegue fazer
--      sozinho: **houve escrita neste turno?**
--   2. `mensagens_log.portao jsonb` — coluna nova para o veredito do portao,
--      no mesmo desenho do `saida_cortes` da migracao 46.
--   3. `api_n8n_registrar_mensagem` ganha UMA linha para extrair essa chave do
--      `p_componentes` que ela ja recebe. **MESMA ASSINATURA** — ver abaixo.
--
-- ---------------------------------------------------------------------
-- POR QUE FUNCAO NOVA E NAO `api_n8n_ver_pedido`
--
-- `api_n8n_ver_pedido` PARECE a resposta pronta e nao serve, por dois motivos
-- medidos:
--
--   a) ela ESCREVE. `pedido_rascunho_da_conversa` e `pedido_fechado_da_conversa`
--      chamam `expirar_pedidos_vencidos` por dentro, que muda `status` e carimba
--      `atualizado_em`. Poe-la no caminho de ENVIO mudaria a expiracao de
--      "quando a conversa usa uma ferramenta" para "a cada mensagem que sai" — e
--      `atualizado_em` e exatamente a coluna que este portao le como "houve
--      escrita neste turno". A funcao mediria o proprio efeito colateral;
--   b) ela devolve TEXTO ja formatado, e o portao precisa de centavos. Dinheiro
--      e integer em centavos em todo o caminho; a formatacao para real acontece
--      so na montagem do texto, no no do n8n.
--
-- Esta funcao e `stable`, nao chama expiracao, e nao escreve nada.
--
-- ---------------------------------------------------------------------
-- "HOUVE ESCRITA NESTE TURNO" — A ESCOLHA, E AS ALTERNATIVAS DESCARTADAS
--
-- A definicao usada e:
--
--   ultima_mutacao_do_pedido > ultima_saida_registrada_desta_conversa
--
-- O instante de referencia sai do PROPRIO BANCO (`mensagens_log`), e nao do
-- n8n. Isso funciona porque `Registra Mensagem` roda DEPOIS do portao: no
-- momento da consulta, a saida mais recente registrada e a do turno ANTERIOR.
-- Entao "mutou depois dela" == "mutou neste turno", cobrindo o turno inteiro,
-- inclusive as tool calls que o agente fez antes de o texto existir.
--
-- Alternativas consideradas e por que cairam:
--
--   - **instante de inicio da execucao do n8n.** Nao ha campo confiavel de
--     inicio de execucao exposto em expressao (`$execution` da `id` e `mode`).
--     Obter um exigiria capturar `Date.now()` num no do INICIO do fluxo — e os
--     candidatos sao `Extrair e Filtrar` (corpo injetado pelo gerador) ou
--     `api_n8n_conversa_sync` (mudanca de assinatura, familia 28/32/37/40/41).
--     Custo alto para um dado que o banco ja tem;
--   - **`Date.now()` dentro do `Estima Tokens` ou desta funcao.** Os dois rodam
--     DEPOIS do agente. Uma escrita feita pela tool do agente e ANTERIOR a esse
--     instante e seria classificada como "turno passado" — o criterio sairia
--     invertido, e invertido justamente no caso que importa;
--   - **guardar o estado anterior em Redis.** Acrescenta uma fonte de verdade
--     nova, com TTL proprio, para responder o que uma coluna ja responde.
--
-- LIMITE CONHECIDO E ACEITO: execucoes CONCORRENTES na mesma conversa (o
-- cliente manda em rajada) podem intercalar o registro das saidas, e a janela
-- fica errada. E o mesmo limite que a §6.1 da PENDENCIA-VENDA-AFIRMADA-SEM-TOOL
-- ja registra para a atribuicao turno-a-turno ("uma vez em 40"). O portao erra
-- para o lado seguro nesse caso: uma escrita da execucao vizinha faz o turno
-- parecer que escreveu, e a mensagem PASSA. Errar para passar num caso raro e
-- preferivel a barrar venda boa.
--
-- ---------------------------------------------------------------------
-- POR QUE `p_perfil` E PARAMETRO
--
-- O no do n8n roda no caminho unico, sem IF de topologia — condicionar por
-- ramo criaria dois caminhos e os consumidores passariam a referenciar um no
-- que nao executa no perfil `basico`, que e a classe de falha que este trabalho
-- existe para evitar. A economia, quando desejada, mora AQUI: com
-- `p_perfil <> 'vendas'` a funcao devolve a linha vazia sem tocar em `pedidos`.
--
-- ---------------------------------------------------------------------
-- A ALTERACAO EM `api_n8n_registrar_mensagem` NAO MUDA ASSINATURA
--
-- Ela ja recebe `p_componentes jsonb`, criado pela migracao 42 exatamente para
-- isto: "componente novo vira coluna + uma linha no insert, sem tocar em
-- assinatura". Consequencias, uma a uma:
--   - sem `drop function`, nao ha aridade ambigua (28, 32, 37);
--   - sem `drop function`, nenhum grant e apagado (40, 41);
--   - `create or replace` de mesma aridade e reexecutavel.
-- E as duas ordens de implantacao sao seguras: no antes da migracao, a funcao
-- ignora a chave que nao conhece; migracao antes do no, a coluna fica nula.
--
-- SEGURANCA
--   - `SECURITY DEFINER` comecando por `n8n_assert_tenant`;
--   - todo `where` filtra `tenant_id` explicitamente (regra 6 do CLAUDE.md);
--   - `revoke` ANTES do grant: funcao nova nasce com EXECUTE para PUBLIC neste
--     projeto, entao grant sem revoke e decoracao;
--   - grants nos DOIS roles: `service_role` (PostgREST) e `n8n_agent` (o role
--     com que o n8n conecta — o que faltou nas migracoes 40 e 41).
--
-- ROLLBACK: 20260909180000_56_portao_venda_afirmada_rollback.sql
--
-- NOME DO ARQUIVO x LEDGER: se esta migracao for aplicada fora do CLI, confira
-- `supabase_migrations.schema_migrations` e renomeie o arquivo para a versao
-- registrada. Ver a nota de migracoes no CLAUDE.md.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. A coluna do veredito
-- ---------------------------------------------------------------------
-- `null` = o portao nao rodou nesta linha (entrada, ou saida anterior a esta
-- migracao). Isso mantem a leitura "nao ha veredito" distinta de "passou".
alter table public.mensagens_log
  add column if not exists portao jsonb;

comment on column public.mensagens_log.portao is
  'Veredito do portao de venda afirmada (migracao 56). null = portao nao rodou. '
  'Guarda tambem o texto BRUTO do modelo quando houve substituicao — sem isso o '
  'cruzamento texto x banco fica cego, que e o erro documentado em '
  'docs/VAZAMENTO-USED-TOOLS.md.';

-- Indice parcial: as consultas de frequencia procuram o que TEM veredito, e as
-- barradas sao raras. Mesmo desenho do indice de `saida_cortes`.
create index if not exists idx_mensagens_log_portao
  on public.mensagens_log (tenant_id, criado_em)
  where portao is not null;

-- ---------------------------------------------------------------------
-- 2. O estado do pedido, para o no de saida
-- ---------------------------------------------------------------------
create or replace function public.api_n8n_estado_pedido(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_perfil          text default 'vendas'
)
returns table (
  tem_rascunho          boolean,
  pedido_id             uuid,
  total_centavos        integer,
  itens                 jsonb,
  escreveu_neste_turno  boolean,
  barrou_anterior       boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_pedido        uuid;
  v_total         integer;
  v_mutacao       timestamptz;
  v_ultima_saida  timestamptz;
  v_itens         jsonb;
  v_barrou        boolean;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  -- Perfil que nao vende nao tem pedido: sai sem tocar em `pedidos`. E a
  -- economia do caminho unico, feita aqui e nao por IF de topologia.
  if coalesce(p_perfil, '') <> 'vendas' then
    return query select false, null::uuid, 0, '[]'::jsonb, false, false;
    return;
  end if;

  -- SEMPRE o rascunho. Pedido fechado e passado: ele ja teve o bloco dele
  -- quando fechou, e comparar o texto de agora contra um pedido encerrado
  -- produziria divergencia que nao e defeito.
  --
  -- Filtro explicito de tenant_id, e nao so RLS (regra 6). `limit 1` porque a
  -- migracao 55 deixou o indice unico valer so em `rascunho`: ha no maximo um.
  select p.id, p.total_centavos
    into v_pedido, v_total
    from public.pedidos p
   where p.tenant_id = p_tenant_id
     and p.conversation_id = p_conversation_id
     and p.status = 'rascunho'
     and p.deletado_em is null
   limit 1;

  if v_pedido is null then
    -- Sem rascunho ainda pode haver "barrou_anterior": a conversa pode ter sido
    -- barrada por regra 1 (afirmou sem escrever) justamente por nao ter pedido.
    select coalesce((m.portao ->> 'veredito') like 'barrado%', false)
      into v_barrou
      from public.mensagens_log m
     where m.tenant_id = p_tenant_id
       and m.conversation_id = p_conversation_id
       and m.direcao = 'saida'
     order by m.criado_em desc
     limit 1;

    return query select false, null::uuid, 0, '[]'::jsonb, false, coalesce(v_barrou, false);
    return;
  end if;

  -- Ultima mutacao do pedido. `greatest` com os itens nao e redundancia
  -- defensiva a toa: hoje `pedidos_recalcula_total` faz `update public.pedidos`
  -- a cada insert/update/delete de item, e `trg_pedidos_upd` carimba
  -- `atualizado_em` — entao `p.atualizado_em` JA cobre item. O `greatest`
  -- mantem a leitura certa se um dia esse encadeamento mudar, e custa nada.
  select greatest(
           p.atualizado_em,
           coalesce((select max(i.atualizado_em)
                       from public.pedido_itens i
                      where i.pedido_id = p.id
                        and i.tenant_id = p_tenant_id), p.atualizado_em)
         )
    into v_mutacao
    from public.pedidos p
   where p.id = v_pedido
     and p.tenant_id = p_tenant_id;

  -- O instante de referencia: a saida mais recente JA registrada. `Registra
  -- Mensagem` roda depois do portao, entao esta e a do turno anterior.
  select max(m.criado_em)
    into v_ultima_saida
    from public.mensagens_log m
   where m.tenant_id = p_tenant_id
     and m.conversation_id = p_conversation_id
     and m.direcao = 'saida';

  -- Itens em CENTAVOS. `nome_snapshot` e o nome congelado no momento da venda e
  -- nao e recalculado aqui de proposito.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'nome',                   i.nome_snapshot,
             'quantidade',             i.quantidade,
             'preco_unit_centavos',    i.preco_unit_centavos,
             'subtotal_centavos',      (i.preco_unit_centavos::bigint * i.quantidade)::integer
           ) order by i.criado_em
         ), '[]'::jsonb)
    into v_itens
    from public.pedido_itens i
   where i.pedido_id = v_pedido
     and i.tenant_id = p_tenant_id;

  select coalesce((m.portao ->> 'veredito') like 'barrado%', false)
    into v_barrou
    from public.mensagens_log m
   where m.tenant_id = p_tenant_id
     and m.conversation_id = p_conversation_id
     and m.direcao = 'saida'
   order by m.criado_em desc
   limit 1;

  return query
    select true,
           v_pedido,
           coalesce(v_total, 0),
           v_itens,
           v_mutacao > coalesce(v_ultima_saida, '-infinity'::timestamptz),
           coalesce(v_barrou, false);
end;
$function$;

-- ---------------------------------------------------------------------
-- 3. `api_n8n_registrar_mensagem` extrai a chave nova
-- ---------------------------------------------------------------------
-- MESMA ASSINATURA, `create or replace`. O corpo abaixo e o corpo em producao
-- com DUAS mudancas, marcadas com `-- 56:`. Nada mais foi tocado.
create or replace function public.api_n8n_registrar_mensagem(
  p_tenant_id uuid,
  p_conversation_id bigint,
  p_direcao text,
  p_conteudo text default null::text,
  p_tokens_entrada integer default null::integer,
  p_tokens_saida integer default null::integer,
  p_modelo text default null::text,
  p_audio_segundos numeric default null::numeric,
  p_execucao_id text default null::text,
  p_componentes jsonb default null::jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
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
     saida_cortes, portao)
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
     v_cortes, v_portao)
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

-- ---------------------------------------------------------------------
-- 4. REVOKE antes do grant, e depois os DOIS roles
-- ---------------------------------------------------------------------
-- O `revoke` nao e redundancia. `ALTER DEFAULT PRIVILEGES` deste projeto concede
-- EXECUTE a PUBLIC, `anon` e `authenticated` no instante do `create` — entao sem
-- ele o `grant` e decoracao sobre um objeto que ja nasceu aberto. Medido na 54.
--
-- `api_n8n_registrar_mensagem` NAO aparece aqui de proposito: ela nao foi
-- dropada, entao os grants dela seguem intactos. Tocar neles seria arriscar o
-- estrago das migracoes 40 e 41 sem necessidade nenhuma.
revoke all on function public.api_n8n_estado_pedido(uuid, bigint, text) from public;
revoke all on function public.api_n8n_estado_pedido(uuid, bigint, text) from anon;
revoke all on function public.api_n8n_estado_pedido(uuid, bigint, text) from authenticated;

-- `service_role` e o role do PostgREST/supabase-js. `n8n_agent` e o role com que
-- o n8n CONECTA — e a linha que faltou na 40 e na 41, derrubando o catalogo do
-- emporio. `npm run teste:grants-n8n` varre `api_n8n_*` por padrao, entao esta
-- entra sozinha na varredura.
grant execute on function public.api_n8n_estado_pedido(uuid, bigint, text) to service_role;
grant execute on function public.api_n8n_estado_pedido(uuid, bigint, text) to n8n_agent;

commit;
