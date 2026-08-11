-- Rollback de 27_catalogo_vendas
--
-- Remove a linha `vendas` do catalogo global.
--
-- A FK de tenant_tools.tool_nome -> catalogo_tools nao tem CASCADE: se algum
-- cliente ja contratou vendas, o delete falha com 23503 em vez de arrastar a
-- contratacao junto. O bloco 1 antecipa isso com uma mensagem util, em vez de
-- deixar o erro cru do Postgres.
--
-- Descontratar antes e decisao comercial, nao consequencia de rollback tecnico —
-- por isso este arquivo nao faz isso por conta propria.
--
-- Ordem: rode ANTES o rollback dos sub-workflows no n8n (ou desligue as tools),
-- senao os sub-workflows passam a checar um tool_nome que nao existe mais. O
-- comportamento nesse caso e "indisponivel", que e seguro — mas e melhor
-- desligar de proposito do que por efeito colateral.

begin;

do $$
declare
  v_contratantes text;
begin
  select string_agg(t.slug, ', ')
    into v_contratantes
  from public.tenant_tools tt
  join public.tenants t on t.id = tt.tenant_id
  where tt.tool_nome = 'vendas';

  if v_contratantes is not null then
    raise exception
      'Abortado: vendas esta contratada por: %. Descontrate na tela de Modulos '
      'antes de remover do catalogo — descontratar e decisao comercial, nao '
      'efeito colateral de rollback.', v_contratantes
      using errcode = 'data_exception';
  end if;
end;
$$;

delete from public.catalogo_tools where tool_nome = 'vendas';

commit;
