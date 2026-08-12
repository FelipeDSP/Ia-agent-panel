-- Migracao 34 — foto por produto: coluna + bucket privado
--
-- UMA foto por produto, `foto_path text` nullable. A razao nao e tecnica: o
-- canal e conversa. O agente manda imagem com legenda na MESMA mensagem, e tres
-- fotos de um prato viram spam no WhatsApp. Multiplas fotos servem catalogo
-- navegavel, nao atendimento.
--
-- E a assimetria decide a forma: se aparecer necessidade real, `fotos jsonb`
-- depois e aditivo numa coluna que ninguem preencheu; o inverso — sair de jsonb
-- para uma coluna so — nao e.
--
-- POR QUE AGORA, e nao na fatia 2. O adiamento original tinha uma razao
-- especifica registrada em VENDAS-ESTADO.md: foto por VARIACAO obrigaria a
-- remodelar foto, entao "as duas se desenham juntas". A fatia 2 CORTOU variacao
-- (nenhum dos 19 produtos reais precisava), `pedido_itens` nao tem a coluna e
-- nenhum produto usa `produtos.variacoes`. O acoplamento que justificava
-- esperar deixou de existir.
--
-- BUCKET PRIVADO, sem excecao. Nenhuma URL nossa chega ao WhatsApp: o teste de
-- 11/08 provou que o Chatwoot RE-HOSPEDA a imagem que recebe. O fluxo e
-- Storage -> n8n -> multipart -> Chatwoot, e a URL assinada so precisa
-- sobreviver a segundos dentro da execucao.
--
-- O TETO DE 512 KB E A GARANTIA, nao a otimizacao. O painel redimensiona no
-- NAVEGADOR (canvas, maior lado 1024px, JPEG q0.8) antes de subir, para os 3 MB
-- da foto de celular nunca trafegarem. Mas navegador se contorna; o bucket nao.
-- Upload por fora da UI com arquivo grande simplesmente falha aqui.
--
-- Rollback: 20260812192741_34_foto_produto_rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. A coluna
-- ---------------------------------------------------------------------------

alter table public.produtos
  add column if not exists foto_path text;

comment on column public.produtos.foto_path is
  'Path no bucket produto-fotos, no formato {tenant_id}/{produto_id}.jpg. NULL = sem foto. Path FIXO por produto (upsert substitui) para nao acumular orfao a cada troca.';

-- ---------------------------------------------------------------------------
-- 2. Bucket privado
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'produto-fotos',
  'produto-fotos',
  false,
  524288, -- 512 KiB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 3. Policies em storage.objects, escopadas por path
-- ---------------------------------------------------------------------------
--
-- Identicas em forma as do kb-arquivos (migracao 14): storage.foldername(name)[1]
-- e a primeira pasta do path = o tenant_id, comparada com auth_tenant_id(), que
-- sai do JWT e nunca do request.
--
-- QUEM SOBE E O CLIENTE, nao a agencia. Ele ja edita nome, preco e
-- disponibilidade; foto e o mesmo tipo de dado. Agencia subindo foto viraria
-- gargalo de onboarding — um restaurante com 80 pratos passaria por uma pessoa.
-- Curadoria e preocupacao de marketplace; aqui o cliente e dono do catalogo.
--
-- A Edge Function que assina a URL para o n8n usa service_role, que ignora RLS —
-- por isso ela nao aparece aqui.

drop policy if exists produto_fotos_select on storage.objects;
create policy produto_fotos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'produto-fotos'
    and (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  );

drop policy if exists produto_fotos_insert on storage.objects;
create policy produto_fotos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'produto-fotos'
    and (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  );

drop policy if exists produto_fotos_update on storage.objects;
create policy produto_fotos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'produto-fotos'
    and (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  )
  with check (
    bucket_id = 'produto-fotos'
    and (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  );

drop policy if exists produto_fotos_delete on storage.objects;
create policy produto_fotos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'produto-fotos'
    and (storage.foldername(name))[1] = (public.auth_tenant_id())::text
  );

commit;
