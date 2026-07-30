# Limpar memória do agente — webhook no n8n

O painel tem um botão que limpa a memória conversacional do agente (uma, várias
ou todas as conversas de um cliente). A memória mora no **Redis**, do lado do
n8n — este banco (Supabase) não a guarda. O painel só **sinaliza**: faz um POST
para um webhook do n8n, que confere um segredo e apaga as chaves de sessão no
Redis.

## Esquema de chaves no Redis

O agente grava a memória com chaves **escopadas por tenant** (é isso que garante
o isolamento entre clientes):

```
tenant_<tenant_id>_memory_<conversation_id>        (+ sub-chaves do LangChain)
tenant_<tenant_id>_conv_<conversation_id>_acumulo  (buffer de debounce)
```

Como o `tenant_id` está na própria chave, um cliente nunca alcança a memória de
outro, mesmo que dois tenants tenham o mesmo `conversation_id`.

## Contrato

```
POST  <N8N_LIMPEZA_URL>
Header: x-limpeza-secret: <N8N_LIMPEZA_SECRET>

# uma ou várias conversas
{ "tenant_id": "<uuid>", "escopo": "conversas", "conversation_ids": [123, 456] }

# todas as conversas do cliente
{ "tenant_id": "<uuid>", "escopo": "todas" }
```

Os `conversation_id` chegam **escopados por tenant** — o painel os valida contra
o banco (filtrando por `tenant_id` do JWT) antes de enviar. No `escopo: 'todas'`
o painel não enumera nada: o n8n varre `tenant_<uuid>_*`, o que pega inclusive
buffers de conversas que já saíram da tabela.

O painel considera sucesso qualquer 2xx. Responda 200 ao terminar.

## Workflow no n8n

Fluxo: **Webhook → Valida e Prepara (Code) → Busca Chaves (Redis KEYS) →
Expande Chaves (Code) → IF Tem Chave? → Apaga Chave (Redis DELETE) → Responde**.

O esqueleto que você montou está certo. Faltam três ajustes:

### 1. Header do segredo

O painel manda o segredo em **`x-limpeza-secret`** (era o que seu Code já lia —
mantenha). Troque o placeholder `SUBSTITUIR_PELO_LIMPEZA_SECRET` pelo mesmo
valor de `N8N_LIMPEZA_SECRET` do painel. Melhor ainda: leia de uma env do n8n
(`$env.LIMPEZA_SECRET`) para não deixar o segredo dentro do workflow.

### 2. Code "Valida e Prepara" — aceitar o array + escopo

Substitua o corpo do node por:

```js
// Confere o segredo e normaliza o payload vindo do painel.
const SEGREDO = $env.LIMPEZA_SECRET; // ou cole o mesmo valor do painel
const headers = $input.first().json.headers || {};
const body = $input.first().json.body || {};

if ((headers['x-limpeza-secret'] || '') !== SEGREDO) {
  throw new Error('Segredo inválido — requisição recusada');
}

const tenant_id = body.tenant_id;
if (!tenant_id) throw new Error('tenant_id ausente');

// 'todas' varre tudo do tenant; senão, memória + acúmulo de cada conversa.
if (body.escopo === 'todas') {
  return [{ json: { padrao: `tenant_${tenant_id}_*` } }];
}

const ids = Array.isArray(body.conversation_ids) ? body.conversation_ids : [];
if (ids.length === 0) throw new Error('escopo "conversas" exige conversation_ids');

const itens = [];
for (const id of ids) {
  itens.push({ json: { padrao: `tenant_${tenant_id}_memory_${id}*` } });
  itens.push({ json: { padrao: `tenant_${tenant_id}_conv_${id}_acumulo*` } });
}
return itens;
```

### 3. Nó "Busca Chaves (KEYS)" — nomear a saída

No nó Redis com operation `keys`, defina **Property Name = `chaves`**. Assim a
lista sai em `.chaves` e o Code "Expande Chaves" (que lê `item.json.chaves`)
encontra as chaves. Sem isso o array vem no padrão `keys` e o Expande acha vazio.

Confirme com uma execução real: dispare uma limpeza numa conversa que tem
memória e veja se a saída do KEYS traz `chaves` preenchido.

O resto (Expande Chaves, IF `Tem Chave?`, `Apaga Chave`, os dois `Respond`) pode
ficar como está.

> Notas:
> - `KEYS` varre todo o keyspace e, em Redis grande, bloqueia. Na escala atual
>   tudo bem; se crescer, troque por `SCAN`.
> - `escopo: 'todas'` apaga tudo sob `tenant_<uuid>_*`. Se algo além de memória
>   e do buffer de debounce viver sob esse prefixo, ele também some — confira
>   antes de confiar no "limpar todas".

## Variáveis no painel

No `.env.local` e como env no Coolify (runtime — não é NEXT_PUBLIC, não precisa
ser Build Variable):

```
N8N_LIMPEZA_URL=https://SEU_N8N/webhook/limpar-memoria
N8N_LIMPEZA_SECRET=<mesmo valor conferido no workflow>
```

Enquanto não estiverem definidas, o botão responde com um erro amigável
("Limpeza de memória não configurada") — não quebra o painel.
