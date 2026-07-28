-- Testes de isolamento da API do n8n (Opcao C, secao 5.4).
--
-- Complementa a suite de isolamento entre os 3 tenants. Aqui o sujeito nao e
-- um usuario logado com JWT, e o role n8n_agent — o segundo consumidor do
-- banco. As garantias que precisam valer:
--
--   1. n8n_agent nao alcanca tabela nenhuma diretamente
--   2. n8n_agent so enxerga o tenant que passou na assinatura
--   3. o filtro de metadata nao consegue ampliar escopo
--   4. anon e authenticated nao alcancam a API
--
-- PRE-REQUISITO: quem roda precisa poder "set role n8n_agent".
--   grant n8n_agent to postgres;
--
-- Uso:  psql "$SUPABASE_DB_URL" -f supabase/tests/isolamento_api_n8n.sql
-- Saida: uma linha por caso. Qualquer 'FALHOU' quebra o build.

\set ON_ERROR_STOP on

do $$
declare
  v_acqua      uuid;
  v_clinica    uuid;
  v_emb        extensions.vector;
  v_n          int;
  v_falhas     int := 0;
  v_conv       bigint := 999001;
begin
  select id into v_acqua   from public.tenants where slug = 'acqua-lavanderia';
  select id into v_clinica from public.tenants where slug = 'clinica-teste';

  if v_acqua is null or v_clinica is null then
    raise exception 'Seed ausente: rode o seed dos 3 tenants antes.';
  end if;

  v_emb := ('[' || array_to_string(array_fill(0.001::real, array[1536]), ',') || ']')::extensions.vector;

  -- ---------------------------------------------------------------------
  -- 1. Sem acesso direto a tabela
  -- ---------------------------------------------------------------------

  begin
    set local role n8n_agent;
    perform 1 from public.kb_documentos limit 1;
    raise warning 'FALHOU: n8n_agent leu kb_documentos';
    v_falhas := v_falhas + 1;
  exception when insufficient_privilege then
    raise notice 'OK: kb_documentos negado';
  end;
  reset role;

  begin
    set local role n8n_agent;
    perform 1 from public.tenants limit 1;
    raise warning 'FALHOU: n8n_agent leu tenants';
    v_falhas := v_falhas + 1;
  exception when insufficient_privilege then
    raise notice 'OK: tenants negado';
  end;
  reset role;

  begin
    set local role n8n_agent;
    insert into public.mensagens_log(tenant_id, direcao) values (v_acqua, 'entrada');
    raise warning 'FALHOU: n8n_agent inseriu em mensagens_log';
    v_falhas := v_falhas + 1;
  exception when insufficient_privilege then
    raise notice 'OK: insert em mensagens_log negado';
  end;
  reset role;

  begin
    set local role n8n_agent;
    perform 1 from auth.users limit 1;
    raise warning 'FALHOU: n8n_agent leu auth.users';
    v_falhas := v_falhas + 1;
  exception when insufficient_privilege then
    raise notice 'OK: auth.users negado';
  end;
  reset role;

  -- ---------------------------------------------------------------------
  -- 2. A API funciona e e escopada
  -- ---------------------------------------------------------------------

  set local role n8n_agent;

  select count(*) into v_n from public.api_n8n_tenant_por_chatwoot(56);
  if v_n <> 1 then
    raise warning 'FALHOU: chatwoot 56 resolveu % tenants', v_n;
    v_falhas := v_falhas + 1;
  else
    raise notice 'OK: chatwoot 56 -> 1 tenant';
  end if;

  -- Nenhum documento de outro tenant, mesmo pedindo limite alto
  select count(*) into v_n
  from public.api_n8n_buscar_kb(v_acqua, v_emb, 50) r
  where r.metadata->>'tenant_id' <> v_acqua::text;
  if v_n <> 0 then
    raise warning 'FALHOU: % documentos de outro tenant na busca de acqua', v_n;
    v_falhas := v_falhas + 1;
  else
    raise notice 'OK: busca de acqua sem vazamento';
  end if;

  -- 3. Filtro de metadata apontando para outro tenant nao amplia escopo:
  --    ele intersecta, nunca substitui o filtro por coluna.
  select count(*) into v_n
  from public.api_n8n_buscar_kb(
    v_acqua, v_emb, 50,
    jsonb_build_object('tenant_id', v_clinica::text));
  if v_n <> 0 then
    raise warning 'FALHOU: filtro cruzado devolveu % linhas', v_n;
    v_falhas := v_falhas + 1;
  else
    raise notice 'OK: filtro de metadata cruzado devolve vazio';
  end if;

  -- Tenant inexistente
  begin
    perform * from public.api_n8n_buscar_kb(gen_random_uuid(), v_emb, 5);
    raise warning 'FALHOU: tenant inexistente aceito';
    v_falhas := v_falhas + 1;
  exception when insufficient_privilege then
    raise notice 'OK: tenant inexistente rejeitado';
  end;

  -- Tenant nulo
  begin
    perform * from public.api_n8n_buscar_kb(null, v_emb, 5);
    raise warning 'FALHOU: tenant nulo aceito';
    v_falhas := v_falhas + 1;
  exception when others then
    raise notice 'OK: tenant nulo rejeitado (%)', sqlstate;
  end;

  -- Idempotencia do sync de conversa
  perform * from public.api_n8n_conversa_sync(v_acqua, v_conv, 'Teste', '5511999999999');
  perform * from public.api_n8n_conversa_sync(v_acqua, v_conv, null, null);
  reset role;
  select count(*) into v_n from public.conversas
   where tenant_id = v_acqua and conversation_id = v_conv;
  if v_n <> 1 then
    raise warning 'FALHOU: conversa_sync duplicou (% linhas)', v_n;
    v_falhas := v_falhas + 1;
  else
    raise notice 'OK: conversa_sync idempotente';
  end if;
  delete from public.conversas where tenant_id = v_acqua and conversation_id = v_conv;

  -- ---------------------------------------------------------------------
  -- 4. A API nao e alcancavel pelo PostgREST
  --
  -- As funcoes sao SECURITY DEFINER e ignoram RLS. Se anon tivesse EXECUTE,
  -- qualquer pessoa na internet leria a KB de qualquer tenant passando o
  -- UUID. Este e o caso que segura a Opcao C de pe.
  -- ---------------------------------------------------------------------

  begin
    set local role anon;
    perform * from public.api_n8n_tenant_por_chatwoot(56);
    raise warning 'FALHOU: anon chamou a API';
    v_falhas := v_falhas + 1;
  exception when insufficient_privilege then
    raise notice 'OK: API negada a anon';
  end;
  reset role;

  begin
    set local role authenticated;
    perform * from public.api_n8n_buscar_kb(v_acqua, v_emb, 3);
    raise warning 'FALHOU: authenticated chamou a API';
    v_falhas := v_falhas + 1;
  exception when insufficient_privilege then
    raise notice 'OK: API negada a authenticated';
  end;
  reset role;

  -- ---------------------------------------------------------------------

  if v_falhas > 0 then
    raise exception '% caso(s) de isolamento falharam', v_falhas;
  end if;

  raise notice 'Todos os casos passaram.';
end $$;
