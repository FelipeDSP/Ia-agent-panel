-- Migracao 31 — `tipo` em catalogo_tools, e a linha de transcricao de audio
--
-- POR QUE A COLUNA. As quatro linhas de hoje sao TOOLS DO MODELO: o agente as
-- chama, e `descricao_padrao` e literalmente o texto que descreve a tool para o
-- LLM. Transcricao de audio nao e isso — e uma ETAPA DO FLUXO, que roda antes
-- do modelo existir na conversa. Enfiar as duas coisas na mesma tabela sem
-- distinguir faz `descricao_padrao` nao significar nada em metade das linhas, e
-- o painel listar "ferramentas do agente" que o agente nunca vai chamar.
--
-- A alternativa era manter a distincao so no `src/lib/tools/registro.ts`. Isso
-- cria duas verdades sobre a mesma coisa, e a que fica no codigo do painel nao
-- alcanca o n8n.
--
-- O QUE NAO MUDA. `api_n8n_tools_ativas` continua devolvendo as duas familias —
-- e o que o fluxo quer, porque ele precisa saber tanto quais tools anexar quanto
-- quais capacidades estao ligadas. O `Vende?` so olha `vendas`. Nenhum consumidor
-- existente le `tipo`, entao a coluna e aditiva de verdade.
--
-- ROLLBACK: 20260812180000_31_catalogo_tools_tipo_rollback.sql

begin;

alter table public.catalogo_tools
  add column if not exists tipo text not null default 'tool_modelo';

alter table public.catalogo_tools
  drop constraint if exists catalogo_tools_tipo_check;

alter table public.catalogo_tools
  add constraint catalogo_tools_tipo_check
  check (tipo in ('tool_modelo', 'capacidade_fluxo'));

comment on column public.catalogo_tools.tipo is
  'tool_modelo = o agente chama como ferramenta; capacidade_fluxo = etapa do fluxo n8n, o modelo nao a invoca. Ver docs/ADICIONAR-TOOL.md.';

-- As quatro existentes sao tools do modelo — o default ja as cobre, mas deixar
-- explicito evita que uma leitura futura confunda default com "nao classificado".
update public.catalogo_tools
   set tipo = 'tool_modelo'
 where tool_nome in ('busca_conhecimento', 'resolver_conversa', 'transferir_humano', 'vendas');

-- A capacidade nova. `descricao_padrao` descreve para o OPERADOR, nao para o
-- modelo: nao ha tool para o modelo enxergar.
insert into public.catalogo_tools (tool_nome, nome_exibicao, descricao_padrao, tipo, ativo)
values (
  'transcricao_audio',
  'Transcrever audio',
  'Nota de voz do cliente vira texto antes de chegar ao modelo. O audio e enviado para a OpenAI — ver docs/LGPD-TRANSCRICAO-AUDIO.md antes de contratar para um cliente.',
  'capacidade_fluxo',
  true
)
on conflict (tool_nome) do update
   set nome_exibicao    = excluded.nome_exibicao,
       descricao_padrao = excluded.descricao_padrao,
       tipo             = excluded.tipo;

commit;
