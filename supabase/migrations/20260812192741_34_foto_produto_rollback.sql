-- Rollback da migracao 34
--
-- RECUSA em dois casos, e os dois apagariam dado que nao volta:
--
--   1. algum produto com foto_path preenchido — dropar a coluna perderia a
--      ligacao entre produto e arquivo, e o arquivo viraria orfao anonimo;
--   2. algum objeto no bucket — apagar o bucket apaga as fotos dos clientes.
--
-- Para reverter de verdade: remova as fotos pelo painel (o que limpa os dois de
-- uma vez, porque a Server Action apaga o objeto e zera a coluna) e so entao
-- rode isto.

begin;

do $$
declare
  n_col integer;
  n_obj integer;
begin
  select count(*) into n_col from public.produtos where foto_path is not null;
  if n_col > 0 then
    raise exception
      'rollback 34 recusado: % produto(s) com foto. Remova as fotos pelo painel antes.', n_col
      using errcode = '55000';
  end if;

  select count(*) into n_obj from storage.objects where bucket_id = 'produto-fotos';
  if n_obj > 0 then
    raise exception
      'rollback 34 recusado: % arquivo(s) no bucket produto-fotos. Apagar o bucket apagaria fotos de cliente.', n_obj
      using errcode = '55000';
  end if;
end $$;

drop policy if exists produto_fotos_select on storage.objects;
drop policy if exists produto_fotos_insert on storage.objects;
drop policy if exists produto_fotos_update on storage.objects;
drop policy if exists produto_fotos_delete on storage.objects;

delete from storage.buckets where id = 'produto-fotos';

alter table public.produtos drop column if exists foto_path;

commit;
