# Diagnóstico de credencial do Chatwoot: distinguir os três 401

Problema recorrente: uma tool do agente falha e você precisa saber se o token do
cliente foi **revogado**, se ele é **válido mas sem permissão** para aquele
endpoint, ou se a requisição saiu **sem token nenhum**. O Chatwoot responde `401`
nos três casos — o código HTTP sozinho não distingue. O **corpo** distingue.

## As três respostas

Testado em 2026-08-11 contra `https://app.chatyou.chat`, conta 56 (Acqua),
endpoint `GET /api/v1/accounts/56/conversations`:

| Situação | Corpo da resposta |
|---|---|
| Token válido, sem permissão pro endpoint | `{"error":"Access to this endpoint is not authorized for bots"}` |
| Token inválido ou revogado | `{"error":"Invalid Access Token"}` |
| Sem header `api_access_token` | `{"errors":["Você precisa entrar ou se cadastrar antes de continuar."]}` |

A primeira é a informativa: para responder aquilo, o Chatwoot **autenticou** o
token, encontrou o bot e só então recusou por tipo de credencial. Ou seja, é
prova positiva de que a credencial está viva. Se o token tivesse sido revogado no
Chatwoot, a resposta seria a segunda.

## Por que isso importa aqui

Os tokens que o painel guarda em `tenant_credenciais` são de **Agent Bot**, não
de usuário. A API de plataforma do Chatwoot bloqueia bots na maior parte dos
endpoints de leitura — inclusive listar conversas. Então:

- **não dá** para auditar o tráfego de um cliente com o token que temos guardado;
- **dá** para confirmar que o token continua válido, com a distinção acima.

O que o token de bot faz é o que o agente precisa: postar mensagem em conversa e
alternar status (`POST .../conversations/{id}/messages`,
`POST .../conversations/{id}/toggle_status`).

Isso também explica por que `conectarChatwoot` em `admin/acoes.ts` salva o token
sem validação automática e devolve a mensagem pedindo teste manual: a chamada de
validação que faria sentido (ler dados da conta) é justamente a que o bot não
pode fazer.

## Como rodar

```js
// node -e "..."  — nao precisa de dependencia
(async () => {
  const base  = 'https://app.chatyou.chat';
  const conta = 56;
  const token = '<token do tenant, de tenant_credenciais>';
  const r = await fetch(`${base}/api/v1/accounts/${conta}/conversations`, {
    headers: { api_access_token: token },
  });
  console.log(r.status, await r.text());
})();
```

Compare o corpo com a tabela acima. Para o contraste, repita com um token
propositalmente inválido — é o que transforma "deu 401" em diagnóstico.

## Limite conhecido

Nada disso responde **se está chegando mensagem** na conta. Para isso é preciso
ou um token de usuário/admin do Chatwoot, ou a lista de execuções do workflow no
n8n. Pelo banco, o sinal utilizável é a quantidade de valores **distintos** de
`conversas.atualizado_em` por tenant: `api_n8n_conversa_sync` carimba esse campo
a cada mensagem processada, então um único valor distinto em N conversas
significa que nenhuma mensagem foi processada depois da carga inicial — o dado
entrou por importação, não pelo agente.

```sql
select t.nome,
       count(*) as conversas,
       count(distinct c.atualizado_em) as instantes_distintos,
       max(c.atualizado_em) as ultimo
from public.conversas c
join public.tenants t on t.id = c.tenant_id
group by 1 order by 4 desc nulls last;
```

Contadores de `pg_stat_statements` **não** servem para isso: não existe coluna de
última chamada, e `stats_since` é quando a entrada foi registrada pela primeira
vez, não a chamada mais recente.
