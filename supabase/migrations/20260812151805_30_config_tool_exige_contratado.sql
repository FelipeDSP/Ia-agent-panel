-- Migracao 30 — api_n8n_config_tool passa a exigir `contratado`
--
-- O FURO. Duas funcoes respondem a mesma pergunta -- "esta tool vale para este
-- tenant?" -- e discordavam desde a fatia 2:
--
--   api_n8n_tools_ativas   ->  and t.contratado and t.ativo      (certo)
--   api_n8n_config_tool    ->  COALESCE(tt.ativo, FALSE)         (ignora contratado)
--
-- `api_n8n_tools_ativas` alimenta o roteamento por perfil no workflow principal.
-- `api_n8n_config_tool` alimenta a trava `Vendas Ativa?` DENTRO de cada
-- sub-workflow de tool -- a segunda camada de defesa, a que existe justamente
-- para o caso de a primeira falhar.
--
-- Com `contratado = false, ativo = true` a primeira camada recusava e a segunda
-- liberava. Ou seja: a defesa em duas camadas era uma camada com uma copia
-- decorativa. Verificado em producao em 12/08/2026 no restaurante-teste, que
-- estava exatamente nesse estado.
--
-- Nao chegou a causar dano porque o roteamento nao anexou as tools de venda ao
-- agente, entao o sub-workflow nunca foi chamado. Mas qualquer caminho que
-- alcance o sub-workflow direto -- execucao manual, um workflow futuro, um erro
-- de fiacao -- passava pela trava.
--
-- ESCOPO. `n8n_assert_tenant`, chamada no inicio das duas funcoes, ja valida
-- `t.ativo and t.deletado_em is null`. A varredura das 35 funcoes do schema nao
-- achou nenhuma outra divergencia da mesma familia.
--
-- IMPACTO MEDIDO antes de aplicar: exatamente UMA linha muda de comportamento,
-- `restaurante-teste / vendas`, que e o caso que motivou a correcao. As outras
-- 14 linhas de tenant_tools tem `contratado = true` e nao sentem nada. A Acqua
-- nao e afetada.
--
-- ROLLBACK: 20260812151805_30_config_tool_exige_contratado_rollback.sql

begin;

-- Corpo identico ao que estava em producao, com UMA mudanca: a condicao de
-- `tool_ativa`. Preservados de proposito: a assinatura, o RETURNS TABLE, o
-- STABLE SECURITY DEFINER, o `search_path` e a chamada a n8n_assert_tenant --
-- trocar qualquer um deles aqui seria mudanca de comportamento nao pedida.
create or replace function public.api_n8n_config_tool(p_tenant_id uuid, p_tool_nome text)
returns table(chatwoot_url text, chatwoot_token text, tool_ativa boolean, config jsonb)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  return query
  select t.chatwoot_url,
         c.chatwoot_token,
         -- `contratado` e o corte da AGENCIA (o cliente comprou o modulo);
         -- `ativo` e o corte do CLIENTE (ele ligou o modulo no painel). A tool
         -- so vale com os dois. Tem que bater com api_n8n_tools_ativas -- e
         -- `npm run teste:trava-vendas` falha se voltarem a divergir.
         coalesce(tt.ativo and tt.contratado, false),
         coalesce(tt.config, '{}'::jsonb)
  from public.tenants t
  left join public.tenant_credenciais c
         on c.tenant_id = t.id
  left join public.tenant_tools tt
         on tt.tenant_id = t.id and tt.tool_nome = p_tool_nome
  where t.id = p_tenant_id;
end;
$function$;

commit;
