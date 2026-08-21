-- Migracao 48 — `api_n8n_conversa_pausada`, a porta do portao unico de pausa
--
-- NAO APLICADA EM PRODUCAO. Ao aplicar fora do CLI, escolha a versao ANTES,
-- renomeie ESTE arquivo e o rollback para ela, e grave a linha do ledger na
-- MESMA transacao da migracao — foi assim que a 47 entrou e por isso o nome dela
-- bate com `supabase_migrations.schema_migrations` (ver CLAUDE.md, Migracoes).
--
-- ============================== POR QUE ELA EXISTE =========================
--
-- A 47 fez a pausa CADUCAR, mas nao mudou QUEM a consulta. No `agente-principal`
-- so o ramo `processar` passa por checagem de pausa; os outros dois vazam:
--
--   Roteia Acao [0] processar  -> Mensagem Pronta -> Sync Conversa -> Nao Pausado?
--   Roteia Acao [1] midia      -> Config Audio -> Audio Contratado?
--                                   [true]  -> Conversa Ativa?      (protegido)
--                                   [false] -> Avisa Midia Nao Suportada   VAZA
--   Roteia Acao [2] bloqueado  -> Credencial (bloqueio) -> Envia Resposta Bloqueada  VAZA
--
-- Efeito medido em producao pelo dono do Emporio: com a conversa pausada, o bot
-- AINDA manda a mensagem de midia nao suportada por cima do atendimento humano.
-- Imagem, documento e video caem no ramo falso do `Audio Contratado?` e nunca
-- veem o `Conversa Ativa?`. O mesmo vale para audio de tenant que nao contratou
-- transcricao. E `bloqueado` e a mesma classe: injection durante atendimento
-- humano faz o bot responder "fora de escopo" por cima do dono.
--
-- A ORIGEM DO DEFEITO explica os dois. A nota do `Conversa Ativa?` diz, com
-- todas as letras, que ele existe para "nao desperdicar transcricao quando o
-- humano assumiu" — foi desenhado como ECONOMIA, nao como guarda de pausa, e por
-- isso ficou fundo demais no ramo. Nome dizendo uma coisa, posicao implicando
-- outra.
--
-- ===================== POR QUE FUNCAO NOVA, E NAO REUSO ====================
--
-- `api_n8n_pode_transcrever` JA devolve `conversa_pausada` e ja respeita a
-- janela (a 47 trocou a comparacao crua por `pausa_vigente`; medido em producao
-- com linhas dos dois lados da fronteira de 30 min). Chamar ELA no ramo de
-- bloqueio funcionaria e seria errado: uma funcao chamada "pode transcrever"
-- respondendo "a conversa esta pausada?" e a mesma mentira de nome que este repo
-- vem limpando ha uma semana.
--
-- Estender `api_n8n_credencial_chatwoot` tambem foi descartado, por dois
-- motivos: ela recebe so `tenant_id`, entao acrescentar `p_conversation_id` e
-- mudanca de ARIDADE — `drop function`, grants nos dois roles, e com DEFAULT a
-- chamada de 1 argumento vira AMBIGUA (28, 32, 37) —; e faria uma funcao de
-- credencial responder pergunta de conversa.
--
-- O mesmo vale para `api_n8n_tenant_por_chatwoot`, que seria a unica candidata a
-- "carregar a pausa junto de uma consulta que ja existe": ela e chamada em DOIS
-- nos (`Resolve Tenant` e `Resolve Tenant (pausa)`), e a de 1 argumento e
-- exatamente a que ficaria ambigua.
--
-- ===================== NAO HA `drop function`, MAS HA RISCO DE GRANT =======
--
-- Funcao NOVA: nao existe assinatura anterior, entao nao ha `drop`, nao ha
-- aridade ambigua e nao ha ACL para restaurar. A armadilha aqui e a OUTRA da
-- mesma familia: a 40 e a 41 sairam so com `service_role` e quebraram o agente,
-- porque **o n8n conecta como `n8n_agent`**, nao como `service_role`. Por isso
-- as quatro linhas de grant no fim, e por isso `npm run teste:grants-n8n` pega
-- esta funcao sozinho — ele varre por padrao `api_n8n_*`, nao por lista fixa.
--
-- ===================== CUSTO, MEDIDO E NAO ADJETIVADO ======================
--
-- `explain (analyze, buffers)` do corpo desta funcao contra producao:
-- **2,1 ms**, index scan em `conversas_tenant_id_conversation_id_key` mais seq
-- scan em `tenants` (10 linhas — o planner ignora o indice, e esta certo).
-- Para comparar, o `Sync Conversa` que ja roda a cada mensagem custa **6,9 ms**
-- (upsert + trigger `trg_conversas_upd` a 1,5 ms). Ida e volta de 30 execucoes:
-- 33,8 ms para esta, 33,6 ms para `api_n8n_tenant_por_chatwoot`. Ou seja: o
-- trabalho de banco e 2 ms de 34 — o custo do portao e UMA VOLTA a mais, e ele
-- custa um terco do que o `Sync Conversa` ja gasta.
--
-- ===================== ORDEM DE IMPLANTACAO ================================
--
--   1. este SQL;
--   2. o import do workflow com o portao.
--
-- Nesta ordem nao existe janela de quebra: a funcao fica sem chamador ate o
-- import. A ordem inversa faz TODA mensagem de midia e de bloqueio estourar em
-- `function api_n8n_conversa_pausada does not exist`.
--
-- E o ROLLBACK herda isso invertido: nao rode com o portao vivo no n8n.

begin;

-- ---------------------------------------------------------------------------
-- A funcao.
--
-- SECURITY DEFINER e obrigatorio, nao estilo: `n8n_agent` nao tem privilegio de
-- TABELA desde a migracao 09 (revoke em massa) — so as `api_n8n_*`. Sem
-- definer, o portao morre em `permission denied for table conversas`.
--
-- STABLE porque le e nao escreve. E ela nao pode escrever mesmo: e a expiracao
-- preguicosa da 47 — a pausa nao e desfeita, ela deixa de valer quando lida.
--
-- `left join` em conversas: conversa inexistente da `cv.status` nulo,
-- `pausa_vigente` devolve false, e a leitura e a certa — o que nao existe nao
-- esta pausado. E o mesmo comportamento que `api_n8n_pode_transcrever` tem.
--
-- A REGRA NAO ESTA AQUI. Este corpo nao decide nada sobre janela ou motivo: ele
-- delega a `public.pausa_vigente`, que a 47 criou justamente para morar em UM
-- lugar. Se um dia a regra mudar, muda la, e os quatro leitores acompanham
-- juntos — `api_n8n_conversa_sync`, `api_n8n_pode_transcrever`, esta, e a view
-- do painel quando ela chegar.
-- ---------------------------------------------------------------------------
create or replace function public.api_n8n_conversa_pausada(
  p_tenant_id       uuid,
  p_conversation_id bigint
) returns boolean
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_pausada boolean;
begin
  perform public.n8n_assert_tenant(p_tenant_id);

  if p_conversation_id is null then
    raise exception 'api_n8n: p_conversation_id e obrigatorio' using errcode = '22023';
  end if;

  select public.pausa_vigente(cv.status, cv.pausado_em, cv.motivo_pausa, t.pausa_expira_minutos)
    into v_pausada
    from public.tenants t
    left join public.conversas cv
           on cv.tenant_id = t.id
          and cv.conversation_id = p_conversation_id
   where t.id = p_tenant_id;

  -- `n8n_assert_tenant` ja garantiu que o tenant existe, entao o select acima
  -- sempre acha linha. O coalesce e para o caso de alguem afrouxar o assert um
  -- dia: sem ele, NULL viajaria ate o IF do n8n, que trata nulo como falso — o
  -- mesmo resultado, mas por acidente em vez de por escolha.
  return coalesce(v_pausada, false);
end;
$function$;

comment on function public.api_n8n_conversa_pausada(uuid, bigint) is
  'O agente deve ficar calado nesta conversa? Porta unica do portao de pausa do '
  'agente-principal, chamada ANTES do Roteia Acao — antes existia checagem so no '
  'ramo processar, e midia e bloqueado falavam por cima do atendimento humano. '
  'Delega a public.pausa_vigente; a regra mora la. Ver docs/PAUSA-AUTOMATICA.md.';

-- Por padrao o Postgres da EXECUTE a PUBLIC em toda funcao nova (nota da 09).
-- `anon` e `authenticated` ficam de fora: o painel nao chama esta funcao, e ela
-- e SECURITY DEFINER — aberta a `anon`, qualquer um consultaria a pausa de
-- qualquer conversa de qualquer cliente passando o par de ids.
--
-- `n8n_agent` E A LINHA QUE IMPORTA. E o role pelo qual o agente conecta; nao e
-- `service_role`, e era essa a que faltava na 40 e na 41.
revoke all on function public.api_n8n_conversa_pausada(uuid, bigint) from public;
revoke all on function public.api_n8n_conversa_pausada(uuid, bigint) from anon;
revoke all on function public.api_n8n_conversa_pausada(uuid, bigint) from authenticated;
grant execute on function public.api_n8n_conversa_pausada(uuid, bigint) to service_role;
grant execute on function public.api_n8n_conversa_pausada(uuid, bigint) to n8n_agent;

commit;
