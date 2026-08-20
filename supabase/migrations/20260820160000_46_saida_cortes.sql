-- Migracao 46 — `saida_cortes` em `mensagens_log`
--
-- NAO APLICADA EM PRODUCAO. Ao aplicar fora do CLI, confira a versao gravada em
-- `supabase_migrations.schema_migrations` e renomeie o arquivo para bater com
-- ela (ver CLAUDE.md, secao Migracoes).
--
-- O QUE ELA FAZ. Guarda o que o filtro de saida do `Estima Tokens` cortou da
-- resposta do modelo. Sem esta coluna o conserto do vazamento e cego: a partir
-- do momento em que o filtro entra, `conteudo` passa a guardar o texto ja limpo
-- e a consulta de frequencia de docs/VAZAMENTO-USED-TOOLS.md deixa de enxergar
-- vazamento nenhum. Consertar a aparencia e perder a medida e o pior dos dois
-- mundos: no dia em que voltar, ninguem sabe.
--
-- ===================== POR QUE A ASSINATURA NAO MUDA =======================
--
-- Esta e a primeira mudanca desta familia que NAO toca em
-- `api_n8n_registrar_mensagem(uuid, bigint, text, text, integer, integer, text,
-- numeric, text, jsonb)`. Nao e sorte: a migracao 42 criou o `p_componentes
-- jsonb` como TRANSPORTE EXTENSIVEL exatamente para isso, escrito la com todas
-- as letras — "componente novo depois vira coluna + uma linha no insert, sem
-- tocar em assinatura, sem tocar no n8n alem do objeto que o no Code ja monta".
--
-- O que se ganha por nao mudar a assinatura, item por item:
--
--   - nao ha `drop function`, entao nao ha aridade ambigua (28, 32, 37);
--   - nao ha `drop function`, entao NENHUM grant e apagado e nao ha nada para
--     reconceder (40, 41). O ACL de hoje — postgres, service_role, n8n_agent —
--     atravessa esta migracao intacto, e o teste confere isso em vez de confiar;
--   - o `create or replace` de mesma aridade e reexecutavel, entao a migracao
--     roda duas vezes sem quebrar.
--
-- ORDEM DE IMPLANTACAO: NAO IMPORTA. Se o no do n8n subir antes desta migracao,
-- a funcao ignora a chave `saida_cortes` que nao conhece. Se esta migracao subir
-- antes do no, a coluna fica nula ate o no subir. Nao existe janela de quebra.
--
-- ===================== A FUNCAO NAO ESTOURA POR DIAGNOSTICO ================
--
-- Mesma regra da 42, e pelo mesmo motivo: TODA mensagem de TODO cliente passa
-- por aqui. `jsonb_array_length` levanta `22023` se o valor nao for array, entao
-- a extracao e guardada por `jsonb_typeof`. Chave ausente, `null` JSON, array
-- vazio ou tipo errado caem todos em NULL — que e a leitura certa: "nada foi
-- cortado". Derrubar o log de uma conversa real por causa de um campo de
-- diagnostico mal formado seria trocar um problema de contabilidade por um de
-- atendimento.

begin;

-- ---------------------------------------------------------------------------
-- 1. A coluna. Nullable de proposito: NULL = nada foi cortado nesta mensagem,
--    que e o caso de 98,8% das saidas medidas em 2026-08-20 (2 em 165).
-- ---------------------------------------------------------------------------
alter table public.mensagens_log
  add column if not exists saida_cortes jsonb;

comment on column public.mensagens_log.saida_cortes is
  'Pedacos que o filtro de saida do Estima Tokens removeu da resposta do modelo '
  '(bloco fabricado `[Used tools: ...]` e cabecalho `[Trecho N | relevancia ...]`). '
  'NULL = nada cortado. Ver docs/VAZAMENTO-USED-TOOLS.md.';

-- ---------------------------------------------------------------------------
-- 2. Indice parcial, espelhando `idx_mensagens_log_audio`, que resolve o mesmo
--    formato de pergunta. `tenant_id` primeiro pela regra do prefixo mais a
--    esquerda; `criado_em` porque a pergunta real e sempre "quantos neste mes".
--    Parcial porque a esmagadora maioria das linhas nao tem corte nenhum.
-- ---------------------------------------------------------------------------
create index if not exists idx_mensagens_log_saida_cortes
  on public.mensagens_log (tenant_id, criado_em)
  where saida_cortes is not null;

-- ---------------------------------------------------------------------------
-- 3. A funcao. MESMA assinatura, MESMO corpo, mais uma coluna no insert.
--    Sem `drop function` — ver o cabecalho.
-- ---------------------------------------------------------------------------
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
  p_componentes     jsonb   default null
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_id uuid;
  v_cortes jsonb;
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
  -- justamente para um turno contar UMA vez. Vale igual para `saida_cortes`.
  insert into public.mensagens_log
    (tenant_id, conversation_id, direcao, conteudo, tokens_entrada, tokens_saida,
     modelo, audio_segundos, execucao_id,
     tokens_wrapper, tokens_system_prompt, tokens_schema_tools,
     tokens_mensagens, tokens_memoria, tokens_round_trip, chamadas, fonte_tokens,
     saida_cortes)
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
     v_cortes)
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

-- Sem `drop function` acima, o ACL nunca foi apagado e nao ha nada para
-- reconceder. As duas linhas ficam aqui mesmo assim, e sao inofensivas por
-- serem idempotentes: se um dia alguem acrescentar um `drop` a esta migracao,
-- elas evitam que a 46 vire a sexta da familia. `n8n_agent` e o role pelo qual
-- o agente conecta — nao e `service_role`, e era essa a linha que faltava na 40
-- e na 41.
grant execute on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb
) to service_role;
grant execute on function public.api_n8n_registrar_mensagem(
  uuid, bigint, text, text, integer, integer, text, numeric, text, jsonb
) to n8n_agent;

commit;
