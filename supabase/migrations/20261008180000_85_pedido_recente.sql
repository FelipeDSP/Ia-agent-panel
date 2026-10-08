-- =============================================================================
-- 85 — O PEDIDO FECHADO QUE O PORTÃO NÃO ENXERGA
-- =============================================================================
--
-- 07/10, conversa 56 do Empório. A Thaís fechou 6 pães de queijo, R$ 9,00.
-- Vinte segundos depois escreveu "Buscar agora". O modelo respondeu certo:
--
--   "Thaís, seu pedido já está separado e confirmado para retirada hoje às
--    17h30. Você paga na retirada, no balcão."
--
-- E o portão barrou (`barrado_regra_1`) e trocou por:
--
--   "Deixa eu confirmar uma coisa antes de seguir 😊 Ainda não tenho nenhum
--    item anotado no seu pedido aqui."
--
-- POR QUÊ. `api_n8n_estado_pedido` enxerga o pedido TOCADO NO TURNO: a borda
-- da janela é a última saída registrada. A linha do pedido mudou às 21:26:43
-- e a mensagem de confirmação foi gravada às 21:26:50 — 7,2 s DEPOIS. No turno
-- seguinte o pedido está mais velho que a borda e some. Reproduzido com a
-- função, em produção, com o pedido #7 vivo no banco:
--
--   pedido #7 aguardando_pagamento R$ 9,00
--   api_n8n_estado_pedido -> tem_pedido = false, total = 0
--
-- A função está certa: a janela existe para a regra 1 saber o que ESTE turno
-- escreveu. O que falta é outra pergunta, que ninguém fazia: "existe um pedido
-- fechado nesta conversa, mesmo que não tenha sido tocado agora?"
--
-- POR QUE FUNÇÃO NOVA, e não uma coluna em `api_n8n_estado_pedido`.
-- Ela é `RETURNS TABLE`; acrescentar coluna exige `drop function` + `create`,
-- e entre a migração e o deploy do serviço a chamada viva quebraria. A regra
-- do projeto é a de sempre: comportamento novo entra por função NOVA.
--
-- Precedente de forma: o próprio `pagamento_confirmado` do estado já olha 24 h
-- para trás para dizer que uma frase sobre pagamento é VERDADE. Esta é a
-- mesma ideia para o pedido fechado.
--
-- ROLLBACK: ao final do arquivo. É `drop function` puro — a função é nova e
-- nada mais depende dela; o serviço que ainda não subiu nunca a chama.
-- =============================================================================

-- ---- a função --------------------------------------------------------------
-- `or replace` depois do drop para a migração ser reexecutável (o teste aplica
-- em transação abortada). O drop é pela LISTA COMPLETA DE TIPOS, nunca pelo
-- nome: com várias assinaturas vivas, dropar pelo nome erra ou derruba a errada.
drop function if exists public.api_agente_pedido_recente(uuid, bigint, integer);

create or replace function public.api_agente_pedido_recente(
  p_tenant_id       uuid,
  p_conversation_id bigint,
  p_horas           integer default 24
)
returns table(
  existe         boolean,
  pedido_id      uuid,
  numero         integer,
  status         text,
  total_centavos integer,
  atualizado_em  timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  -- RASCUNHO NÃO ENTRA, de propósito: carrinho em montagem é exatamente o que
  -- `api_n8n_estado_pedido` já cobre, e trazê-lo aqui afrouxaria a regra 1 no
  -- caso que ela existe para pegar (modelo diz "anotei" sem ter anotado).
  --
  -- CANCELADO e EXPIRADO também não: o pedido não existe mais para o cliente,
  -- e dizer "seu pedido está confirmado" sobre um cancelado é fabricação de
  -- novo, só que com outro sinal.
  select true,
         p.id,
         p.numero,
         p.status,
         p.total_centavos,
         p.atualizado_em
    from public.pedidos p
   where p.tenant_id       = p_tenant_id
     and p.conversation_id = p_conversation_id
     and p.deletado_em is null
     and p.status in ('aguardando_pagamento', 'pago')
     and p.atualizado_em > now() - make_interval(hours => greatest(coalesce(p_horas, 24), 1))
   order by p.atualizado_em desc
   limit 1;
$$;

comment on function public.api_agente_pedido_recente(uuid, bigint, integer) is
  '85: o último pedido FECHADO (aguardando_pagamento|pago) da conversa dentro da janela de horas. '
  'Zero linhas = não há. Serve ao portão para distinguir "o modelo inventou um pedido" de '
  '"o modelo está falando de um pedido que existe e não foi tocado neste turno" (conversa 56 do Empório, 07/10).';

-- ---- grants ----------------------------------------------------------------
-- O `revoke` vem ANTES e não é redundância: `ALTER DEFAULT PRIVILEGES` deste
-- projeto dá EXECUTE a PUBLIC, `anon` e `authenticated` no instante do create.
-- Sem o revoke, o grant é decoração sobre um objeto que já nasceu aberto — e
-- uma SECURITY DEFINER aberta à chave publicável do navegador foi o que a 43
-- teve de ir catar depois.
revoke all on function public.api_agente_pedido_recente(uuid, bigint, integer) from public;
revoke all on function public.api_agente_pedido_recente(uuid, bigint, integer) from anon;
revoke all on function public.api_agente_pedido_recente(uuid, bigint, integer) from authenticated;

-- DUAS linhas, não uma. `service_role` é o role do PostgREST/supabase-js; o
-- serviço NÃO passa por ali — ele conecta como `agente_codigo`, membro de
-- `n8n_agent`. As migrações 40 e 41 saíram só com a primeira e derrubaram o
-- catálogo do Empório na hora.
grant execute on function public.api_agente_pedido_recente(uuid, bigint, integer) to service_role;
grant execute on function public.api_agente_pedido_recente(uuid, bigint, integer) to n8n_agent;

-- =============================================================================
-- ROLLBACK (rodar à mão, na ordem inversa)
-- =============================================================================
-- drop function if exists public.api_agente_pedido_recente(uuid, bigint, integer);
-- =============================================================================
