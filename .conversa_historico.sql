CREATE OR REPLACE FUNCTION public.conversa_historico(p_conversation_id bigint)
 RETURNS TABLE(direcao text, conteudo text, criado_em timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select m.direcao, m.conteudo, m.criado_em
  from public.mensagens_log m
  where m.tenant_id = public.auth_tenant_id()
    and m.conversation_id = p_conversation_id
  order by m.criado_em asc;
$function$
