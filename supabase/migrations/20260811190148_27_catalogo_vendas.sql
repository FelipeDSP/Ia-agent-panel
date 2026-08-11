-- 27_catalogo_vendas
--
-- Registra o modulo de vendas no catalogo global. Sem isto, o
-- `api_n8n_config_tool(tenant_id, 'vendas')` que os sub-workflows chamam devolve
-- `tool_ativa = false` por AUSENCIA de linha — indistinguivel de "tool
-- desligada". A trava funcionaria pelo motivo errado, e testa-la assim nao
-- provaria nada.
--
-- UMA LINHA SO, `vendas`. O cliente contrata "Vendas", nao "adicionar item":
-- os tres sub-workflows (consultar_catalogo, gerenciar_pedido, finalizar_pedido)
-- checam todos o MESMO tool_nome. A granularidade do n8n e detalhe de execucao;
-- a do catalogo e comercial.
--
-- NAO ENTRA EM TOOLS_BASELINE (src/lib/tools/registro.ts). Vendas e modulo
-- vendido, nao baseline: `criarTenant` nao provisiona, e nenhum cliente
-- existente passa a ter por efeito colateral desta migracao. Quem contrata e a
-- agencia, pela tela de Modulos.
--
-- workflow_id_padrao fica NULL: o principal e hardcoded e nao le esta coluna
-- (ver o "endgame" em docs/ADICIONAR-TOOL.md). Preencher daria a impressao de
-- que liga alguma coisa.
--
-- Rollback: 20260811190148_27_catalogo_vendas_rollback.sql

begin;

insert into public.catalogo_tools (tool_nome, nome_exibicao, descricao_padrao, workflow_id_padrao, schema_config, ativo)
values (
  'vendas',
  'Vendas pelo agente',
  'O agente consulta o catalogo, monta o pedido com o cliente na conversa e fecha. '
  'Preco e total sempre resolvidos pelo servidor a partir do catalogo, nunca informados pelo modelo.',
  null,
  '{}'::jsonb,
  true
)
on conflict (tool_nome) do update
  set nome_exibicao    = excluded.nome_exibicao,
      descricao_padrao = excluded.descricao_padrao,
      ativo            = excluded.ativo;

commit;
