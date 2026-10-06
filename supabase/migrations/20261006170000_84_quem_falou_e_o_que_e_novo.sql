-- =====================================================================
-- Migração 84 — quem falou na conversa, e o que é novo em Pedidos
-- =====================================================================
-- Pedido do Felipe, 06/10/2026: quem gerencia pedidos precisa abrir a conversa
-- e ver o que a IA falou com o cliente, "saber se as informações estão
-- corretas"; e precisa ser avisado de venda nova dentro do painel.
--
-- O DEFEITO QUE A PRIMEIRA PARTE CONSERTA, medido antes de escrever: nos
-- últimos 30 dias há 20 mensagens com `fonte_tokens = 'humano'` — respostas
-- que um ATENDENTE escreveu, não o agente. `conversa_historico` devolve só
-- `(direcao, conteudo, criado_em)`, então a tela rotula TODA saída como
-- "Agente". Quem abrir para conferir se a IA falou certo vai ler a frase de um
-- colega achando que foi a IA, e pode "corrigir" o prompt por causa de uma
-- frase que o prompt não escreveu. Há ainda `aviso_midia` (13) e
-- `endereco_retirada` (1), que são do SISTEMA e também apareciam como agente.
--
-- POR QUE FUNÇÃO NOVA E NÃO `create or replace`: mudar a lista de colunas de
-- retorno muda a assinatura, e o Postgres recusa `create or replace` nesse
-- caso. Seria preciso `drop` — e `drop` apaga os grants (a armadilha das 40/41)
-- e, pior, deixaria o painel no ar chamando uma função que sumiu por um
-- instante. `conversa_historico` FICA, intacta, e quem quiser o detalhe chama
-- a nova. É a regra do CLAUDE.md: comportamento novo entra por função NOVA.
--
-- A SEGUNDA PARTE é uma coluna: `usuarios_painel.pedidos_vistos_em`. O aviso
-- de venda nova é por PESSOA — duas pessoas na mesma conta trabalham em turnos
-- diferentes, e "novo para a Maria" não é "novo para a Ana". Guardar no
-- navegador resolveria só para um computador e sumiria no primeiro F5 em outra
-- máquina.
--
-- Rollback: 20261006170000_84_quem_falou_e_o_que_e_novo_rollback.sql
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Quem falou.
--
--    `fonte` sai do `fonte_tokens`, que o serviço já grava:
--      - entrada                     -> 'cliente'
--      - saida + fonte 'humano'      -> 'atendente'  (um colega escreveu)
--      - saida + aviso_midia/endereco_retirada -> 'sistema'
--      - saida + o resto             -> 'agente'
--
--    A classificação mora AQUI e não na tela porque a tela não deve conhecer
--    os nomes internos de `fonte_tokens` — eles mudam (já mudaram na 76).
-- ---------------------------------------------------------------------
create or replace function public.painel_conversa_mensagens(p_conversation_id bigint)
returns table(direcao text, conteudo text, criado_em timestamptz, fonte text)
language sql
stable
security definer
set search_path = public
as $fn$
  select m.direcao,
         m.conteudo,
         m.criado_em,
         case
           when m.direcao = 'entrada' then 'cliente'
           when coalesce(m.fonte_tokens, '') = 'humano' then 'atendente'
           when coalesce(m.fonte_tokens, '') in ('aviso_midia', 'endereco_retirada') then 'sistema'
           else 'agente'
         end as fonte
    from public.mensagens_log m
   where m.tenant_id = public.auth_tenant_id()
     and m.conversation_id = p_conversation_id
     and public.auth_pode('ver_conversas')
   order by m.criado_em, m.id;
$fn$;

revoke all on function public.painel_conversa_mensagens(bigint) from public;
revoke all on function public.painel_conversa_mensagens(bigint) from anon;
grant execute on function public.painel_conversa_mensagens(bigint) to authenticated;
grant execute on function public.painel_conversa_mensagens(bigint) to service_role;

-- ---------------------------------------------------------------------
-- 2. O que é novo, por pessoa.
-- ---------------------------------------------------------------------
alter table public.usuarios_painel
  add column if not exists pedidos_vistos_em timestamptz;

comment on column public.usuarios_painel.pedidos_vistos_em is
  'Quando ESTA pessoa viu a fila de pedidos pela ultima vez. Nulo = nunca abriu.';

-- O guard da 73/80 continua barrando papel, tenant, email e ativo. A pessoa
-- passa a poder carimbar o PRÓPRIO marcador — é dela, e escrever nele é o ato
-- de abrir a tela.
create or replace function public.usuarios_painel_guard_colunas()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if public.auth_is_super_admin() then
    return new;
  end if;

  if public.auth_e_admin()
     and old.tenant_id = public.auth_tenant_id()
     and old.id <> auth.uid()
  then
    if (to_jsonb(new) - '{nome,funcao_id,ativo,pedidos_vistos_em,atualizado_em}'::text[])
       is distinct from
       (to_jsonb(old) - '{nome,funcao_id,ativo,pedidos_vistos_em,atualizado_em}'::text[])
    then
      raise exception
        'Sem permissao: o admin da conta muda nome, funcao e ativo da equipe. Papel, tenant e email sao da agencia.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if (to_jsonb(new) - '{nome,pedidos_vistos_em,atualizado_em}'::text[])
     is distinct from
     (to_jsonb(old) - '{nome,pedidos_vistos_em,atualizado_em}'::text[])
  then
    raise exception
      'Sem permissao: voce so pode alterar o proprio nome. Papel, tenant, email e ativo sao da agencia.'
      using errcode = '42501';
  end if;

  return new;
end;
$fn$;

commit;
