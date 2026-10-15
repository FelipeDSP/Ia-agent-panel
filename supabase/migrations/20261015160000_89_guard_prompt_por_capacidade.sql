-- =============================================================================
-- 89 — O PROMPT E A CONFIGURAÇÃO DA CONTA PASSAM A PEDIR PERMISSÃO
-- =============================================================================
--
-- MEDIDO EM 15/10, pelo caminho público e não por leitura de código: criei um
-- `tenant_agente` no banco, entrei na API do Supabase com o e-mail e a senha
-- DELE (a URL e a chave publicável são públicas por desenho, não há truque) e
-- troquei o `system_prompt` da conta. Passou.
--
-- A policy `p_tenants_update` é `auth_is_super_admin() OR (id =
-- auth_tenant_id())`: ela confere o TENANT e não a capacidade. E o guard de
-- colunas desta função separava o que é da AGÊNCIA do que é do CLIENTE, mas
-- tratava todo membro do cliente como igual.
--
-- O resto do painel já não era assim — e é isso que torna a brecha um descuido
-- e não uma decisão:
--
--     produtos, categorias   -> auth_pode('editar_catalogo')
--     kb_documentos, jobs    -> auth_pode('editar_base')
--     conversas              -> auth_pode('pausar_retomar')
--     prompt_versoes         -> auth_pode('editar_prompt')   <-- o HISTÓRICO
--     tenants                -> (nada)                       <-- o prompt VIVO
--
-- A capacidade `editar_prompt` existe desde a 80 e guardava a cópia enquanto o
-- original ficava aberto.
--
-- O QUE MUDA. Dentro das colunas que já eram do cliente, duas faixas:
--
--   `system_prompt`          -> exige a capacidade `editar_prompt`;
--   agente_ativo, horário,   -> exigem ser ADMIN da conta. São a configuração
--   debounce, msgs,             do atendimento: desligar o agente ou mudar o
--   aprendizado_auto            expediente não é trabalho de quem atende.
--
-- POR QUE NO TRIGGER E NÃO NA POLICY: RLS não enxerga coluna. A regra aqui é
-- "quem muda O QUÊ", e o guard de colunas já era o lugar onde essa pergunta
-- morava — estender é mais honesto que criar uma segunda opinião ao lado.
--
-- QUEM MAIS ESCREVE EM `tenants`: ninguém. Varrido antes de escrever esta
-- migração — nenhuma função do banco, nenhuma Edge Function, nada no serviço
-- `agente/`, e todas as telas da agência usam o cliente do USUÁRIO
-- (`criarClienteServidor`), então `auth_is_super_admin()` é verdadeiro e a
-- função retorna na primeira linha, como antes.
--
-- `create or replace` de mesma assinatura: o ACL da função é preservado, não há
-- `drop` e portanto não há grant a recriar.
--
-- ROLLBACK: ao final do arquivo.
-- =============================================================================

-- SEM `security definer`, e isto é restauração e não escolha: a função nasceu
-- INVOKER na migração 13 e a primeira versão desta 89 a transformou em DEFINER
-- sem querer. Duas varreduras reprovaram na hora (`teste:acl-secdef` e
-- `teste:grants-n8n`), porque o ACL dela deixa `anon` e `authenticated`
-- executarem — herança do ALTER DEFAULT PRIVILEGES deste projeto. DEFINER com
-- esse ACL é uma função que roda como `postgres` ao alcance da chave do
-- navegador; de trigger ela não precisa, porque já roda dentro do UPDATE de
-- quem disparou.
--
-- Como INVOKER, o `select` em `usuarios_painel` passa pela RLS daquela tabela —
-- e é isso que se quer: a linha que o usuário não enxerga não decide por ele.
create or replace function public.tenants_guard_colunas()
returns trigger
language plpgsql
as $$
declare
  -- O que um membro do cliente pode tocar. `atualizado_em` entra porque o
  -- trigger de timestamp mexe nele em todo update.
  c_cliente constant text[] := array[
    'system_prompt', 'agente_ativo', 'debounce_segundos', 'msg_midia_nao_suportada',
    'msg_fora_escopo', 'horario_agente', 'aprendizado_auto', 'atualizado_em'
  ];
  -- Dessas, as que são decisão de quem ADMINISTRA a conta.
  c_admin constant text[] := array[
    'agente_ativo', 'debounce_segundos', 'msg_midia_nao_suportada',
    'msg_fora_escopo', 'horario_agente', 'aprendizado_auto'
  ];
  v_admin boolean;
begin
  if public.auth_is_super_admin() then
    return new;
  end if;

  -- 1) as colunas da AGÊNCIA continuam fechadas para todo mundo (como antes).
  if (to_jsonb(new) - c_cliente) is distinct from (to_jsonb(old) - c_cliente) then
    raise exception
      'Sem permissao: tenant_admin so pode alterar prompt, mensagens, debounce, agente_ativo, horario_agente e aprendizado_auto. Modelo, temperatura, tokens, slug, status e nome sao da agencia.'
      using errcode = '42501';
  end if;

  -- 2) o PROMPT pede a capacidade. Mesma pergunta que a RLS de
  --    `prompt_versoes` já fazia para o histórico dele.
  if new.system_prompt is distinct from old.system_prompt
     and not public.auth_pode('editar_prompt') then
    raise exception
      'Sem permissao: mudar o prompt do agente exige a capacidade "editar_prompt".'
      using errcode = '42501';
  end if;

  -- 3) a CONFIGURAÇÃO do atendimento é do admin da conta.
  --    A identidade segue a mesma ordem de `auth_capacidades`: a LINHA decide
  --    quando existe (é o que faz revogar valer na hora) e o claim responde
  --    quando não existe.
  if exists (
    select 1 from unnest(c_admin) k
     where to_jsonb(new) -> k is distinct from to_jsonb(old) -> k
  ) then
    v_admin := coalesce(
      (select u.papel in ('super_admin', 'tenant_admin') and u.ativo
         from public.usuarios_painel u where u.id = auth.uid()),
      coalesce(nullif(public.jwt_claims() -> 'app_metadata' ->> 'papel', ''), '')
        in ('super_admin', 'tenant_admin')
    );
    if not v_admin then
      raise exception
        'Sem permissao: ligar/desligar o agente, horario de atendimento, debounce e mensagens padrao sao do administrador da conta.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.tenants_guard_colunas() is
  '89: alem de separar coluna da agencia x do cliente, separa DENTRO do cliente: '
  '`system_prompt` exige `editar_prompt` e a configuracao do atendimento exige ser admin da conta. '
  'Ate 15/10 qualquer membro do tenant trocava o prompt pela API publica — medido com um tenant_agente de verdade.';

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- create or replace function public.tenants_guard_colunas()
-- returns trigger
-- language plpgsql
-- as $rb$
-- begin
--   if public.auth_is_super_admin() then
--     return new;
--   end if;
--
--   if (to_jsonb(new) - '{system_prompt,agente_ativo,debounce_segundos,msg_midia_nao_suportada,msg_fora_escopo,horario_agente,aprendizado_auto,atualizado_em}'::text[])
--      is distinct from
--      (to_jsonb(old) - '{system_prompt,agente_ativo,debounce_segundos,msg_midia_nao_suportada,msg_fora_escopo,horario_agente,aprendizado_auto,atualizado_em}'::text[])
--   then
--     raise exception
--       'Sem permissao: tenant_admin so pode alterar prompt, mensagens, debounce, agente_ativo, horario_agente e aprendizado_auto. Modelo, temperatura, tokens, slug, status e nome sao da agencia.'
--       using errcode = '42501';
--   end if;
--
--   return new;
-- end;
-- $rb$;
-- =============================================================================
