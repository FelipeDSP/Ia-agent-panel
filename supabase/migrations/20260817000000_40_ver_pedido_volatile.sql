-- 40_ver_pedido_volatile
--
-- Corrige a volatilidade de `api_n8n_ver_pedido`, que ficou `stable` depois da
-- migracao 38 e ESCREVE.
--
-- O QUE ACONTECEU. A 38 fez a leitura de pedido expirar o pedido vencido, e
-- documentou a consequencia com todas as letras no proprio arquivo:
--
--     "DEIXA DE SER `stable` E VIRA `volatile`. Consequencia real, e nao obvia
--      pelo nome: leitura de pedido agora ESCREVE."
--
-- Ela aplicou isso em `pedido_aberto_da_conversa`, `api_n8n_tem_pedido_pendente`
-- e `api_n8n_adicionar_item`. Passou por `api_n8n_ver_pedido`, que chama
-- `pedido_aberto_da_conversa` igual aos outros. Regra certa, um ponto de chamada
-- esquecido.
--
-- POR QUE PRODUCAO NAO CAIU, e por que ainda assim isto importa. O n8n chama a
-- funcao pelo no Postgres (`executeQuery`, conexao direta), que nao roda em
-- transacao read-only — la ela funciona. Quem quebra e o PostgREST: ele executa
-- funcao `stable`/`immutable` em transacao READ ONLY, e o UPDATE de expiracao
-- estoura `25006 cannot execute UPDATE in a read-only transaction` (HTTP 405).
--
-- Ou seja: hoje o defeito so aparece por supabase-js. Foi assim que apareceu —
-- `tests/isolamento-pedidos.mjs` cobre as duas superficies de proposito, e a
-- assercao que passa pelo PostgREST reprovou. No dia em que o painel (ou uma
-- Edge Function) precisar ler um pedido, quebra sem esta migracao.
--
-- Alem do erro, `stable` e metadado ERRADO: autoriza o planner a reaproveitar o
-- resultado dentro da mesma query, numa funcao cujo efeito colateral e o ponto.
--
-- Assinatura INALTERADA (uuid, bigint) — nao ha risco de ambiguidade de aridade
-- (o caso da 28/32/37). O `drop` explicito pela lista completa de tipos segue o
-- padrao do repo; o `create or replace` depois dele mantem a migracao
-- reexecutavel.
--
-- Rollback: 20260817000000_40_ver_pedido_volatile_rollback.sql

-- ---------------------------------------------------------------------------
-- GRANTS: `drop function` APAGA TODOS OS GRANTS DA FUNCAO
-- ---------------------------------------------------------------------------
--
-- Isto nao e detalhe de estilo, e o defeito que esta migracao ja causou em
-- producao. O `drop` leva o ACL inteiro junto; recriar restaura so o que o
-- script listar. Faltou `n8n_agent` -- que e o role com que o n8n CONECTA -- e a
-- tool morreu com "permission denied for function".
--
-- `service_role` sozinho nao cobre: ele e o role do PostgREST/supabase-js, e o
-- n8n nao passa por ali. As duas linhas sao obrigatorias, e a de n8n_agent e a
-- que o agente usa em toda mensagem.
--
-- `npm run teste:grants-n8n` reprova qualquer api_n8n_* sem grant para
-- n8n_agent, justamente para este esquecimento nao depender de memoria.

drop function if exists public.api_n8n_ver_pedido(uuid, bigint);

create or replace function public.api_n8n_ver_pedido(
  p_tenant_id       uuid,
  p_conversation_id bigint
)
returns text
language plpgsql
-- volatile (o default) e nao `stable`: pedido_aberto_da_conversa expira pedido
-- vencido, isto e, esta leitura escreve.
volatile
security definer
set search_path = public
as $$
declare
  v_pedido uuid;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  v_pedido := public.pedido_aberto_da_conversa(p_tenant_id, p_conversation_id);
  if v_pedido is null then
    return 'Nao ha pedido aberto nesta conversa.';
  end if;

  return public.pedido_em_texto(v_pedido);
end;
$$;

comment on function public.api_n8n_ver_pedido(uuid, bigint) is
  'Texto do pedido aberto da conversa. VOLATILE: a leitura expira pedido vencido '
  '(migracao 38), e marcar como stable quebra a chamada via PostgREST com 25006.';

revoke all on function public.api_n8n_ver_pedido(uuid, bigint) from public;
revoke all on function public.api_n8n_ver_pedido(uuid, bigint) from anon;
revoke all on function public.api_n8n_ver_pedido(uuid, bigint) from authenticated;
grant execute on function public.api_n8n_ver_pedido(uuid, bigint) to service_role;
-- O role com que o n8n CONECTA. Sem esta linha a tool morre com
-- "permission denied for function" no primeiro cliente.
grant execute on function public.api_n8n_ver_pedido(uuid, bigint) to n8n_agent;
