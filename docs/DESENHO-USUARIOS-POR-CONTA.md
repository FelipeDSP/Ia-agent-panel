# Desenho — usuários por conta (admins e agentes)

> Conversa de 17/09/2026. **Só desenho; nada construído. Começa DEPOIS de
> `DESENHO-VENDAS-MODALIDADES.md`** (decisão do Felipe: vendas primeiro).

## 1. O que o Felipe quer

Arquitetura à la Chatwoot: a agência (`super_admin`) → cada conta tem um ou
mais **admins** (gerenciam a conta) → e **agentes**, que não editam certas
coisas mas fazem o que os admins permitirem. Hoje cada conta tem exatamente um
usuário, o `tenant_admin`.

## 2. O que já existe e favorece

- papel vem do JWT (`app_metadata.papel`: `super_admin` | `tenant_admin`);
  `usuarios_painel` tem `tenant_id` + `papel`; o trigger da migração 12
  (`handle_novo_usuario`) sincroniza `app_metadata`; as policies usam
  `auth_tenant_id()` / `auth_is_super_admin()`;
- **vários admins** por conta é quase de graça — nada amarra o papel a um
  usuário; falta só a tela de convite;
- o padrão "uma verdade, três consumidores" (`src/lib/tools/contratacao.ts`:
  menu, guard de rota, Server Action) é onde a permissão entra.

## 3. Decisões (17/09)

- **Capacidades fixas em checkbox**, não ACL livre. O admin marca por agente:
  `ver_conversas`, `pausar_retomar`, `limpar_memoria`, `marcar_pedido`
  (pago/retirado), `editar_catalogo`, `editar_prompt`, `editar_base`,
  `ver_consumo`. Admin tem todas, sempre. Lista vive no código (registry, como
  as tools), não em tabela.
- Papel novo `tenant_agente` (terceiro valor do `check` e do trigger);
  `usuarios_painel.permissoes text[]`, espelhado no JWT pelo trigger existente
  — para a RLS ler.
- **Permissão = tool contratada E usuário pode**, no mesmo ponto de
  `contratacao.ts`. Menu, rota e Server Action leem a mesma função.
- **Policies de escrita passam a ler a permissão do JWT.** Hoje só distinguem
  "é do tenant". Revisar UMA A UMA na migração: uma policy esquecida deixa o
  agente editar o prompt pela API com o botão escondido.
- Agente **nunca** edita o próprio papel/permissões; só admin; o trigger recusa
  papel fora da lista e recusa `permissoes` em quem não é agente.
- Convite pelo admin cria o usuário com `tenant_id` **do JWT do admin**
  (regra 1 do CLAUDE.md), reaproveitando `admin-usuarios.ts` / `auth/confirmar`.
- Permissão mudada vale no próximo refresh do token (~1 h): o painel força o
  refresh ao salvar OU a tela avisa. Sem isso vira chamado ("tirei e ele
  continua editando").

## 4. Ordem de construção

1. Migração: `tenant_agente` + `permissoes` + trigger + policies de escrita
   revisadas (lista sai de `pg_policies`, não da memória) + rollback.
2. `contratacao.ts` ganha o usuário: `podeUsar(usuario, tool, capacidade)`.
3. Painel do cliente: *Equipe* (convidar, papel, checkboxes, desativar).
4. Testes: três tenants × três papéis; agente de A não vê B; agente sem
   `editar_prompt` não edita por Server Action nem por PostgREST direto;
   sabotagem tirando uma policy deixa vermelho.

## 5. Ponto de contato com vendas

`marcar_pedido` é a capacidade que os botões pago/retirado de *Pedidos* vão
checar. Até lá, os botões são só de `tenant_admin`.

---

# Revisão de 06/10/2026 — funções nomeadas, e a permissão SAI do JWT

> Decisão do Felipe, 06/10: *"o admin deve determinar o que cada um pode fazer,
> ou categorizar por funções e cada função pode fazer X coisa, algo como as
> funções personalizadas do Chatwoot"*. Isto **substitui** a decisão de 17/09
> de marcar checkbox por pessoa. O resto da seção 3 continua valendo.

## 6. O que muda

**Função é entidade, não um campo da pessoa.** O admin da conta cria
"Vendedor", marca as capacidades dela, e atribui a função a quantas pessoas
quiser. Mudar a função muda todo mundo que a tem — que é o ponto, e é o que
checkbox por pessoa não dá.

`tenant_funcoes` (tenant_id, nome, capacidades text[]) e
`usuarios_painel.funcao_id`. As capacidades continuam **fixas, vindas do
registry no código** — o cliente compõe funções, não inventa capacidade.

## 7. A permissão NÃO vai para o JWT. Esta é a mudança que importa.

O desenho de 17/09 ia espelhar as permissões em `app_metadata` para a RLS ler,
e já tinha anotado o preço: *"permissão mudada vale no próximo refresh do token
(~1 h)"*, com o painel forçando refresh ou a tela avisando.

Com função nomeada esse preço cresce de um jeito que inviabiliza: tirar uma
capacidade da função "Vendedor" teria de reescrever o `app_metadata` de **toda
pessoa que tem a função**, e ainda assim ninguém perderia o acesso até o token
dela virar. O admin tira a permissão, vê a tela confirmar, e a pessoa continua
editando por mais uma hora. Não há aviso que conserte isso.

Então a RLS passa a **ler do banco, na hora**:

```sql
create function public.auth_capacidades() returns text[]
  language sql stable security definer set search_path = public as $$
  select case
    when public.auth_is_super_admin() then public.todas_as_capacidades()
    when u.papel = 'tenant_admin'     then public.todas_as_capacidades()
    else coalesce(f.capacidades, '{}')
  end
  from public.usuarios_painel u
  left join public.tenant_funcoes f on f.id = u.funcao_id
  where u.id = auth.uid() and u.ativo;
$$;
```

- `SECURITY DEFINER` porque `usuarios_painel` tem RLS e a função é chamada de
  dentro de policy — sem isso, recursão;
- a função lê **só a linha de `auth.uid()`**: não é um buraco para ver usuário
  alheio;
- `STABLE` é o que torna o custo aceitável: o Postgres resolve uma vez por
  statement, não por linha;
- **efeito imediato.** Admin tira a capacidade, a próxima requisição já é
  negada. O chamado "tirei e ele continua editando" deixa de existir.

O JWT continua carregando `papel` e `tenant_id` — esses não mudam com
frequência e já funcionam. É a CAPACIDADE que sai de lá.

## 8. Toda policy `for all` tem de virar duas

É aqui que mora o trabalho, e é a parte que uma revisão desatenta erra.

As policies de hoje são `for all` com `tenant_id = auth_tenant_id()` — um
comando só para ler e escrever. Pôr a capacidade nelas **tiraria o SELECT
junto**: um agente sem `editar_catalogo` deixaria de conseguir até VER o
catálogo, e a tela quebraria sem ninguém entender por quê.

Então cada uma vira **SELECT por tenant** + **escrita por tenant E
capacidade**. Medido em 06/10, são 7 tabelas (`categorias`, `conversas`,
`jobs_ingestao`, `kb_documentos`, `produtos`, `prompt_versoes`,
`tenant_times`), mais `tenant_tools` (update) e `usuarios_painel`.

## 9. E as SECURITY DEFINER, que a RLS não alcança

**Policy não é a única porta.** Função `SECURITY DEFINER` roda como `postgres`,
que tem `BYPASSRLS`: a policy mais caprichada do mundo não a vê passar. A lista
de quem o cliente logado pode chamar sai do catálogo, não da memória:

```sql
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and has_function_privilege('authenticated', p.oid, 'execute');
```

Em 06/10 são seis, e **duas importam**:

- `painel_marcar_pedido(uuid, text)` — **escreve**, e é a porta do botão
  pago/retirado. Precisa de `marcar_pedido` por dentro;
- `conversa_historico(bigint)` — lê o diálogo inteiro de uma conversa. Precisa
  de `ver_conversas`.

(`billing_consumo_mensal`, `billing_volume_mensal` → `ver_consumo`;
`painel_aprendizado_recente` → `editar_base`; `agendar_podcast` não é deste
produto.)

Esquecer uma delas é o modo de falha caro: o botão some da tela e a função
continua atendendo quem chamar direto pelo PostgREST.

## 10. O que o teste tem de provar

Além do isolamento entre tenants, que já é regra:

1. **agente sem a capacidade não escreve** — nem por Server Action, nem por
   PostgREST direto, nem pela `SECURITY DEFINER`. As três portas, porque são
   três entradas independentes;
2. **agente sem a capacidade AINDA LÊ** o que precisa ver (a divisão da
   seção 8 funcionou);
3. **tirar a capacidade vale na hora** — mesma conexão, sem token novo. É a
   prova de que a seção 7 entregou o que prometeu;
4. **sabotagem**: tirar a checagem de UMA policy, ou de UMA função
   `SECURITY DEFINER`, deixa vermelho. Se não deixar, o teste não está medindo;
5. a lista de portas sai do **catálogo** (`pg_policy`, `pg_proc`), não de uma
   lista escrita à mão — função nova entra sozinha, como em `teste:grants-n8n`.
