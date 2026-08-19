# Decisão: o token do Chatwoot NÃO foi rotacionado após a correção 21a/21b

**Data:** 2026-08-11 · **Decisão de:** dono do produto · **Status:** fechada

Este documento existe para que ninguém, ao reler o histórico da correção,
conclua que a rotação foi **esquecida**. Ela foi **dispensada**, com motivo.

## O que a correção fez

As migrações `21a` e `21b` moveram `tenants.chatwoot_token` para
`tenant_credenciais`, tabela sem policy de tenant. A causa era que **RLS filtra
linha, não coluna**: o `tenant_admin` lia a própria linha de `tenants` via
PostgREST e alcançava, na mesma linha, uma credencial da agência.

O roteiro original previa rotacionar o token no Chatwoot ao final, sob a regra
usual de que credencial exposta é credencial queimada.

## Por que a rotação foi dispensada

A regra pressupõe exposição real. Aqui não houve, e isso é verificável no banco,
não apenas afirmado:

**1. A Acqua nunca teve um usuário `tenant_admin`.** Em 2026-08-11 existiam dois
usuários no painel desde sempre:

| Papel | Tenant | Criado |
|---|---|---|
| `super_admin` | — | 2026-07-24 |
| `tenant_admin` | Restaurante Teste | 2026-07-28 |

A leitura indevida exigia uma sessão de `tenant_admin` **daquele** tenant — a
policy de `tenants` entrega a linha do próprio tenant, e só ela. Sem usuário
`tenant_admin` vinculado à Acqua, a linha dela nunca esteve ao alcance por essa
via. A superfície de exposição da credencial de produção era vazia.

**2. O único `tenant_admin` que existiu pertence a um tenant de teste**
(Restaurante Teste), cujo token não é credencial de cliente real.

**3. O painel nunca foi publicado.** Não há projeto na conta Vercel e
`NEXT_PUBLIC_SITE_URL` aponta para `http://localhost:3000`. Não existiu
instância pública do painel pela qual alguém pudesse ter chegado.

**4. O dono do produto confirmou que ninguém além dele teve acesso ao painel.**

Conclusão registrada por ele: *"era vulnerabilidade, não incidente"*. A falha era
real e foi corrigida; o que não houve foi exposição a rotacionar.

## O que continua valendo

- A correção **não** foi revertida nem enfraquecida. A coluna caiu, o token vive
  em `tenant_credenciais`, e a única policy da tabela exige
  `auth_is_super_admin()` — sem policy para `tenant_admin`, o RLS é fail-closed.
- **Se aparecer um `tenant_admin` para a Acqua, ou se o painel for publicado, a
  premissa desta decisão muda.** A dispensa vale para a janela em que a falha
  existiu, não para o futuro.
- Se em algum momento houver suspeita de acesso, o token deve ser rotacionado:
  gerar novo Agent Bot token no Chatwoot e gravar em
  `tenant_credenciais.chatwoot_token` do tenant, sem tocar em `tenants`.

## Como reverificar a premissa

```sql
-- quem tem acesso ao painel, e por qual tenant
select u.papel, t.nome as tenant, u.criado_em
from public.usuarios_painel u
left join public.tenants t on t.id = u.tenant_id
order by u.criado_em;
```

Se aparecer um `tenant_admin` de um tenant com credencial real, releia esta
decisão antes de assumir que ela continua válida.

Ver também `docs/DIAGNOSTICO-CREDENCIAL-CHATWOOT.md` para confirmar se um token
segue válido no Chatwoot sem precisar de acesso administrativo.

## Apagar a credencial no painel não revoga nada no Chatwoot

O botão **"Liberar e apagar token"** em `/admin/tenants/[id]` apaga
`tenant_credenciais.chatwoot_token` do tenant — o **nosso** lado. O token
continua valendo no Chatwoot até alguém regenerá-lo por lá.

Isso importa em dois momentos opostos:

- **Trocar a conta de cliente:** use "Liberar a conta". O token guardado
  continua servindo, e reconectar o mesmo cliente não exige gerar outro.
- **Suspeita de acesso indevido:** apagar aqui **não** basta. É preciso
  regenerar o Agent Bot token no Chatwoot — é a rotação que a seção anterior
  dispensou por falta de exposição, e que volta a ser obrigatória se a premissa
  cair.

Há um terceiro caso, e é ele que justifica o botão existir: quando o Agent Bot
mudou ou o token foi regenerado no Chatwoot, o guardado virou lixo — e lixo aqui
**não dá erro ao reconectar**. O agente processa o turno e falha no envio,
calado. Apagar força o próximo cadastro a pedir um token novo.

Este texto morava na tela de desconectar. Saiu de lá porque a tela é só do
super_admin, que é o dono do produto — explicar consequência para ele é ruído.
Aqui continua consultável.
