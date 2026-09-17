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
