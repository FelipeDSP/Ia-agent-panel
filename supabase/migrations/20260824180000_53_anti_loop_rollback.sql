-- =====================================================================
-- ROLLBACK da 53 — protecao anti-loop
-- =====================================================================
--
-- ORDEM IMPORTA, e o inverso da aplicacao. Em particular: derrube o no
-- `Consulta Pausa` de volta para `api_n8n_conversa_pausada` no n8n **ANTES** de
-- rodar isto, senao toda mensagem de todo tenant estoura `42883` — a funcao
-- some e o portao e a primeira coisa que roda depois do `Tenant Valido?`.
--
-- O QUE ESTE ROLLBACK DESFAZ:
--   - a funcao do portao e a normalizacao;
--   - o tratamento de `anomalia` em `pausa_vigente`;
--   - a constraint volta a aceitar so `manual` e `mensagem_humana`;
--   - as colunas de teto e a tabela de alertas.
--
-- O QUE ELE **NAO** DESFAZ, E EXIGE UM PASSO MANUAL ANTES:
--
-- As conversas que ja foram pausadas com `motivo_pausa = 'anomalia'`. A
-- constraint volta mais estrita, e `ALTER TABLE ... ADD CONSTRAINT` valida as
-- linhas existentes: se houver UMA conversa em `anomalia`, este rollback FALHA
-- com `23514` — e falhar e melhor do que passar, porque a alternativa seria
-- reescrever silenciosamente a pausa de uma conversa que alguem precisa olhar.
--
-- Antes de rodar, decida o que fazer com elas e faca explicitamente:
--
--   select conversation_id, contact_name from public.conversas
--    where motivo_pausa = 'anomalia';
--
--   -- e entao, para cada uma, uma das duas:
--   update public.conversas set motivo_pausa = 'manual' where ...;  -- segue pausada
--   update public.conversas set status = 'ativo', motivo_pausa = null where ...;  -- solta
--
-- A segunda opcao devolve o agente ao laco, se o laco ainda existir.
--
-- E `contato_exibivel` NAO sai aqui: ela e da 52, e a 52 ainda estara aplicada.
-- =====================================================================

begin;

drop function if exists public.api_n8n_portao_mensagem(uuid, bigint);

-- `pausa_vigente` volta ao corpo da 47 (so `manual` nao caduca). Mesma
-- assinatura, entao `create or replace` — sem drop, e a view `conversas_painel`
-- continua de pe.
create or replace function public.pausa_vigente(
  p_status          text,
  p_pausado_em      timestamptz,
  p_motivo_pausa    text,
  p_janela_minutos  integer
)
returns boolean
language sql
stable
set search_path to 'public', 'extensions'
as $$
  select case
    when p_status is distinct from 'pausado' then false
    when p_motivo_pausa = 'manual'           then true
    when p_pausado_em is null                then false
    when p_janela_minutos is null            then false
    else p_pausado_em > now() - make_interval(mins => p_janela_minutos)
  end;
$$;

alter table public.conversas drop constraint if exists conversas_motivo_pausa_check;
alter table public.conversas add constraint conversas_motivo_pausa_check
  check (motivo_pausa is null or motivo_pausa in ('manual', 'mensagem_humana'));

drop function if exists public.texto_normalizado(text);

-- A tabela sai com o historico de alertas junto. E aceitavel: alerta de teto e
-- sinal operacional, nao registro contabil — o dado de origem continua inteiro
-- em `mensagens_log`, e a soma pode ser refeita a qualquer momento.
drop table if exists public.alertas_consumo;

alter table public.tenants drop column if exists teto_aviso_tokens_dia;
alter table public.tenants drop column if exists teto_corte_tokens_dia;

commit;
