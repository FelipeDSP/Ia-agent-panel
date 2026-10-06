-- =====================================================================
-- Migração 83 — o pedido passa a ter HORA e a ter sido SEPARADO
-- =====================================================================
-- Pedido do Felipe, 06/10/2026: o Empório vai pôr gente para gerir pedidos e
-- precisa saber "o que vai sair". Medido antes de escrever, nos quatro últimos
-- pedidos reais do Empório:
--
--   #5  {"entrega":"retirada pela manhã"}
--   #4  {"entrega":"retirada às 16h"}
--   #3  {"entrega":"retirada","horario":"manhã"}
--   #2  {"entrega":"retirada","observacao":"Retirada às 7h15"}
--
-- Quatro pedidos, QUATRO FORMATOS. `metadados` é jsonb livre por contrato (a
-- tool diz ao modelo "json com observacao geral"), então o modelo inventa a
-- chave a cada vez — já apareceram cinco. Não dá para ordenar, filtrar nem
-- agrupar por isso, e "o que vai sair hoje" é exatamente uma pergunta sobre
-- hora. Qualquer fila construída sobre texto livre quebra na terça de manhã.
--
-- DUAS COLUNAS:
--   `quando_em`   — quando o cliente vai buscar (ou receber). Nulo quando
--                   ninguém combinou: é informação ausente, não zero.
--   `separado_em` — alguém já separou. Com duas ou três pessoas na mesma fila,
--                   é o que impede separarem o mesmo pedido duas vezes.
--
-- COMO `quando_em` CHEGA, e por que não é parâmetro novo de função:
-- `api_n8n_pedido_acao` / `fechar_pedido` são chamadas pelo serviço no ar.
-- Acrescentar parâmetro exigiria `drop function` da assinatura antiga antes do
-- `create or replace` — a armadilha das migrações 28/32/37, em que a chamada
-- com a contagem ANTIGA de argumentos vira ambígua e falha em runtime, no
-- primeiro cliente. Em vez disso o serviço grava `metadados.quando_em` (ISO,
-- já em UTC: ele sabe o fuso do tenant e tem relógio desde 04/10) e um TRIGGER
-- copia para a coluna. Nenhuma assinatura viva muda.
--
-- `separado` entra como AÇÃO NOVA de `painel_marcar_pedido`, cuja assinatura
-- continua `(uuid, text)` — `create or replace` sem `drop`, grants intactos. E
-- ela já exige `auth_pode('marcar_pedido')` desde a 80, então a capacidade
-- vale para a ação nova sem mais nada.
--
-- Rollback: 20261006150000_83_quando_e_separado_rollback.sql
-- =====================================================================

begin;

alter table public.pedidos add column if not exists quando_em   timestamptz;
alter table public.pedidos add column if not exists separado_em timestamptz;

comment on column public.pedidos.quando_em is
  'Quando o cliente vai buscar/receber. Nulo = ninguem combinou. Vem de metadados.quando_em pelo trigger.';
comment on column public.pedidos.separado_em is
  'Quando alguem da equipe separou o pedido. Nulo = ainda nao.';

-- `tenant_id` primeiro: a consulta real é sempre "a fila DESTE cliente, por
-- hora" (regra 3 do CLAUDE.md). Parcial porque a fila nunca olha rascunho,
-- cancelado nem expirado — e assim o índice fica do tamanho do trabalho do
-- dia, não do histórico.
create index if not exists idx_pedidos_fila
  on public.pedidos (tenant_id, quando_em)
  where deletado_em is null and status in ('aguardando_pagamento', 'pago');

/**
 * `metadados.quando_em` -> coluna. O serviço grava o ISO já resolvido em UTC.
 *
 * Texto que não for timestamp NÃO derruba o pedido: fechar uma venda é o
 * caminho quente, e perder a venda porque o modelo escreveu "manhã" no campo
 * errado seria trocar um problema de agenda por um problema de caixa. Fica
 * nulo, e a tela mostra "sem horário" — que é a verdade.
 */
create or replace function public.pedidos_extrai_quando()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_txt text;
begin
  v_txt := nullif(btrim(coalesce(new.metadados, '{}'::jsonb) ->> 'quando_em'), '');
  if v_txt is null then
    return new;
  end if;
  begin
    new.quando_em := v_txt::timestamptz;
  exception when others then
    new.quando_em := null;
  end;
  return new;
end;
$fn$;

drop trigger if exists trg_pedidos_quando on public.pedidos;
create trigger trg_pedidos_quando
  before insert or update of metadados on public.pedidos
  for each row execute function public.pedidos_extrai_quando();

-- Corpo de produção, verbatim, com a ação `separado` acrescentada. Lido de
-- `pg_get_functiondef` — a primeira versão da 80 foi escrita de cabeça e
-- perdeu o `for update`, o `deletado_em` e o encerramento das cobranças.
create or replace function public.painel_marcar_pedido(p_pedido_id uuid, p_acao text)
returns table(ok boolean, motivo text, status text, pago_em timestamptz, retirado_em timestamptz)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_p record;
begin
  if p_acao not in ('pago', 'retirado', 'separado', 'desfazer_separado') then
    return query select false, 'acao_invalida', null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if not public.auth_pode('marcar_pedido') then
    return query select false, 'sem_permissao', null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select p.* into v_p
  from public.pedidos p
  where p.id = p_pedido_id
    and p.deletado_em is null
    and (public.auth_is_super_admin() or p.tenant_id = public.auth_tenant_id())
  for update;

  if v_p.id is null then
    return query select false, 'nao_encontrado', null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if p_acao in ('separado', 'desfazer_separado') then
    -- Só pedido FECHADO entra na fila de separação. Rascunho ainda está sendo
    -- montado na conversa e pode mudar de item; cancelado e expirado não saem.
    if v_p.status not in ('aguardando_pagamento', 'pago') then
      return query select false, 'nao_esta_em_aberto', v_p.status, v_p.pago_em, v_p.retirado_em;
      return;
    end if;
    update public.pedidos p
       set separado_em = case when p_acao = 'separado' then coalesce(p.separado_em, now()) else null end,
           atualizado_em = now()
     where p.id = v_p.id;
    return query
      select true, p_acao, p.status, p.pago_em, p.retirado_em
        from public.pedidos p where p.id = v_p.id;
    return;
  end if;

  if p_acao = 'pago' then
    if v_p.status <> 'aguardando_pagamento' then
      return query select false, 'nao_esta_aguardando', v_p.status, v_p.pago_em, v_p.retirado_em;
      return;
    end if;
    update public.pedidos p
       set status      = 'pago',
           pago_em     = now(),
           -- quem paga na retirada esta retirando: os dois de uma vez
           retirado_em = case when coalesce(p.pagamento_modo, 'link') = 'na_retirada'
                              then now() else p.retirado_em end,
           -- e quem retirou, por definicao, ja foi separado
           separado_em = case when coalesce(p.pagamento_modo, 'link') = 'na_retirada'
                              then coalesce(p.separado_em, now()) else p.separado_em end,
           atualizado_em = now()
     where p.id = v_p.id;
    update public.pedido_cobrancas c
       set encerrada_em = now(),
           encerramento_detalhe = 'pago no painel (69)'
     where c.pedido_id = v_p.id
       and c.tenant_id = v_p.tenant_id
       and c.pago_em is null and c.falhou_em is null and c.encerrada_em is null;
  else
    if v_p.status <> 'pago' then
      return query select false, 'nao_esta_pago', v_p.status, v_p.pago_em, v_p.retirado_em;
      return;
    end if;
    if v_p.retirado_em is not null then
      return query select false, 'ja_retirado', v_p.status, v_p.pago_em, v_p.retirado_em;
      return;
    end if;
    update public.pedidos p
       set retirado_em = now(),
           separado_em = coalesce(p.separado_em, now()),
           atualizado_em = now()
     where p.id = v_p.id;
  end if;

  return query
    select true, p_acao, p.status, p.pago_em, p.retirado_em
      from public.pedidos p where p.id = v_p.id;
end;
$fn$;

commit;
