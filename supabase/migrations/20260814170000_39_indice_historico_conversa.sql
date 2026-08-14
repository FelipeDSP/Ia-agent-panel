-- Migracao 39 — indice do historico de conversa
--
-- RENUMERADA DE 18 PARA 39 EM 14/08/2026. Havia DOIS arquivos com o numero 18
-- (este e `18_seguranca_tenant_tools`, que ja estava aplicado), e "migracao 18"
-- virou ambigua num repo onde comentarios citam migracao por numero. Este era o
-- pendente, entao foi ele que mudou. O timestamp acompanhou o numero para bater
-- com a versao gravada no ledger na aplicacao real, como manda o CLAUDE.md.
--
-- conversa_historico() (migracao 15) e o unico caminho pelo qual o tenant le o
-- historico de uma conversa — a tabela mensagens_log foi fechada para ele
-- porque tem tokens, que sao a base de custo da agencia. A funcao filtra assim:
--
--   where m.tenant_id = auth_tenant_id() and m.conversation_id = p_conversation_id
--   order by m.criado_em asc
--
-- E o unico indice da tabela e idx_log_tenant_data (tenant_id, criado_em desc),
-- que nao tem conversation_id. Resultado: abrir UMA conversa no painel percorre
-- todas as mensagens do tenant e descarta as que nao sao dela.
--
-- Quando este arquivo foi escrito a tabela tinha 8 linhas, porque o n8n ainda
-- nao chamava api_n8n_registrar_mensagem em producao. Na aplicacao real, em
-- 14/08/2026, tinha 72 — ainda instantaneo, e ja com o log sendo gravado a cada
-- mensagem desde a migracao 37. A urgencia so aumentou: quando o log comecar a ser gravado de
-- verdade, cada cliente acumula milhares de mensagens e a tela de conversa passa
-- a varrer todas elas. Criar o indice com a tabela vazia e instantaneo; criar
-- depois, com carga, e uma janela de manutencao.
--
-- Ordem das colunas: tenant_id primeiro (regra 3 do CLAUDE.md — prefixo mais a
-- esquerda), conversation_id em seguida porque tambem e igualdade, e criado_em
-- por ultimo para o ORDER BY sair do proprio indice, sem sort.
--
-- ASC e nao DESC: a funcao ordena ascendente (a conversa e lida de cima para
-- baixo, como um chat). Um indice DESC serviria, mas com scan para tras.
--
-- idx_log_tenant_data continua: ele serve billing_consumo_mensal e qualquer
-- consulta por periodo. Os dois nao competem.
--
-- NAO e destrutivo: so cria indice. Nenhuma linha e tocada, nenhum comportamento
-- muda — so o plano de execucao.
--
-- NOTA sobre CONCURRENTLY: este arquivo usa CREATE INDEX simples porque o
-- Supabase CLI roda migracao dentro de transacao, e CONCURRENTLY nao pode. Com
-- 8 linhas o lock e instantaneo. Se por algum motivo esta migracao so for
-- aplicada depois de mensagens_log crescer (dezenas de milhares de linhas),
-- rode a mao, fora da migracao, e marque como aplicada:
--
--   create index concurrently if not exists idx_log_conversa
--     on public.mensagens_log (tenant_id, conversation_id, criado_em);
--
-- Rollback: 20260814170000_39_indice_historico_conversa_rollback.sql

create index if not exists idx_log_conversa
  on public.mensagens_log (tenant_id, conversation_id, criado_em);

comment on index public.idx_log_conversa is
  'Serve conversa_historico(): igualdade em tenant_id + conversation_id e '
  'ordenacao por criado_em sem sort.';
