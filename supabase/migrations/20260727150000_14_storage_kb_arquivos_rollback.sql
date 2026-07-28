-- Rollback de 14_storage_kb_arquivos
--
-- Remove as policies e o bucket. So roda limpo se o bucket estiver vazio —
-- delete de bucket com objetos dentro falha. Se ja houver arquivos de cliente,
-- esvazie antes (pelo painel do Supabase ou via API) ou deixe o bucket de pe e
-- remova apenas as policies.

drop function if exists public.kb_reindex_documento(uuid, text, jsonb);

drop policy if exists kb_arquivos_select on storage.objects;
drop policy if exists kb_arquivos_insert on storage.objects;
drop policy if exists kb_arquivos_update on storage.objects;
drop policy if exists kb_arquivos_delete on storage.objects;

delete from storage.buckets where id = 'kb-arquivos';
