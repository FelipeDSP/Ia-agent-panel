# Pendência — `teste:migracao-foto` depende de credencial que ele não arranja

**Estado:** achado em 2026-08-24 pela primeira execução de `npm run teste`.
**Não consertado.** 25/1.

**Gatilho:** junto com o conserto do `PENDENCIA-AUTOCASAMENTO-CRLF.md` — são os
dois únicos vermelhos da suíte, e este é o mais barato.

## O sintoma

```
FALHA devolve a credencial quando permite
```

`tests/migracao-foto-agente.mjs:160`:

```js
chk('devolve a credencial quando permite',
  Boolean(r.chatwoot_url) && Boolean(r.chatwoot_token));
```

`api_n8n_enviar_foto` devolve a credencial do Chatwoot junto com a permissão, e a
asserção exige que ela venha. Só que a credencial mora em `tenant_credenciais`
desde a migração 21, e o tenant que o teste usa **não tem uma**.

Medido hoje — dos 8 tenants vivos, **3 têm token**:

```
acqua-lavanderia   token=false        emporio            token=true
ceejaar            token=false        estudyou-sendbox   token=true
clinica-teste      token=false        fortalize          token=true
restaurante-teste  token=false        sandbox-de-testes  token=false
```

## É estado do mundo outra vez — a mesma família, décima ocorrência

O teste não cria a credencial: ele **conta com** ela existir. Conectar e
desconectar um cliente do Chatwoot é operação normal do painel (há até
`teste:desconectar-chatwoot` provando que funciona), então esta asserção fica
vermelha porque **alguém usou o produto**.

É literalmente o corolário do CLAUDE.md: *"se a asserção depende de algo que uma
pessoa pode mudar pela interface, ela não é sobre propriedade — ou o teste
arranja aquele algo, ou está contando com sorte."*

E é o mesmo arquivo que já produziu o **oitavo** caso da série, quando afirmava
que ninguém tinha `foto_produto` contratada. Aquele foi consertado arranjando a
contratação dentro da transação revertida; **esta linha ficou de fora da mesma
varredura**, porque o que se procurou foi "afirmação sobre contratação", não
"afirmação sobre estado".

## O conserto

O teste roda em transação abortada, então basta arranjar:

```sql
insert into public.tenant_credenciais (tenant_id, chatwoot_token)
values ($1, 'token-de-teste')
on conflict (tenant_id) do update set chatwoot_token = excluded.chatwoot_token;
```

...dentro da transação, antes da asserção — e conferir que entrou, em vez de
acreditar. Com isso a asserção passa a medir a **propriedade** (a função devolve a
credencial quando permite) em vez do estado (este tenant por acaso tem uma).

E vale a contraprova simétrica, que já existe uma linha acima e continua válida:
*"NÃO devolve credencial na recusa"* — essa é sobre propriedade e não depende de
nada do mundo.
