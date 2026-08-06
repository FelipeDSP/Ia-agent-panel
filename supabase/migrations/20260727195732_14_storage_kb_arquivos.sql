-- 14_storage_kb_arquivos
--
-- Fase 4: o cliente sobe um arquivo pelo painel, ele fica num bucket privado,
-- a Edge Function processa e grava os chunks em kb_documentos.
--
-- Bucket PRIVADO. Nada aqui e servido publicamente: o arquivo bruto de um
-- cliente nao pode ser baixado por outro nem por link anonimo.
--
-- Isolamento por PATH. Convencao: {tenant_id}/{uuid}.{ext}. A primeira pasta
-- do path e o tenant_id. As policies comparam essa pasta com auth_tenant_id()
-- (o mesmo do resto do painel, que sai do JWT, nunca do request). Um cliente
-- so enxerga, sobe, atualiza e apaga dentro de {seu_tenant_id}/.
--
-- A Edge Function baixa o arquivo com a service_role, que ignora RLS — por
-- isso ela nao aparece nestas policies.
--
-- Nao ha indice novo: idx_kb_origem ja cobre (tenant_id, origem), que e o que
-- o swap de reprocessamento usa.
--
-- Rollback: 20260727195732_14_storage_kb_arquivos_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Bucket privado, com teto de tamanho e mimes permitidos
-- ---------------------------------------------------------------------------
--
-- O limite de 10MB tambem e checado no servidor do painel antes do upload, com
-- mensagem clara. Aqui e a rede de seguranca: mesmo que o front seja
-- contornado, o Storage recusa acima disso.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'kb-arquivos',
  'kb-arquivos',
  false,
  10485760, -- 10 MiB
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', -- .docx
    'text/plain'
  ]
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Policies em storage.objects, escopadas por path
-- ---------------------------------------------------------------------------
--
-- storage.foldername(name) devolve o path quebrado em array de pastas.
-- [1] e a primeira pasta = o tenant_id. Comparar com auth_tenant_id()::text
-- garante que o usuario so alcanca a propria pasta.
--
-- Super_admin nao entra aqui: ele nao sobe arquivo de tenant. Se precisar, usa
-- a service_role no servidor, que ignora RLS.

drop policy if exists kb_arquivos_select on storage.objects;
create policy kb_arquivos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'kb-arquivos'
    and (storage.foldername(name))[1] = public.auth_tenant_id()::text
  );

drop policy if exists kb_arquivos_insert on storage.objects;
create policy kb_arquivos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'kb-arquivos'
    and (storage.foldername(name))[1] = public.auth_tenant_id()::text
  );

drop policy if exists kb_arquivos_update on storage.objects;
create policy kb_arquivos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'kb-arquivos'
    and (storage.foldername(name))[1] = public.auth_tenant_id()::text
  )
  with check (
    bucket_id = 'kb-arquivos'
    and (storage.foldername(name))[1] = public.auth_tenant_id()::text
  );

drop policy if exists kb_arquivos_delete on storage.objects;
create policy kb_arquivos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'kb-arquivos'
    and (storage.foldername(name))[1] = public.auth_tenant_id()::text
  );

-- ---------------------------------------------------------------------------
-- 3. Swap atomico de chunks (reindex idempotente)
-- ---------------------------------------------------------------------------
--
-- A Edge Function extrai, faz chunk e embedda FORA de transacao (leva 30-60s,
-- dominado por I/O da OpenAI). So no fim chama esta funcao, que troca os chunks
-- do documento numa transacao unica: apaga os antigos daquele origem e insere
-- os novos. Se a etapa lenta falhar antes, esta funcao nem e chamada e os
-- chunks anteriores continuam de pe — o agente nunca fica sem base no meio de
-- um reprocessamento.
--
-- DELETE fisico, nao soft: chunk e indice reconstruivel a partir do arquivo no
-- Storage. Sempre escopado por (tenant_id, origem). Ver a excecao registrada no
-- CLAUDE.md.
--
-- Esta funcao e a AUTORIDADE sobre o invariante da secao 5: tenant_id vai na
-- coluna E no metadata, os dois derivados do MESMO argumento p_tenant_id. O que
-- o chamador puser em metadata.tenant_id e sobrescrito. Assim as duas copias
-- nao tem como dessincronizar — que e o bug que ja deixou um cliente sem base
-- sem ninguem perceber.
--
-- Chamada apenas pela service_role (Edge Function). Revogada de todo o resto.

create or replace function public.kb_reindex_documento(
  p_tenant_id uuid,
  p_origem    text,
  p_chunks    jsonb  -- [{ text, embedding: number[], chunk_index, metadata: {} }, ...]
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_inseridos integer;
begin
  if p_tenant_id is null then
    raise exception 'kb_reindex_documento: tenant_id nulo';
  end if;
  if p_origem is null or p_origem = '' then
    raise exception 'kb_reindex_documento: origem vazia';
  end if;
  if jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'kb_reindex_documento: p_chunks precisa ser array jsonb';
  end if;

  -- Tenant precisa existir e estar ativo. Evita gravar orfao se o tenant foi
  -- removido no meio do processamento.
  if not exists (
    select 1 from public.tenants
    where id = p_tenant_id and ativo and deletado_em is null
  ) then
    raise exception 'kb_reindex_documento: tenant % inexistente ou inativo', p_tenant_id;
  end if;

  delete from public.kb_documentos
   where tenant_id = p_tenant_id and origem = p_origem;

  insert into public.kb_documentos (tenant_id, text, embedding, metadata, origem, chunk_index)
  select
    p_tenant_id,
    c->>'text',
    (c->>'embedding')::extensions.vector,           -- ->> de um array jsonb vira '[..]', literal de vector
    coalesce(c->'metadata', '{}'::jsonb)
      || jsonb_build_object('tenant_id', p_tenant_id::text, 'fonte', p_origem),
    p_origem,
    (c->>'chunk_index')::int
  from jsonb_array_elements(p_chunks) as c
  where coalesce(c->>'text', '') <> '';

  get diagnostics v_inseridos = row_count;

  -- Dimensao errada = espaco vetorial errado = busca ruim sem erro. Barra aqui.
  if exists (
    select 1 from public.kb_documentos
     where tenant_id = p_tenant_id and origem = p_origem
       and extensions.vector_dims(embedding) <> 1536
  ) then
    raise exception 'kb_reindex_documento: embedding com dimensao <> 1536';
  end if;

  return v_inseridos;
end;
$$;

comment on function public.kb_reindex_documento(uuid, text, jsonb) is
  'Swap atomico dos chunks de um documento (delete fisico por tenant+origem + '
  'insert). Autoridade do invariante tenant_id coluna=metadata. So service_role.';

revoke all on function public.kb_reindex_documento(uuid, text, jsonb) from public;
revoke all on function public.kb_reindex_documento(uuid, text, jsonb) from anon;
revoke all on function public.kb_reindex_documento(uuid, text, jsonb) from authenticated;
