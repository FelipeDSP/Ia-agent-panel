-- Migracao 35 — trava e registro do envio de foto pelo agente
--
-- POR QUE UMA TABELA, e nao uma chave no Redis. O Redis daria o teto com um TTL
-- e uma linha de codigo. Mas o Felipe pediu as DUAS coisas: teto e evidencia —
-- "a regra reduz a frequencia; a trava define o teto" —, e evidencia que some
-- com o TTL nao serve para decidir se a janela esta certa. A tabela da as duas,
-- e a janela vira numero calibravel em vez de chute permanente.
--
-- REGISTRA SEMPRE, permitido ou recusado. Uma tabela que so guarda o que passou
-- responde "quantas fotos foram enviadas" mas nao responde "quantas vezes o
-- modelo TENTOU mandar cinco" — que e a pergunta que decide se a regra de prompt
-- esta funcionando. Recusa registrada e o unico jeito de saber que a trava esta
-- trabalhando.
--
-- A JANELA e por conversa, nao por tenant: dois clientes diferentes pedindo foto
-- ao mesmo tempo nao tem nada a ver um com o outro.
--
-- SO ENVIO PERMITIDO CONTA para a janela. Se recusa tambem contasse, um burst de
-- cinco tentativas empurraria a janela para frente a cada tentativa e o
-- follow-up legitimo do cliente ("sim, manda a outra") nunca passaria.
--
-- Rollback: 20260812210742_35_foto_enviada_rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. A tabela
-- ---------------------------------------------------------------------------

create table if not exists public.fotos_enviadas (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  conversation_id bigint not null,
  produto_id      uuid,
  permitido       boolean not null,
  -- Por que recusou. Nulo quando permitido. Os valores sao fechados de
  -- proposito: relatorio de "por que a trava barrou" so serve se os motivos
  -- forem contaveis.
  motivo          text,
  criado_em       timestamptz not null default now(),

  constraint fotos_enviadas_motivo_valido check (
    (permitido and motivo is null)
    or (not permitido and motivo in ('nao_contratado', 'sem_foto', 'janela', 'produto_invalido'))
  )
);

comment on table public.fotos_enviadas is
  'Registro de TODA tentativa de envio de foto pelo agente, permitida ou recusada. A recusa e o dado que diz se a trava esta trabalhando; sem ela so se sabe o que passou.';

-- `tenant_id` primeiro, como manda a regra 3 do CLAUDE.md. A consulta real da
-- janela e "deste tenant, nesta conversa, nos ultimos N segundos" — o indice
-- serve a ela e tambem a "tudo deste tenant por data".
create index if not exists idx_fotos_enviadas_janela
  on public.fotos_enviadas (tenant_id, conversation_id, criado_em desc);

alter table public.fotos_enviadas enable row level security;

-- Tabela com tenant_id sai da migracao COM policy — regra 2. O cliente le o
-- proprio historico; ninguem escreve por aqui, porque a escrita e da funcao
-- SECURITY DEFINER que o n8n chama.
drop policy if exists fotos_enviadas_select on public.fotos_enviadas;
create policy fotos_enviadas_select on public.fotos_enviadas
  for select to authenticated
  using (tenant_id = public.auth_tenant_id());

-- ---------------------------------------------------------------------------
-- 2. A funcao que o sub-workflow chama
-- ---------------------------------------------------------------------------
--
-- Devolve tudo o que o ramo precisa numa linha: se pode, por que nao, e — quando
-- pode — os dados do produto e a credencial do Chatwoot. Mesmo desenho do
-- `api_n8n_pode_transcrever`: uma pergunta, uma query, um round-trip.
--
-- VOLATILE (o default), nao STABLE: ela ESCREVE em fotos_enviadas em todos os
-- caminhos. Declarar STABLE aqui faria o Postgres poder reusar resultado dentro
-- da mesma query — e a trava dependeria de o planner nao otimizar.

create or replace function public.api_n8n_enviar_foto(
  p_tenant_id uuid,
  p_conversation_id bigint,
  p_produto_id uuid
)
returns table(
  permitido boolean,
  motivo text,
  produto_nome text,
  preco_centavos integer,
  foto_path text,
  chatwoot_url text,
  chatwoot_token text,
  janela_segundos integer
)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_ativa      boolean;
  v_janela     integer;
  -- Escalares e nao `record`: com record, o caminho que recusa antes da busca do
  -- produto deixa a variavel NAO ATRIBUIDA, e o `case` do return referencia o
  -- campo mesmo com a condicao falsa — "record v_prod is not assigned yet". Com
  -- escalares, nao atribuido e simplesmente NULL.
  v_nome       text;
  v_preco      integer;
  v_foto       text;
  v_recentes   integer;
  v_motivo     text := null;
  v_permitido  boolean := false;
  v_url        text;
  v_token      text;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  select coalesce(tt.ativo and tt.contratado, false),
         coalesce((tt.config ->> 'janela_foto_segundos')::integer, 30),
         t.chatwoot_url,
         c.chatwoot_token
    into v_ativa, v_janela, v_url, v_token
    from public.tenants t
    left join public.tenant_credenciais c on c.tenant_id = t.id
    left join public.tenant_tools tt
           on tt.tenant_id = t.id and tt.tool_nome = 'foto_produto'
   where t.id = p_tenant_id;

  -- A ordem das recusas nao e arbitraria: da mais barata para a mais cara, e da
  -- mais informativa para a menos. Saber que o modulo nao esta contratado e mais
  -- util do que saber que o produto nao tem foto, quando as duas sao verdade.
  if not v_ativa then
    v_motivo := 'nao_contratado';
  else
    select p.nome, p.preco_centavos, p.foto_path
      into v_nome, v_preco, v_foto
      from public.produtos p
     where p.tenant_id = p_tenant_id
       and p.id = p_produto_id
       and p.deletado_em is null
       and p.disponivel;

    if not found then
      v_motivo := 'produto_invalido';
    elsif v_foto is null then
      v_motivo := 'sem_foto';
    else
      -- SO envio permitido conta para a janela.
      select count(*)::integer into v_recentes
        from public.fotos_enviadas f
       where f.tenant_id = p_tenant_id
         and f.conversation_id = p_conversation_id
         and f.permitido
         and f.criado_em > now() - make_interval(secs => v_janela);

      if v_recentes > 0 then
        v_motivo := 'janela';
      else
        v_permitido := true;
      end if;
    end if;
  end if;

  insert into public.fotos_enviadas (tenant_id, conversation_id, produto_id, permitido, motivo)
  values (p_tenant_id, p_conversation_id, p_produto_id, v_permitido, v_motivo);

  return query
  select v_permitido,
         v_motivo,
         case when v_permitido then v_nome end,
         case when v_permitido then v_preco end,
         case when v_permitido then v_foto end,
         case when v_permitido then v_url end,
         case when v_permitido then v_token end,
         v_janela;
end;
$function$;

comment on function public.api_n8n_enviar_foto(uuid, bigint, uuid) is
  'Decide e REGISTRA cada tentativa de envio de foto. Devolve credencial e dados do produto so quando permite — nao ha caminho em que o n8n receba token sem autorizacao.';

-- ---------------------------------------------------------------------------
-- 3. O modulo no catalogo
-- ---------------------------------------------------------------------------
--
-- `tool_modelo`: o agente CHAMA esta ferramenta, diferente da transcricao de
-- audio, que e etapa do fluxo.
--
-- DEPENDENCIA QUE VALE REGISTRAR: a tool recebe `produto_id`, e o unico jeito de
-- o agente ter um produto_id e o `consultar_catalogo`, que pertence ao modulo
-- `vendas`. Contratar foto_produto sem vendas nao quebra nada — so nao serve
-- para nada, porque o modelo nao tem de onde tirar o id. Se isso virar caso
-- real, o caminho e a tool aceitar nome de produto, com o risco de mandar a foto
-- errada por casamento fuzzy.

insert into public.catalogo_tools (tool_nome, nome_exibicao, descricao_padrao, tipo, ativo)
values (
  'foto_produto',
  'Enviar foto do produto',
  'O agente envia a foto de um item do catalogo quando o cliente pede. Uma foto por vez, com trava de janela para nao virar sequencia de imagens no WhatsApp. Depende do modulo Vendas, de onde vem a identificacao do produto.',
  'tool_modelo',
  true
)
on conflict (tool_nome) do update
   set nome_exibicao    = excluded.nome_exibicao,
       descricao_padrao = excluded.descricao_padrao,
       tipo             = excluded.tipo;

commit;
