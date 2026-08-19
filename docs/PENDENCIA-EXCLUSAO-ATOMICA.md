# Pendência — excluir cliente em uma transação (`SECURITY DEFINER`)

> **Registrada em 19/08/2026. NÃO construída.** Gatilho: depois da demonstração
> do `emporio`, ou antes se alguém precisar excluir um cliente com credencial
> real. A inversão de ordem já tirou o pior estado — ver abaixo.

## O que está errado hoje, depois do conserto

`excluirTenant` (`src/app/(app)/admin/acoes.ts`) faz **duas** escritas:

1. `delete` em `tenant_credenciais` (apaga o token do Chatwoot);
2. `update` em `tenants` (`deletado_em`, `ativo = false`, `chatwoot_account_id = null`).

Duas chamadas PostgREST **não formam transação**. Se a segunda falhar, sobra
estado meio-aplicado: o cliente continua vivo, sem credencial.

Isso é **melhor** do que era, e é escolha registrada, não descuido:

| ordem | resto possível | é o que o operador queria? | ele fica sabendo? |
|---|---|---|---|
| antes (tenant → credencial) | cliente excluído **com o token ainda no banco** | não, é o oposto | **não** |
| hoje (credencial → tenant) | cliente vivo **sem credencial** | subconjunto do pedido | **sim** |

O "ele fica sabendo" não é detalhe de UX: `admin/tenants/[id]/page.tsx` filtra
`deletado_em is null` e chama `notFound()`. Depois que o soft delete entra, a
Server Action pode devolver o erro que quiser — a página re-renderiza, dá 404 e a
mensagem morre lá. **Informar depois do soft delete é impossível nesta rota.** Foi
esse fato que decidiu a ordem; não foi preferência.

O preço da ordem de hoje, dito por inteiro: entre as duas escritas o cliente fica
vivo sem credencial, e o agente dele quebra no envio até o operador repetir.

## O que precisaria ser feito

Uma função `SECURITY DEFINER` que faça as duas escritas no mesmo `BEGIN/COMMIT`,
e a action passa a chamá-la por `.rpc()`. Aí não existe metade pendurada.

```sql
create or replace function public.excluir_tenant(p_tenant uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from tenant_credenciais where tenant_id = p_tenant;
  update tenants
     set deletado_em = now(), ativo = false, chatwoot_account_id = null
   where id = p_tenant and deletado_em is null;
end $$;
```

## A cerimônia que ela exige, e é por isso que não entrou agora

Ler `CLAUDE.md` inteiro na seção de migrações antes. O resumo do que se aplica:

- **rollback pareado escrito** — sem ele a migração não entra;
- se um dia essa função ganhar parâmetro novo com `DEFAULT`, o `create or
  replace` **não** substitui a de aridade antiga: as duas ficam vivas e a chamada
  com a contagem antiga vira **ambígua**. Drope pela lista completa de tipos
  (`drop function if exists public.excluir_tenant(uuid)`), nunca pelo nome;
- **`DROP FUNCTION` apaga todos os grants.** Esta função é chamada pelo painel
  (PostgREST → `service_role`), então o grant mínimo é `service_role`. Ela **não**
  é `api_n8n_*` e o `n8n_agent` não deve receber execute — quem exclui cliente é a
  agência, não o agente. Confirme com **diff do ACL antes/depois**, não contra a
  lista que você espera: foi assim que `n8n_agent` passou despercebido nas
  migrações 40 e 41;
- o nome do arquivo tem que bater com a versão registrada em
  `supabase_migrations.schema_migrations`.

## Cuidados que não são óbvios

- **`security definer` ignora RLS.** A função precisa ser chamada só depois de
  `exigirSuperAdmin()` no servidor — a checagem de papel continua na action, e a
  função não deve virar caminho alternativo para quem não é super_admin. Considere
  `revoke execute from public, anon, authenticated` (é o que a migração 43 fez com
  as irmãs) e grant só a `service_role`.
- **soft delete, não `DELETE`.** `tenants` é soft delete por convenção
  (`deletado_em`); a credencial é apagada de verdade porque é segredo, não dado do
  cliente.
- **o `.is('deletado_em', null)` do update é o que torna a exclusão idempotente.**
  Não o perca ao mover para SQL — sem ele, reexcluir sobrescreve a data original.

## Como saber se ainda vale

Se `excluirTenant` deixar de fazer duas escritas — por exemplo, se a credencial
passar a ser apagada por trigger em `tenants` —, esta pendência morre junto. Hoje
não é o caso.

Ver também `tests/mutacao-sem-erro.mjs`, que existe por causa do defeito que levou
a esta pendência: o `.delete()` da credencial rodava sem o erro olhado.
