-- 29_historico_para_rateio
--
-- Fecha a ultima causa do erro de rateio: o `Estima Tokens` nao enxergava a
-- janela de memoria do Redis, e por isso subestimava a entrada em ~970 tokens
-- por mensagem — desvio que CRESCE com o tamanho da conversa, ou seja, nao
-- uniforme entre tenants. Ver docs/VENDAS-ESTADO.md.
--
-- SEM NO NOVO NO WORKFLOW. `api_n8n_conversa_sync` ja e chamada antes do AI
-- Agent, no momento exato em que o historico e o que a memoria vai carregar.
-- Ela passa a devolver mais uma coluna, e o no que ja existe le junto. Zero
-- query a mais no caminho da resposta — que ja tem tres.
--
-- DEVOLVE A CONTAGEM, NAO O TEXTO. O `Estima Tokens` so precisa do tamanho, e
-- trafegar o conteudo das mensagens colocaria conversa de cliente no log de
-- execucao do n8n, visivel para quem abre a execucao (o token do Chatwoot ja
-- aparece la — ver docs/DIAGNOSTICO-CREDENCIAL-CHATWOOT.md). Contagem resolve
-- sem criar outro problema.
--
-- LIMITE DE 20 espelha o `contextWindowLength` do Redis Chat Memory, que subiu
-- de 5 para 20 na fatia 2. Se um mudar, o outro tem que mudar junto — foi
-- justamente aquela mudanca que alargou o erro do rateio.
--
-- RESSALVA: ate hoje so `direcao = 'saida'` era gravada (`entrada` tinha ZERO
-- linhas). Esta migracao nao conserta o passado — conversa antiga fica com
-- metade do historico. Quem passa a gravar as duas direcoes e a mudanca no no
-- `Registra Mensagem`, entregue junto. Daqui para a frente o numero fecha.
--
-- O CORPO ABAIXO E O DE PRODUCAO com UMA adicao. Preservados de proposito, por
-- terem sido conferidos em pg_get_functiondef antes de escrever:
--   * DEFAULT NULL em p_contact_name e p_phone;
--   * search_path = public, extensions (e nao so public);
--   * a validacao de p_conversation_id nulo;
--   * o INSERT ... ON CONFLICT ... RETURNING direto, sem SELECT extra.
-- O historico e calculado ANTES do insert e entra no RETURNING como constante:
-- subquery dentro de RETURNING seria fragil sem ganho.
--
-- DROP + CREATE porque `create or replace` nao aceita mudanca no RETURNS TABLE.
-- Dentro de transacao: chamada concorrente espera o lock em vez de falhar.
--
-- Rollback: 20260811212357_29_historico_para_rateio_rollback.sql

begin;

drop function if exists public.api_n8n_conversa_sync(uuid, bigint, text, text);

create or replace function public.api_n8n_conversa_sync(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_contact_name    text default null::text,
  p_phone           text default null::text
)
returns table (
  status          text,
  pausado_em      timestamptz,
  historico_chars integer
)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_historico integer;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_conversation_id is null then
    raise exception 'api_n8n: p_conversation_id e obrigatorio' using errcode = '22023';
  end if;

  -- Tamanho do que a janela de memoria vai carregar para o modelo. Calculado
  -- antes do insert: o registro da mensagem atual so acontece depois da
  -- resposta, entao aqui o historico e exatamente o dos turnos anteriores.
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
  returning c.status, c.pausado_em, v_historico;
end;
$function$;

comment on function public.api_n8n_conversa_sync(uuid, bigint, text, text) is
  'Sincroniza a conversa e devolve status, pausa e o TAMANHO do historico '
  'recente (20 mensagens) para o rateio de tokens. Contagem e nao texto: '
  'conteudo de conversa nao deve ir para o log de execucao do n8n.';

revoke all on function public.api_n8n_conversa_sync(uuid, bigint, text, text) from public;
revoke all on function public.api_n8n_conversa_sync(uuid, bigint, text, text) from anon, authenticated;
grant execute on function public.api_n8n_conversa_sync(uuid, bigint, text, text) to n8n_agent;

commit;
